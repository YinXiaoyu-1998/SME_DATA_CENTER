import { defineWebApiRoute, type WebApiRoute } from "../route-types.js";
import {
  webSessionLoginBodySchema,
  webSessionLogoutResponseSchema,
  webSessionResponseSchema
} from "../schemas/session.js";

export const sessionWebApiRoutes: readonly WebApiRoute[] = Object.freeze([
  defineWebApiRoute({
    id: "session.login",
    method: "POST",
    path: "/api/web/v1/session",
    auth: "anonymous-write",
    body: webSessionLoginBodySchema,
    response: webSessionResponseSchema,
    errors: [
      "WEB_API_INVALID_REQUEST",
      "BROWSER_SECURITY_CHECK_FAILED",
      "BROWSER_INVALID_CREDENTIALS",
      "INTERNAL_ERROR"
    ],
    summary: "用邮箱与密码登录网页，签发会话 Cookie 并返回身份与 CSRF 令牌"
  }),
  defineWebApiRoute({
    id: "session.read",
    method: "GET",
    path: "/api/web/v1/session",
    auth: "session",
    response: webSessionResponseSchema,
    errors: ["BROWSER_SIGN_IN_REQUIRED", "INTERNAL_ERROR"],
    summary: "读取当前网页会话的身份、CSRF 令牌与管理设置权限"
  }),
  defineWebApiRoute({
    id: "session.logout",
    method: "DELETE",
    path: "/api/web/v1/session",
    auth: "session-write",
    response: webSessionLogoutResponseSchema,
    errors: ["BROWSER_SIGN_IN_REQUIRED", "BROWSER_SECURITY_CHECK_FAILED", "INTERNAL_ERROR"],
    summary: "注销当前网页会话并清除会话 Cookie"
  })
]);
