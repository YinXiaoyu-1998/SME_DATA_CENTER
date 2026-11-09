import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  LEDGER_SCOPE_MAX_DATES,
  LEDGER_SCOPE_MAX_STORES,
  LEDGER_PAGE_SIZE,
  parseLedgerScope
} from "@smedc/ledger-archive";
import {
  LEDGER_BUNDLE_LIMITS,
  LedgerDeliveryError,
  type LedgerCoverageScope,
  type LedgerPdfDelivery
} from "@smedc/ledger-archive/delivery";
import {
  getWebApiRoute,
  webApiErrorBody,
  type LedgerCoverageBody,
  type LedgerDownloadsBody,
  type LedgerPdfQuery,
  type LedgerRequestParams,
  type LedgerRequestQuery
} from "@smedc/web-api-contract";
import type { AuthCore } from "../auth/auth-core.js";
import {
  BROWSER_SESSION_COOKIE,
  type BrowserPrincipal,
  type BrowserSessions
} from "../auth/browser-session.js";
import { cookieValue, csrfTokenForSecret, matchesCsrfToken } from "../auth/http-contract.js";
import { registerWebApiRoute, type WebApiContext } from "../web-api/register.js";

/** 台账下载中心的静态限额；只用于展示与请求体上限，内容可见性仍由交付服务裁决。 */
const limits = {
  files: LEDGER_BUNDLE_LIMITS.files,
  bytes: LEDGER_BUNDLE_LIMITS.bytes,
  stores: LEDGER_SCOPE_MAX_STORES,
  dates: LEDGER_SCOPE_MAX_DATES,
  pageSize: LEDGER_PAGE_SIZE,
  deadlineMs: LEDGER_BUNDLE_LIMITS.deadlineMs,
  retentionMs: LEDGER_BUNDLE_LIMITS.retentionMs
};

/**
 * 满额支持的精确选择可能超过 Fastify 默认 1 MiB 请求体。
 * 契约注册器统一创建路由，因此用 onRoute 只放大台账写路由的上限，其他路由不变。
 */
const largeBodyLimit = limits.files * (512 * 6 + 128);
const coveredRoutes = new Set(["/api/web/v1/ledger/coverage", "/api/web/v1/ledger/downloads"]);

const errorMessages: Record<string, string> = {
  BROWSER_SIGN_IN_REQUIRED: "请先登录再重试。",
  BROWSER_SECURITY_CHECK_FAILED: "安全校验未通过，请刷新后重试。",
  WEB_API_INVALID_REQUEST: "请求参数无效。",
  LEDGER_SCOPE_INVALID: "台账筛选条件无效。",
  LEDGER_SCOPE_LIMIT_EXCEEDED: "台账筛选条件超出上限。",
  LEDGER_CURSOR_INVALID: "分页游标已失效，请重新筛选。",
  LEDGER_REQUEST_INVALID: "台账任务标识无效。",
  LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED: "所选台账文件超出打包容量上限。",
  LEDGER_PDF_UNAVAILABLE: "该台账内容不可用。",
  LEDGER_PDF_NOT_READY: "该台账 PDF 尚未生成完成。",
  LEDGER_PDF_BUNDLE_STALE: "台账内容已更新，请重新打包。",
  LEDGER_DOWNLOAD_REBUILD_REQUIRED: "台账内容已变化，请重新打包。",
  LEDGER_IDEMPOTENCY_CONFLICT: "同一幂等键对应了不同的台账选择。",
  AUTHORIZATION_VERSION_CONFLICT: "业务授权已变化，请重新筛选。",
  LEDGER_PDF_NOT_ENABLED: "台账下载暂未开启。",
  INTERNAL_ERROR: "台账服务暂时不可用，请稍后重试。"
};

function messageFor(code: string): string {
  return errorMessages[code] ?? "台账请求失败。";
}

function failure(reply: FastifyReply, status: number, code: string) {
  return reply
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .code(status)
    .send(webApiErrorBody(code, messageFor(code)));
}

function deliveryFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const code = error instanceof Error ? error.message : "";
  if (
    [
      "LEDGER_SCOPE_INVALID",
      "LEDGER_SCOPE_LIMIT_EXCEEDED",
      "LEDGER_CURSOR_INVALID",
      "LEDGER_REQUEST_INVALID",
      "LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED"
    ].includes(code)
  )
    return failure(reply, 400, code);
  if (code === "LEDGER_PDF_UNAVAILABLE") return failure(reply, 404, code);
  if (
    [
      "LEDGER_IDEMPOTENCY_CONFLICT",
      "LEDGER_PDF_NOT_READY",
      "LEDGER_PDF_BUNDLE_STALE",
      "LEDGER_DOWNLOAD_REBUILD_REQUIRED",
      "AUTHORIZATION_VERSION_CONFLICT"
    ].includes(code)
  )
    return failure(reply, 409, code);
  request.log.error({ err: error }, "Ledger browser request failed.");
  return failure(reply, 500, "INTERNAL_ERROR");
}

function cursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 4096) throw new LedgerDeliveryError("LEDGER_CURSOR_INVALID");
  return value;
}

/**
 * 沿用原实现的日期范围语义：只给日期时先借用占位门店名做校验，再还原成无门店的范围。
 */
function scope(value: LedgerCoverageScope): LedgerCoverageScope {
  const input = value as Record<string, unknown>;
  const parsed = parseLedgerScope({
    ...input,
    storeNames: input["storeNames"] === undefined ? ["__date_validation__"] : input["storeNames"]
  });
  if (input["storeNames"] !== undefined) return parsed;
  return "dates" in parsed
    ? { dates: parsed.dates! }
    : { startDate: parsed.startDate, endDate: parsed.endDate };
}

export interface LedgerWebRoutesOptions {
  /** 登录已迁到 `/api/web/v1/session`；保留该字段以兼容既有调用方，本模块不再使用。 */
  auth: Pick<AuthCore, "verifyLogin">;
  browserSessions: BrowserSessions;
  webOrigin: string;
  ledgerPdfDeliveryEnabled: boolean;
  delivery: () => LedgerPdfDelivery;
}

export function registerLedgerWebRoutes(
  app: FastifyInstance,
  options: LedgerWebRoutesOptions
): void {
  const secretFor = (request: FastifyRequest) =>
    cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
  const authenticate = async (request: FastifyRequest) =>
    options.browserSessions.authenticate(secretFor(request));
  const verifyWrite = (request: FastifyRequest, principal: BrowserPrincipal | null): boolean => {
    if (request.headers.origin !== options.webOrigin) return false;
    const secret = secretFor(request);
    const csrf = request.headers["x-csrf-token"];
    return (
      principal !== null &&
      secret !== null &&
      typeof csrf === "string" &&
      matchesCsrfToken(secret, csrf)
    );
  };

  app.addHook("onRoute", (route) => {
    if (route.method === "POST" && coveredRoutes.has(route.url)) route.bodyLimit = largeBodyLimit;
  });

  /** 数据面共用注册：会话 → 写校验 → 输入校验由注册器完成，本处只做业务与错误映射。 */
  const dataRoute = (
    id: string,
    handler: (
      context: WebApiContext<BrowserPrincipal>,
      principal: BrowserPrincipal
    ) => Promise<unknown>
  ): void => {
    registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute(id), {
      authenticate,
      verifyWrite,
      handler: async (context) => {
        const principal = context.principal;
        if (!principal) throw new Error(id + " reached without an authenticated session");
        if (!options.ledgerPdfDeliveryEnabled)
          return failure(context.reply, 503, "LEDGER_PDF_NOT_ENABLED");
        try {
          return await handler(context, principal);
        } catch (error) {
          return deliveryFailure(error, context.request, context.reply);
        }
      }
    });
  };

  registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute("ledger.context"), {
    authenticate,
    verifyWrite,
    handler: async ({ request, principal }) => {
      const secret = secretFor(request);
      if (!principal || secret === null)
        throw new Error("ledger.context reached without an authenticated session");
      return {
        identity: {
          employeeId: principal.id,
          orgId: principal.orgId,
          displayName: principal.displayName,
          organizationName: principal.organizationName
        },
        csrfToken: csrfTokenForSecret(secret),
        limits
      };
    }
  });

  dataRoute("ledger.coverage", async ({ body }, employee) => {
    const input = body as LedgerCoverageBody;
    if ((input.scope === undefined) === (input.selection === undefined))
      throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
    const next = cursor(input.cursor);
    return options.delivery().coverageForBrowser({
      employee,
      ...(input.scope !== undefined
        ? { scope: scope(input.scope) }
        : { selection: input.selection! }),
      ...(next ? { cursor: next } : {})
    });
  });

  registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute("ledger.pdf"), {
    authenticate,
    verifyWrite,
    handler: async ({ request, reply, principal, query }) => {
      if (!principal) throw new Error("ledger.pdf reached without an authenticated session");
      if (!options.ledgerPdfDeliveryEnabled) return failure(reply, 503, "LEDGER_PDF_NOT_ENABLED");
      try {
        if (request.body !== undefined) throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
        const input = query as LedgerPdfQuery;
        const pdf = await options.delivery().openLedgerPdf({
          employee: principal,
          selection: { storeName: input.storeName, purchaseDate: input.purchaseDate }
        });
        const encoded = encodeURIComponent(pdf.fileName).replace(
          /[!'()*]/g,
          (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase()
        );
        reply
          .type("application/pdf")
          .header("content-length", pdf.byteSize)
          .header(
            "content-disposition",
            `${input.disposition}; filename="ledger.pdf"; filename*=UTF-8''${encoded}`
          )
          .header("x-frame-options", "SAMEORIGIN")
          .header("content-security-policy", "default-src 'none'; frame-ancestors 'self'; sandbox")
          .header("referrer-policy", "no-referrer");
        // 二进制流直接交给注册器发送；响应契约只断言它是可读流。
        return pdf.stream;
      } catch (error) {
        return deliveryFailure(error, request, reply);
      }
    }
  });

  dataRoute("ledger.downloads", async ({ body, reply }, employee) => {
    const input = body as LedgerDownloadsBody;
    const result = await options.delivery().requestSelectedLedgerBundle({
      employee,
      selection: input.selection,
      idempotencyKey: input.idempotencyKey
    });
    // 202 只设置状态码；响应体由注册器按契约校验并发送。
    reply.code(202);
    return result;
  });

  dataRoute("ledger.requests.read", async ({ request, query, params }, employee) => {
    if (request.body !== undefined) throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
    const next = cursor((query as LedgerRequestQuery).cursor);
    return options.delivery().status({
      employee,
      requestId: (params as LedgerRequestParams).requestId,
      downloadOnly: true,
      ...(next ? { cursor: next } : {})
    });
  });

  dataRoute("ledger.requests.downloadUrl", async ({ body, params }, employee) => {
    if (body !== undefined) throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
    return options.delivery().issueLedgerBundleUrl({
      employee,
      requestId: (params as LedgerRequestParams).requestId
    });
  });
}
