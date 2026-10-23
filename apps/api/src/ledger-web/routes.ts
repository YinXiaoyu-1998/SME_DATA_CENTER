import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  LEDGER_SCOPE_MAX_STORES,
  LEDGER_SCOPE_MAX_DATES,
  LEDGER_PAGE_SIZE,
  parseLedgerScope
} from "@smedc/ledger-archive";
import {
  LEDGER_BUNDLE_LIMITS,
  type LedgerPdfDelivery,
  type LedgerCoverageScope,
  type LedgerPdfSelectionItem,
  LedgerDeliveryError
} from "@smedc/ledger-archive/delivery";
import { renderLedgerLogin, renderLedgerPage } from "../../../admin-web/src/ledger-pages.js";
import type { AuthCore } from "../auth/auth-core.js";
import {
  BROWSER_SESSION_COOKIE,
  BROWSER_SESSION_SECONDS,
  type BrowserSessions
} from "../auth/browser-session.js";
import {
  cookieValue,
  csrfTokenForSecret,
  hostOnlyCookie,
  matchesCsrfToken
} from "../auth/http-contract.js";
import { authPageHeaders } from "../auth/pages.js";
import { createRequestAuditContext } from "../request-audit-context.js";

const base = "/ledger-pdfs";
const loginCookie = "__Host-smedc_ledger_login";
const limits = {
  files: LEDGER_BUNDLE_LIMITS.files,
  bytes: LEDGER_BUNDLE_LIMITS.bytes,
  stores: LEDGER_SCOPE_MAX_STORES,
  dates: LEDGER_SCOPE_MAX_DATES,
  pageSize: LEDGER_PAGE_SIZE,
  deadlineMs: LEDGER_BUNDLE_LIMITS.deadlineMs,
  retentionMs: LEDGER_BUNDLE_LIMITS.retentionMs
};
function page(reply: FastifyReply, render: (nonce: string) => string) {
  const nonce = randomBytes(18).toString("base64url");
  const headers = authPageHeaders(nonce);
  headers["referrer-policy"] = "same-origin";
  headers["content-security-policy"] += "; connect-src 'self'; frame-src 'self' blob:";
  return reply
    .headers({ ...headers })
    .type("text/html; charset=utf-8")
    .send(render(nonce));
}
function failure(reply: FastifyReply, status: number, code: string) {
  return reply
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .code(status)
    .send({ error: { code } });
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
  return value as Record<string, unknown>;
}
function cursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new LedgerDeliveryError("LEDGER_CURSOR_INVALID");
  return value;
}
function scope(value: unknown): LedgerCoverageScope {
  const input = object(value, ["storeNames", "dates", "startDate", "endDate"]);
  const parsed = parseLedgerScope({
    ...input,
    storeNames: input["storeNames"] === undefined ? ["__date_validation__"] : input["storeNames"]
  });
  if (input["storeNames"] !== undefined) return parsed;
  return "dates" in parsed
    ? { dates: parsed.dates! }
    : { startDate: parsed.startDate, endDate: parsed.endDate };
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
export function registerLedgerWebRoutes(
  app: FastifyInstance,
  options: {
    auth: Pick<AuthCore, "verifyLogin">;
    browserSessions: BrowserSessions;
    publicOrigin: string;
    ledgerPdfDeliveryEnabled: boolean;
    delivery: () => LedgerPdfDelivery;
  }
): void {
  const secretFor = (request: FastifyRequest) =>
    cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
  const principalFor = (request: FastifyRequest) =>
    options.browserSessions.authenticate(secretFor(request));
  const validWrite = (request: FastifyRequest, secret: string, csrf: unknown) =>
    request.headers.origin === options.publicOrigin &&
    typeof csrf === "string" &&
    matchesCsrfToken(secret, csrf);
  const audit = (request: FastifyRequest) => {
    const context = createRequestAuditContext(request, "browser_auth");
    return { requestId: context.requestId, sourceIp: context.sourceIp, launcherVersion: null };
  };
  const loginPage = (reply: FastifyReply, error = false) => {
    const secret = randomBytes(24).toString("base64url");
    reply.header("set-cookie", hostOnlyCookie(loginCookie, secret, 600));
    return page(reply, (nonce) =>
      renderLedgerLogin({ nonce, csrfToken: csrfTokenForSecret(secret), error })
    );
  };
  app.get(base, async (request, reply) => {
    if (!(await principalFor(request)))
      return reply.header("cache-control", "no-store").code(303).redirect(`${base}/login`);
    return page(reply, (nonce) => renderLedgerPage({ nonce, limits }));
  });
  app.get(`${base}/login`, async (request, reply) => {
    if (await principalFor(request))
      return reply.header("cache-control", "no-store").code(303).redirect(base);
    return loginPage(reply);
  });
  app.post<{ Body: Record<string, unknown> }>(`${base}/login`, async (request, reply) => {
    const secret = cookieValue(request.headers.cookie, loginCookie);
    const body = request.body;
    if (!secret || !body || !validWrite(request, secret, body["csrfToken"]))
      return loginPage(reply.code(403), true);
    const email = body["email"],
      password = body["password"];
    if (
      typeof email !== "string" ||
      email.length > 320 ||
      typeof password !== "string" ||
      !password.length ||
      Array.from(password.normalize("NFC")).length > 128
    )
      return loginPage(reply.code(400), true);
    const identity = await options.auth.verifyLogin(email, password, audit(request));
    if (!identity.ok) return loginPage(reply.code(401), true);
    const issued = await options.browserSessions.issue(
      identity,
      secretFor(request),
      audit(request)
    );
    if (!issued || !(await options.browserSessions.authenticate(issued)))
      return loginPage(reply.code(401), true);
    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", [
        hostOnlyCookie(loginCookie, "deleted", 0),
        hostOnlyCookie(BROWSER_SESSION_COOKIE, issued, BROWSER_SESSION_SECONDS)
      ])
      .code(303)
      .redirect(base);
  });
  app.get(`${base}/api/context`, async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    const principal = await principalFor(request);
    if (!principal) return failure(reply, 401, "BROWSER_SIGN_IN_REQUIRED");
    return {
      identity: {
        employeeId: principal.id,
        orgId: principal.orgId,
        displayName: principal.displayName,
        organizationName: principal.organizationName
      },
      csrfToken: csrfTokenForSecret(secretFor(request)!),
      limits
    };
  });
  app.post(`${base}/logout`, async (request, reply) => {
    const secret = secretFor(request);
    if (!(await principalFor(request))) return failure(reply, 401, "BROWSER_SIGN_IN_REQUIRED");
    if (!secret || !validWrite(request, secret, request.headers["x-csrf-token"]))
      return failure(reply, 403, "BROWSER_SECURITY_CHECK_FAILED");
    await options.browserSessions.logout(secret);
    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", hostOnlyCookie(BROWSER_SESSION_COOKIE, "deleted", 0))
      .send({ signedOut: true });
  });
  const route = (
    method: "GET" | "POST",
    url: string,
    operation: (
      request: FastifyRequest,
      reply: FastifyReply,
      principal: NonNullable<Awaited<ReturnType<typeof principalFor>>>
    ) => Promise<unknown>
  ) => {
    app.route({
      method,
      url: `${base}/api/${url}`,
      // A full supported selection can exceed Fastify's 1 MiB default. Bound the
      // encoded 512-character names (including JSON escaping) without lifting other routes.
      ...(url === "downloads" || url === "coverage"
        ? { bodyLimit: limits.files * (512 * 6 + 128) }
        : {}),
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
        const principal = await principalFor(request);
        if (!principal) return failure(reply, 401, "BROWSER_SIGN_IN_REQUIRED");
        if (
          method === "POST" &&
          !validWrite(request, secretFor(request)!, request.headers["x-csrf-token"])
        )
          return failure(reply, 403, "BROWSER_SECURITY_CHECK_FAILED");
        if (!options.ledgerPdfDeliveryEnabled) return failure(reply, 503, "LEDGER_PDF_NOT_ENABLED");
        try {
          return await operation(request, reply, principal);
        } catch (error) {
          return deliveryFailure(error, request, reply);
        }
      }
    });
  };
  route("POST", "coverage", async (request, _reply, employee) => {
    object(request.query, []);
    const body = object(request.body, ["scope", "selection", "cursor"]);
    const next = cursor(body["cursor"]);
    if ((body["scope"] === undefined) === (body["selection"] === undefined))
      throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
    return options.delivery().coverageForBrowser({
      employee,
      ...(body["scope"] !== undefined
        ? { scope: scope(body["scope"]) }
        : { selection: body["selection"] as LedgerPdfSelectionItem[] }),
      ...(next ? { cursor: next } : {})
    });
  });

  route("GET", "pdf", async (request, reply, employee) => {
    const query = object(request.query, ["storeName", "purchaseDate", "disposition"]);
    if (
      request.body !== undefined ||
      !["inline", "attachment"].includes(String(query["disposition"]))
    )
      throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
    const pdf = await options.delivery().openLedgerPdf({
      employee,
      selection: {
        storeName: query["storeName"],
        purchaseDate: query["purchaseDate"]
      } as LedgerPdfSelectionItem
    });
    const encoded = encodeURIComponent(pdf.fileName).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return reply
      .type("application/pdf")
      .header("content-length", pdf.byteSize)
      .header(
        "content-disposition",
        `${query["disposition"]}; filename="ledger.pdf"; filename*=UTF-8''${encoded}`
      )
      .header("x-frame-options", "SAMEORIGIN")
      .header("content-security-policy", "default-src 'none'; frame-ancestors 'self'; sandbox")
      .header("referrer-policy", "no-referrer")
      .send(pdf.stream);
  });

  route("POST", "downloads", async (request, reply, employee) => {
    object(request.query, []);
    const body = object(request.body, ["selection", "idempotencyKey"]);
    if (
      typeof body["idempotencyKey"] !== "string" ||
      !body["idempotencyKey"] ||
      body["idempotencyKey"].length > 255
    )
      throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
    const result = await options.delivery().requestSelectedLedgerBundle({
      employee,
      selection: body["selection"] as LedgerPdfSelectionItem[],
      idempotencyKey: body["idempotencyKey"]
    });
    return reply.code(202).send(result);
  });
  const requestId = (request: FastifyRequest) => {
    const id = object(request.params, ["requestId"])["requestId"];
    if (typeof id !== "string" || !id || id.length > 128)
      throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
    return id;
  };
  route("GET", "requests/:requestId", async (request, _reply, employee) => {
    const query = object(request.query, ["cursor"]);
    if (request.body !== undefined) throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
    const next = cursor(query["cursor"]);
    return options
      .delivery()
      .status({ employee, requestId: requestId(request), ...(next ? { cursor: next } : {}) });
  });
  route("POST", "requests/:requestId/download-url", async (request, _reply, employee) => {
    object(request.query, []);
    if (request.body !== undefined) throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
    return options.delivery().issueLedgerBundleUrl({ employee, requestId: requestId(request) });
  });
}
