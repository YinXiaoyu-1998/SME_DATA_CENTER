import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createRequestAuditContext, type RequestAuditContext } from "../request-audit-context.js";
import type { AuthCore, AuthRequestAudit } from "./auth-core.js";
import {
  OAUTH_CLIENT_ID,
  PASSWORD_SETUP_COOKIE,
  DEVICE_VERIFY_COOKIE,
  DEVICE_CODE_GRANT_TYPE,
  cookieValue,
  csrfTokenForSecret,
  hostOnlyCookie,
  isValidDeviceUserCode,
  matchesCsrfToken,
  oauthMetadata
} from "./http-contract.js";
import {
  authPageHeaders,
  renderDeviceVerificationPage,
  renderPasswordSetupBootstrapPage,
  renderPasswordSetupForm,
  renderSafeMessagePage,
  type LocalizedText
} from "./pages.js";
import { validatePassword } from "./primitives.js";

const MINIMUM_LAUNCHER_VERSION = "0.6.0";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const INVALID_LOGIN_MESSAGE: LocalizedText = {
  zh: "邮箱或密码错误。",
  en: "The email or password is incorrect."
};
const INVALID_SETUP_MESSAGE: LocalizedText = {
  zh: "此密码设置链接无效或已过期。",
  en: "This password setup link is invalid or expired."
};
const DEVICE_LINK_INVALID_MESSAGE: LocalizedText = {
  zh: "此登录链接无效或已过期。请返回你的 Agent 并重新开始登录。",
  en: "This sign-in link is invalid or expired. Return to your agent and start sign-in again."
};
const DEVICE_AUTHORIZATION_TTL_SECONDS = 10 * 60;

type OfficialAuthCore = Pick<
  AuthCore,
  | "authenticateAccessToken"
  | "completeDeviceAuthorization"
  | "consumePasswordSetupSession"
  | "createSession"
  | "exchangePasswordSetupGrant"
  | "findPasswordSetupAccount"
  | "findDeviceAuthorizationByUserCode"
  | "issueDeviceAuthorization"
  | "logout"
  | "pruneSecurityEvents"
  | "redeemDeviceAuthorization"
  | "rotateDurableCredential"
  | "verifyLogin"
>;

export interface OfficialAuthRoutesOptions {
  auth: OfficialAuthCore;
  publicOrigin: string;
}

interface FormBody {
  [key: string]: string | undefined;
}

export function registerOfficialAuthRoutes(
  app: FastifyInstance,
  options: OfficialAuthRoutesOptions
): void {
  app.addContentTypeParser(FORM_CONTENT_TYPE, { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body.toString("utf8"))));
    } catch (error) {
      done(error as Error);
    }
  });

  app.get("/.well-known/oauth-authorization-server", async (_request, reply) =>
    reply.header("cache-control", "no-store").send(oauthMetadata(options.publicOrigin))
  );

  app.post<{ Body: FormBody }>("/oauth/device_authorization", async (request, reply) => {
    const context = createRequestAuditContext(request, "oauth_launcher");
    if (!isSupportedLauncherVersion(context.launcherVersion)) {
      return reply.code(426).send({
        error: "invalid_client",
        error_description: "LAUNCHER_UPGRADE_REQUIRED",
        code: "LAUNCHER_UPGRADE_REQUIRED",
        minimum_version: MINIMUM_LAUNCHER_VERSION
      });
    }
    const audit = authAudit(context);
    const body = request.body;
    const instanceName = typeof body?.instanceName === "string" ? body.instanceName.trim() : "";
    const instanceHostname =
      typeof body?.instanceHostname === "string" ? body.instanceHostname.trim() : "";
    if (
      !body ||
      body.client_id !== OAUTH_CLIENT_ID ||
      !instanceName ||
      !instanceHostname ||
      instanceName.length > 128 ||
      instanceHostname.length > 255
    ) {
      return oauthError(
        reply,
        400,
        "invalid_request",
        "The device authorization request is invalid."
      );
    }

    const issued = await options.auth.issueDeviceAuthorization({
      clientId: body.client_id,
      instanceName,
      instanceHostname,
      audit
    });
    const verificationUri = `${options.publicOrigin}/oauth/device/verify`;
    return reply.header("cache-control", "no-store").send({
      device_code: issued.deviceCode,
      user_code: issued.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(
        issued.userCode
      )}`,
      expires_in: DEVICE_AUTHORIZATION_TTL_SECONDS,
      interval: issued.intervalSeconds
    });
  });

  app.get<{ Querystring: { user_code?: string } }>(
    "/oauth/device/verify",
    async (request, reply) => {
      const userCode = request.query.user_code;
      if (!isValidDeviceUserCode(userCode)) {
        return sendHtml(
          reply.code(400),
          renderSafeMessagePage({
            nonce: nonce(),
            title: { zh: "登录链接无效", en: "Sign-in link invalid" },
            message: DEVICE_LINK_INVALID_MESSAGE
          })
        );
      }
      const pending = await options.auth.findDeviceAuthorizationByUserCode(userCode);
      if (!pending || pending.status !== "pending") {
        return sendHtml(
          reply.code(400),
          renderSafeMessagePage({
            nonce: nonce(),
            title: { zh: "登录链接已过期", en: "Sign-in link expired" },
            message: DEVICE_LINK_INVALID_MESSAGE
          })
        );
      }
      const secret = randomBytes(24).toString("base64url");
      return sendHtml(
        reply.header("set-cookie", hostOnlyCookie(DEVICE_VERIFY_COOKIE, secret, 10 * 60)),
        renderDeviceVerificationPage({
          nonce: nonce(),
          csrfToken: csrfTokenForSecret(secret),
          userCode,
          instanceName: pending.instanceName,
          instanceHostname: pending.instanceHostname
        })
      );
    }
  );

  app.post<{ Body: FormBody }>("/oauth/device/verify/login", async (request, reply) => {
    const verifySecret = cookieValue(request.headers.cookie, DEVICE_VERIFY_COOKIE);
    const body = request.body;
    if (
      !verifySecret ||
      !body ||
      typeof body.csrfToken !== "string" ||
      !matchesCsrfToken(verifySecret, body.csrfToken) ||
      !isValidDeviceUserCode(body.userCode)
    ) {
      return sendHtml(
        reply.code(400),
        renderSafeMessagePage({
          nonce: nonce(),
          title: { zh: "登录已过期", en: "Sign-in expired" },
          message: DEVICE_LINK_INVALID_MESSAGE
        })
      );
    }
    const audit = authAudit(createRequestAuditContext(request, "browser_auth"));
    const result = await options.auth.verifyLogin(body.email ?? "", body.password ?? "", audit);
    if (!result.ok) {
      const pending = await options.auth.findDeviceAuthorizationByUserCode(body.userCode);
      if (!pending || pending.status !== "pending") {
        return sendHtml(
          reply.code(400),
          renderSafeMessagePage({
            nonce: nonce(),
            title: { zh: "登录已过期", en: "Sign-in expired" },
            message: DEVICE_LINK_INVALID_MESSAGE
          })
        );
      }
      return sendHtml(
        reply.code(401),
        renderDeviceVerificationPage({
          nonce: nonce(),
          csrfToken: csrfTokenForSecret(verifySecret),
          userCode: body.userCode,
          instanceName: pending.instanceName,
          instanceHostname: pending.instanceHostname,
          error: INVALID_LOGIN_MESSAGE
        })
      );
    }

    const completed = await options.auth.completeDeviceAuthorization(
      body.userCode,
      {
        identityId: result.identityId,
        employeeId: result.employeeId,
        orgId: result.orgId
      },
      audit
    );
    if (!completed) {
      return sendHtml(
        reply.code(400).header("set-cookie", clearCookie(DEVICE_VERIFY_COOKIE)),
        renderSafeMessagePage({
          nonce: nonce(),
          title: { zh: "登录已过期", en: "Sign-in expired" },
          message: DEVICE_LINK_INVALID_MESSAGE
        })
      );
    }
    return sendHtml(
      reply.header("set-cookie", clearCookie(DEVICE_VERIFY_COOKIE)),
      renderSafeMessagePage({
        nonce: nonce(),
        title: { zh: "登录完成", en: "Sign-in complete" },
        message: {
          zh: "你可以关闭此页面并返回你的 Agent。",
          en: "You can close this page and return to your agent."
        }
      })
    );
  });

  app.post<{ Body: FormBody }>("/oauth/token", async (request, reply) => {
    const context = createRequestAuditContext(request, "oauth_launcher");
    if (!isSupportedLauncherVersion(context.launcherVersion)) {
      return reply.code(426).send({
        error: "invalid_client",
        error_description: "LAUNCHER_UPGRADE_REQUIRED",
        code: "LAUNCHER_UPGRADE_REQUIRED",
        minimum_version: MINIMUM_LAUNCHER_VERSION
      });
    }
    const audit = authAudit(context);

    const body = request.body;
    if (!body || body.client_id !== OAUTH_CLIENT_ID) {
      return oauthError(reply, 400, "invalid_client", "The OAuth client is invalid.");
    }

    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token) {
        return oauthError(reply, 400, "invalid_request", "The refresh token is missing.");
      }
      const rotation = await options.auth.rotateDurableCredential(body.refresh_token, audit);
      if (rotation.status !== "rotated") {
        return oauthError(reply, 400, "invalid_grant", "The refresh token is invalid.");
      }
      return tokenResponse(reply, rotation.accessToken, rotation.durableCredential);
    }

    if (body.grant_type === DEVICE_CODE_GRANT_TYPE) {
      if (!body.device_code) {
        return oauthError(reply, 400, "invalid_request", "Required token fields are missing.");
      }
      const redemption = await options.auth.redeemDeviceAuthorization(
        body.device_code,
        body.client_id,
        audit
      );
      if (redemption.status === "authorization_pending") {
        return oauthError(
          reply,
          400,
          "authorization_pending",
          "The authorization is still pending."
        );
      }
      if (redemption.status === "expired") {
        return oauthError(reply, 400, "expired_token", "The device code has expired.");
      }
      if (redemption.status !== "redeemed") {
        return oauthError(reply, 400, "invalid_grant", "The authorization grant is invalid.");
      }
      const session = await options.auth.createSession(redemption, audit);
      return tokenResponse(reply, session.accessToken, session.durableCredential);
    }

    return oauthError(reply, 400, "unsupported_grant_type", "The grant type is unsupported.");
  });

  app.post<{ Body: FormBody }>("/oauth/revoke", async (request, reply) => {
    const audit = authAudit(createRequestAuditContext(request, "oauth_launcher"));
    if (request.body?.token) {
      await options.auth.logout(request.body.token, audit);
    }
    return reply.header("cache-control", "no-store").code(200).send();
  });

  app.get("/auth/password/setup", async (_request, reply) =>
    sendHtml(reply, renderPasswordSetupBootstrapPage({ nonce: nonce() }))
  );

  app.post<{ Body: FormBody }>("/auth/password/setup/session", async (request, reply) => {
    const audit = authAudit(createRequestAuditContext(request, "browser_auth"));
    const setup = request.body?.token
      ? await options.auth.exchangePasswordSetupGrant(request.body.token, audit)
      : null;
    if (!setup) {
      return sendHtml(
        reply.code(400),
        renderSafeMessagePage({
          nonce: nonce(),
          title: { zh: "无法设置密码", en: "Password setup unavailable" },
          message: INVALID_SETUP_MESSAGE
        })
      );
    }
    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", hostOnlyCookie(PASSWORD_SETUP_COOKIE, setup.sessionSecret, 10 * 60))
      .redirect("/auth/password/setup/form", 303);
  });

  app.get("/auth/password/setup/form", async (request, reply) => {
    const setupSecret = cookieValue(request.headers.cookie, PASSWORD_SETUP_COOKIE);
    const account = setupSecret ? await options.auth.findPasswordSetupAccount(setupSecret) : null;
    if (!setupSecret || !account) {
      return sendHtml(
        reply.code(400),
        renderSafeMessagePage({
          nonce: nonce(),
          title: { zh: "无法设置密码", en: "Password setup unavailable" },
          message: INVALID_SETUP_MESSAGE
        })
      );
    }
    return sendHtml(
      reply,
      renderPasswordSetupForm({
        nonce: nonce(),
        csrfToken: csrfTokenForSecret(setupSecret),
        account
      })
    );
  });

  app.post<{ Body: FormBody }>("/auth/password/setup/complete", async (request, reply) => {
    const setupSecret = cookieValue(request.headers.cookie, PASSWORD_SETUP_COOKIE);
    const body = request.body;
    const account = setupSecret ? await options.auth.findPasswordSetupAccount(setupSecret) : null;
    if (!setupSecret || !account) {
      return sendHtml(
        reply.code(400),
        renderSafeMessagePage({
          nonce: nonce(),
          title: { zh: "无法设置密码", en: "Password setup unavailable" },
          message: INVALID_SETUP_MESSAGE
        })
      );
    }
    if (
      !body?.csrfToken ||
      !matchesCsrfToken(setupSecret, body.csrfToken) ||
      !body.password ||
      body.password !== body.passwordConfirmation
    ) {
      return passwordSetupFormError(reply, setupSecret, account, {
        zh: "两次输入的密码不一致。",
        en: "The password confirmation is invalid."
      });
    }

    const passwordValidation = validatePassword(body.password);
    if (!passwordValidation.valid) {
      return passwordSetupFormError(reply, setupSecret, account, {
        zh: "密码不符合要求，请使用 8–128 个字符且不要使用常见密码。",
        en: passwordValidation.reason
      });
    }

    const audit = authAudit(createRequestAuditContext(request, "browser_auth"));
    if (!(await options.auth.consumePasswordSetupSession(setupSecret, body.password, audit))) {
      return sendHtml(
        reply.code(400).header("set-cookie", clearCookie(PASSWORD_SETUP_COOKIE)),
        renderSafeMessagePage({
          nonce: nonce(),
          title: { zh: "无法设置密码", en: "Password setup unavailable" },
          message: INVALID_SETUP_MESSAGE
        })
      );
    }

    return sendHtml(
      reply.header("set-cookie", clearCookie(PASSWORD_SETUP_COOKIE)),
      renderSafeMessagePage({
        nonce: nonce(),
        title: { zh: "密码已保存", en: "Password saved" },
        message: {
          zh: "你可以关闭此页面并返回你的 Agent。",
          en: "You can close this page and return to your agent."
        }
      })
    );
  });
}

function nonce(): string {
  return randomBytes(18).toString("base64url");
}

function sendHtml(reply: FastifyReply, html: string) {
  const cspNonce = /<style nonce="([^"]+)"/.exec(html)?.[1];
  if (!cspNonce) {
    throw new Error("Authentication page is missing its CSP nonce.");
  }
  for (const [name, value] of Object.entries(authPageHeaders(cspNonce))) {
    reply.header(name, value);
  }
  return reply.type("text/html; charset=utf-8").send(html);
}

function clearCookie(name: string): string {
  return hostOnlyCookie(name, "deleted", 0);
}

function tokenResponse(reply: FastifyReply, accessToken: string, durableCredential: string) {
  return reply.header("cache-control", "no-store").send({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 10 * 60,
    refresh_token: durableCredential
  });
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply
    .header("cache-control", "no-store")
    .code(status)
    .send({ error, error_description: description });
}

function passwordSetupFormError(
  reply: FastifyReply,
  setupSecret: string,
  account: NonNullable<Awaited<ReturnType<OfficialAuthCore["findPasswordSetupAccount"]>>>,
  error: LocalizedText
) {
  return sendHtml(
    reply.code(400),
    renderPasswordSetupForm({
      nonce: nonce(),
      csrfToken: csrfTokenForSecret(setupSecret),
      account,
      error
    })
  );
}

function authAudit(context: RequestAuditContext): AuthRequestAudit {
  return {
    requestId: context.requestId,
    sourceIp: context.sourceIp,
    launcherVersion: context.launcherVersion
  };
}

function isSupportedLauncherVersion(value: string | null): boolean {
  const version = value;
  if (!version) {
    return false;
  }
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parsed) {
    return false;
  }
  const minimum = MINIMUM_LAUNCHER_VERSION.split(".").map(Number);
  const actual = parsed.slice(1).map(Number);
  return (
    actual.some((part, index) => part > minimum[index]!) ||
    actual.every((part, index) => part === minimum[index]!)
  );
}
