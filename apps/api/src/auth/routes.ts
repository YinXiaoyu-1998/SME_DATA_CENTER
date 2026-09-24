import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createRequestAuditContext, type RequestAuditContext } from "../request-audit-context.js";
import type { AuthCore, AuthRequestAudit } from "./auth-core.js";
import {
  OAUTH_CLIENT_ID,
  OAUTH_TRANSACTION_COOKIE,
  PASSWORD_SETUP_COOKIE,
  DEVICE_VERIFY_COOKIE,
  DEVICE_CODE_GRANT_TYPE,
  authorizationRequest,
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
  renderLoginPage,
  renderPasswordSetupBootstrapPage,
  renderPasswordSetupForm,
  renderSafeMessagePage
} from "./pages.js";
import { validatePassword } from "./primitives.js";

const MINIMUM_LAUNCHER_VERSION = "0.1.0";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const INVALID_LOGIN_MESSAGE = "The email or password is incorrect.";
const INVALID_SETUP_MESSAGE = "This password setup link is invalid or expired.";
const DEVICE_LINK_INVALID_MESSAGE =
  "This sign-in link is invalid or expired. Return to your agent and start sign-in again.";
const DEVICE_AUTHORIZATION_TTL_SECONDS = 10 * 60;

type OfficialAuthCore = Pick<
  AuthCore,
  | "authenticateAccessToken"
  | "completeAuthorizationTransaction"
  | "completeDeviceAuthorization"
  | "consumePasswordSetupSession"
  | "createSession"
  | "exchangePasswordSetupGrant"
  | "findPasswordSetupAccount"
  | "findDeviceAuthorizationByUserCode"
  | "issueDeviceAuthorization"
  | "issueAuthorizationTransaction"
  | "logout"
  | "pruneSecurityEvents"
  | "redeemAuthorizationCode"
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

  app.get("/oauth/authorize", async (request, reply) => {
    let authorization;
    try {
      authorization = authorizationRequest(request.query as Record<string, unknown>);
    } catch {
      return oauthError(reply, 400, "invalid_request", "The authorization request is invalid.");
    }

    const transaction = await options.auth.issueAuthorizationTransaction(authorization);
    reply.header(
      "set-cookie",
      hostOnlyCookie(OAUTH_TRANSACTION_COOKIE, transaction.secret, 10 * 60)
    );
    return sendHtml(
      reply,
      renderLoginPage({
        nonce: nonce(),
        csrfToken: csrfTokenForSecret(transaction.secret)
      }),
      { allowLoopbackFormRedirect: true }
    );
  });

  app.post<{ Body: FormBody }>("/oauth/authorize/login", async (request, reply) => {
    const transactionSecret = cookieValue(request.headers.cookie, OAUTH_TRANSACTION_COOKIE);
    const body = request.body;

    if (
      !transactionSecret ||
      !body ||
      typeof body.csrfToken !== "string" ||
      !matchesCsrfToken(transactionSecret, body.csrfToken)
    ) {
      return sendHtml(
        reply.code(400),
        renderSafeMessagePage({
          nonce: nonce(),
          title: "Sign-in expired",
          message: "Return to your agent and start sign-in again."
        })
      );
    }

    const audit = authAudit(createRequestAuditContext(request, "browser_auth"));
    const result = await options.auth.verifyLogin(body.email ?? "", body.password ?? "", audit);
    if (!result.ok) {
      return sendHtml(
        reply.code(401),
        renderLoginPage({
          nonce: nonce(),
          csrfToken: csrfTokenForSecret(transactionSecret),
          error: INVALID_LOGIN_MESSAGE
        }),
        { allowLoopbackFormRedirect: true }
      );
    }

    const completed = await options.auth.completeAuthorizationTransaction(
      transactionSecret,
      result,
      audit
    );
    if (!completed) {
      return sendHtml(
        reply.code(400).header("set-cookie", clearCookie(OAUTH_TRANSACTION_COOKIE)),
        renderSafeMessagePage({
          nonce: nonce(),
          title: "Sign-in expired",
          message: "Return to your agent and start sign-in again."
        })
      );
    }

    const callback = new URL(completed.redirectUri);
    callback.searchParams.set("code", completed.code);
    callback.searchParams.set("state", completed.state);
    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", clearCookie(OAUTH_TRANSACTION_COOKIE))
      .redirect(callback.toString(), 303);
  });

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
            title: "Sign-in link invalid",
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
            title: "Sign-in link expired",
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
          title: "Sign-in expired",
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
            title: "Sign-in expired",
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
          title: "Sign-in expired",
          message: DEVICE_LINK_INVALID_MESSAGE
        })
      );
    }
    return sendHtml(
      reply.header("set-cookie", clearCookie(DEVICE_VERIFY_COOKIE)),
      renderSafeMessagePage({
        nonce: nonce(),
        title: "Sign-in complete",
        message: "You can close this page and return to your agent."
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

    if (body.grant_type === "authorization_code") {
      if (!body.code || !body.redirect_uri || !body.code_verifier) {
        return oauthError(reply, 400, "invalid_request", "Required token fields are missing.");
      }
      const redemption = await options.auth.redeemAuthorizationCode(
        {
          secret: body.code,
          clientId: body.client_id,
          redirectUri: body.redirect_uri,
          verifier: body.code_verifier
        },
        audit
      );
      if (redemption.status !== "redeemed") {
        return oauthError(reply, 400, "invalid_grant", "The authorization grant is invalid.");
      }
      const session = await options.auth.createSession(redemption, audit);
      return tokenResponse(reply, session.accessToken, session.durableCredential);
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
          title: "Password setup unavailable",
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
          title: "Password setup unavailable",
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
          title: "Password setup unavailable",
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
      return passwordSetupFormError(
        reply,
        setupSecret,
        account,
        "The password confirmation is invalid."
      );
    }

    const passwordValidation = validatePassword(body.password);
    if (!passwordValidation.valid) {
      return passwordSetupFormError(reply, setupSecret, account, passwordValidation.reason);
    }

    const audit = authAudit(createRequestAuditContext(request, "browser_auth"));
    if (!(await options.auth.consumePasswordSetupSession(setupSecret, body.password, audit))) {
      return sendHtml(
        reply.code(400).header("set-cookie", clearCookie(PASSWORD_SETUP_COOKIE)),
        renderSafeMessagePage({
          nonce: nonce(),
          title: "Password setup unavailable",
          message: INVALID_SETUP_MESSAGE
        })
      );
    }

    return sendHtml(
      reply.header("set-cookie", clearCookie(PASSWORD_SETUP_COOKIE)),
      renderSafeMessagePage({
        nonce: nonce(),
        title: "Password saved",
        message: "You can close this page and return to your agent."
      })
    );
  });
}

function nonce(): string {
  return randomBytes(18).toString("base64url");
}

function sendHtml(
  reply: FastifyReply,
  html: string,
  options: { allowLoopbackFormRedirect?: boolean } = {}
) {
  const cspNonce = /<style nonce="([^"]+)"/.exec(html)?.[1];
  if (!cspNonce) {
    throw new Error("Authentication page is missing its CSP nonce.");
  }
  for (const [name, value] of Object.entries(authPageHeaders(cspNonce, options))) {
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
  error: string
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
