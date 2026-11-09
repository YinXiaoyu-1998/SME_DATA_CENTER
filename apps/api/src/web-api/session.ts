import type { FastifyInstance, FastifyRequest } from "fastify";
import { getWebApiRoute, webApiErrorBody, type WebSessionLoginBody } from "@smedc/web-api-contract";
import type { AuthCore } from "../auth/auth-core.js";
import {
  BROWSER_SESSION_COOKIE,
  BROWSER_SESSION_SECONDS,
  type BrowserPrincipal,
  type BrowserSessions
} from "../auth/browser-session.js";
import {
  cookieValue,
  csrfTokenForSecret,
  hostOnlyCookie,
  matchesCsrfToken
} from "../auth/http-contract.js";
import { createRequestAuditContext, type RequestAuditContext } from "../request-audit-context.js";
import { registerWebApiRoute } from "./register.js";

export interface WebSessionRoutesOptions {
  auth: Pick<AuthCore, "verifyLogin">;
  browserSessions: BrowserSessions;
  webOrigin: string;
}

function authAudit(context: RequestAuditContext) {
  return {
    requestId: context.requestId,
    sourceIp: context.sourceIp,
    launcherVersion: context.launcherVersion
  };
}

function secretOf(request: FastifyRequest): string | null {
  return cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
}

function sessionPayload(principal: BrowserPrincipal, secret: string) {
  return {
    identity: {
      employeeId: principal.id,
      displayName: principal.displayName,
      email: principal.email,
      orgId: principal.orgId,
      organizationName: principal.organizationName,
      role: principal.role,
      clearance: principal.clearance
    },
    csrfToken: csrfTokenForSecret(secret),
    canManageSettings: principal.role === "admin"
  };
}

/**
 * 网页会话三件套：登录、读取、注销。
 * 设备授权与首次设密码仍由服务端渲染流程签发同一个会话 Cookie，此处不重复实现。
 */
export function registerWebSessionRoutes(
  app: FastifyInstance,
  options: WebSessionRoutesOptions
): void {
  const authenticate = async (request: FastifyRequest) =>
    options.browserSessions.authenticate(secretOf(request));

  const verifyWrite = (request: FastifyRequest, principal: BrowserPrincipal | null): boolean => {
    if (request.headers.origin !== options.webOrigin) {
      return false;
    }
    if (principal === null) {
      // 登录：此时还没有会话，同源 Origin 就是防登录 CSRF 的全部依据。
      return true;
    }
    const secret = secretOf(request);
    const csrf = request.headers["x-csrf-token"];
    return secret !== null && typeof csrf === "string" && matchesCsrfToken(secret, csrf);
  };

  registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute("session.login"), {
    authenticate: async () => null,
    verifyWrite,
    handler: async ({ request, reply, body }) => {
      const input = body as WebSessionLoginBody;
      const audit = authAudit(createRequestAuditContext(request, "browser_auth"));
      const identity = await options.auth.verifyLogin(input.email, input.password, audit);
      if (!identity.ok) {
        return reply
          .code(401)
          .send(webApiErrorBody("BROWSER_INVALID_CREDENTIALS", "邮箱或密码错误。"));
      }
      const secret = await options.browserSessions.issue(identity, secretOf(request), audit);
      const principal = secret ? await options.browserSessions.authenticate(secret) : null;
      if (!secret || !principal) {
        return reply
          .code(500)
          .send(webApiErrorBody("INTERNAL_ERROR", "登录暂时不可用，请稍后重试。"));
      }
      reply.header(
        "set-cookie",
        hostOnlyCookie(BROWSER_SESSION_COOKIE, secret, BROWSER_SESSION_SECONDS)
      );
      return sessionPayload(principal, secret);
    }
  });

  registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute("session.read"), {
    authenticate,
    verifyWrite,
    handler: async ({ request, principal }) => {
      const secret = secretOf(request);
      if (!principal || !secret) {
        throw new Error("session.read reached without an authenticated session");
      }
      return sessionPayload(principal, secret);
    }
  });

  registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute("session.logout"), {
    authenticate,
    verifyWrite,
    handler: async ({ request, reply }) => {
      await options.browserSessions.logout(secretOf(request));
      reply.header("set-cookie", hostOnlyCookie(BROWSER_SESSION_COOKIE, "deleted", 0));
      return { signedOut: true as const };
    }
  });
}
