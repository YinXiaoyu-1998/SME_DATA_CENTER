import type { z } from "zod";

/** 浏览器接口的唯一前缀。前端与 Nginx 都依赖它，改动等于破坏性变更。 */
export const WEB_API_PREFIX = "/api/web/v1" as const;

/** 契约文档版本。结构变化（不是路由变化）时递增。 */
export const WEB_API_CONTRACT_VERSION = 1 as const;

export type WebApiMethod = "GET" | "POST" | "DELETE";

/**
 * - `anonymous`：无需会话，只读。
 * - `anonymous-write`：无需会话，但要求同源 Origin（登录、兑换一次性凭据）。
 * - `session`：要求有效浏览器会话。
 * - `session-write`：会话之外还要求同源 Origin 与 CSRF 令牌。
 */
export type WebApiAuth = "anonymous" | "anonymous-write" | "session" | "session-write";

export interface WebApiRoute {
  /** 稳定标识，形如 `permissions.categories.list`。前端用它定位生成代码。 */
  readonly id: string;
  readonly method: WebApiMethod;
  /** 以 {@link WEB_API_PREFIX} 开头的绝对路径，路径参数写作 `:name`。 */
  readonly path: string;
  readonly auth: WebApiAuth;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  /** 成功响应（200）的完整形状；handler 的返回值必须能被它解析。 */
  readonly response: z.ZodType;
  /** 该路由可能返回的错误码；至少包含通用鉴权与校验码。 */
  readonly errors: readonly string[];
  /** 一句话说明，进入契约文档供前端生成注释。 */
  readonly summary: string;
}

export function defineWebApiRoute(route: WebApiRoute): WebApiRoute {
  return Object.freeze(route);
}

export const requiresSession = (auth: WebApiAuth): boolean =>
  auth === "session" || auth === "session-write";

export const requiresWriteCheck = (auth: WebApiAuth): boolean =>
  auth === "anonymous-write" || auth === "session-write";
