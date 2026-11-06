import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { webApiErrorBody, type WebApiRoute } from "@smedc/web-api-contract";

/**
 * 响应不符合契约时抛错，而不是静默发出错误形状。
 * 全局错误处理器会把它记成一次服务故障，测试里则会直接失败。
 */
export class WebApiResponseContractError extends Error {
  constructor(
    readonly routeId: string,
    readonly issues: z.ZodIssue[]
  ) {
    super(`web api response violates the contract for ${routeId}`);
    this.name = "WebApiResponseContractError";
  }
}

export interface WebApiContext<Principal> {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly principal: Principal | null;
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  readonly body: unknown;
}

export interface WebApiBinding<Principal> {
  /** 解析浏览器会话；匿名路由不会调用它。 */
  authenticate(request: FastifyRequest): Promise<Principal | null>;
  /** 同源 Origin 与 CSRF 校验；只对 `*-write` 路由调用。 */
  verifyWrite(request: FastifyRequest, principal: Principal | null): boolean;
  handler(context: WebApiContext<Principal>): Promise<unknown>;
}

const requiresSession = (auth: WebApiRoute["auth"]): boolean =>
  auth === "session" || auth === "session-write";
const isWrite = (auth: WebApiRoute["auth"]): boolean =>
  auth === "anonymous-write" || auth === "session-write";

type InputParse = { ok: true; value: unknown } | { ok: false; field: string };

function parseInput(schema: z.ZodType | undefined, value: unknown, field: string): InputParse {
  if (!schema) {
    return { ok: true, value };
  }
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    return { ok: false, field };
  }
  return { ok: true, value: parsed.data };
}

/**
 * 注册一条浏览器接口。所有检查都在这里完成，handler 只关心业务：
 * 会话 → 写校验 → 输入校验 → 业务 → 响应契约校验。
 */
export function registerWebApiRoute<Principal>(
  app: FastifyInstance,
  route: WebApiRoute,
  binding: WebApiBinding<Principal>
): void {
  app.route({
    method: route.method,
    url: route.path,
    handler: async (request, reply) => {
      reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");

      const principal = requiresSession(route.auth) ? await binding.authenticate(request) : null;
      if (requiresSession(route.auth) && !principal) {
        return reply
          .code(401)
          .send(webApiErrorBody("BROWSER_SIGN_IN_REQUIRED", "请先登录再重试。"));
      }

      if (isWrite(route.auth) && !binding.verifyWrite(request, principal)) {
        return reply
          .code(403)
          .send(webApiErrorBody("BROWSER_SECURITY_CHECK_FAILED", "安全校验未通过，请刷新后重试。"));
      }

      const params = parseInput(route.params, request.params, "params");
      if (!params.ok) return invalidRequest(reply, params.field);
      const query = parseInput(route.query, request.query, "query");
      if (!query.ok) return invalidRequest(reply, query.field);
      const body = parseInput(route.body, request.body, "body");
      if (!body.ok) return invalidRequest(reply, body.field);

      const result = await binding.handler({
        request,
        reply,
        principal,
        params: (params.value ?? {}) as Record<string, unknown>,
        query: (query.value ?? {}) as Record<string, unknown>,
        body: body.value
      });

      const parsed = route.response.safeParse(result);
      if (!parsed.success) {
        throw new WebApiResponseContractError(route.id, parsed.error.issues);
      }
      return reply.send(parsed.data);
    }
  });
}

function invalidRequest(reply: FastifyReply, field: string): FastifyReply {
  return reply.code(400).send(webApiErrorBody("WEB_API_INVALID_REQUEST", `请求参数无效：${field}`));
}
