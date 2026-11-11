import { z } from "zod";

/** 浏览器接口的共享错误码。新增码必须同时进入这里的联合类型。 */
export const WEB_API_ERROR_CODES = [
  "WEB_API_INVALID_REQUEST",
  "BROWSER_SIGN_IN_REQUIRED",
  "BROWSER_ACCESS_DENIED",
  "BROWSER_SECURITY_CHECK_FAILED",
  "BROWSER_INVALID_CREDENTIALS",
  "DIRECTORY_DUPLICATE_NAME",
  "INTERNAL_ERROR"
] as const;

export type WebApiErrorCode = (typeof WEB_API_ERROR_CODES)[number];

/** 所有浏览器接口的统一错误信封；成功响应永不携带 error 字段。 */
export const webApiErrorBodySchema = z
  .object({ error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict() })
  .strict();

export type WebApiErrorBody = z.output<typeof webApiErrorBodySchema>;

export function webApiErrorBody(code: string, message: string): WebApiErrorBody {
  return { error: { code, message } };
}
