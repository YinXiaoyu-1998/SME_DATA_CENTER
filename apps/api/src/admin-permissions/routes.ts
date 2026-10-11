import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeEnterpriseIdentity } from "@smedc/domain";
import {
  renderPermissionsLogin,
  renderPermissionsMessage,
  renderPermissionsPage
} from "../../../admin-web/src/index.js";
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
import { authPageHeaders } from "../auth/pages.js";
import type { BusinessAuthorizationService } from "../business-authorization.js";
import {
  registerBusinessAuthorizationRoutes,
  respondBusinessAuthorizationError
} from "../routes/business-authorization.js";
import { createRequestAuditContext } from "../request-audit-context.js";
import type { PermissionsUiMetadata } from "./metadata.js";

const LOGIN_COOKIE = "__Host-smedc_login";
const routeBase = "/admin/permissions/:orgId";
export interface AdminPermissionsRoutesOptions {
  auth: Pick<AuthCore, "verifyLogin">;
  browserSessions: BrowserSessions;
  permissions: () => BusinessAuthorizationService;
  metadata: () => PermissionsUiMetadata;
  publicOrigin: string;
}
function browserAudit(request: FastifyRequest) {
  const context = createRequestAuditContext(request, "browser_auth");
  return { requestId: context.requestId, sourceIp: context.sourceIp, launcherVersion: null };
}
function page(reply: FastifyReply, render: (nonce: string) => string) {
  const nonce = randomBytes(18).toString("base64url");
  const headers = authPageHeaders(nonce);
  // Native same-origin form POSTs need a non-opaque Origin for the strict write check.
  headers["referrer-policy"] = "same-origin";
  headers["content-security-policy"] += "; connect-src 'self'";
  return reply
    .headers({ ...headers })
    .type("text/html; charset=utf-8")
    .send(render(nonce));
}
function denied(reply: FastifyReply) {
  return page(reply.code(403), (nonce) => renderPermissionsMessage({ nonce, kind: "denied" }));
}
function failure(reply: FastifyReply, status: number, code: string) {
  return reply
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .code(status)
    .send({ error: { code } });
}
export function registerAdminPermissionsRoutes(
  app: FastifyInstance,
  options: AdminPermissionsRoutesOptions
): void {
  const principals = new WeakMap<FastifyRequest, BrowserPrincipal>();
  const path = (orgId: string) => `/admin/permissions/${encodeURIComponent(orgId)}`;
  const validOrgId = (orgId: string) => /^[A-Za-z0-9_-]{1,64}$/.test(orgId);
  const matchesTenant = (principal: BrowserPrincipal, orgId: string) =>
    validOrgId(orgId) && principal.orgId === orgId && principal.role === "admin";
  const sharedSecret = (request: FastifyRequest) =>
    cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
  const principalFor = (request: FastifyRequest) =>
    options.browserSessions.authenticate(sharedSecret(request));
  const validWrite = (request: FastifyRequest, secret: string, csrf: unknown) =>
    request.headers.origin === options.publicOrigin &&
    typeof csrf === "string" &&
    matchesCsrfToken(secret, csrf);
  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    const principal = await principalFor(request);
    if (!principal) {
      failure(reply, 401, "BROWSER_SIGN_IN_REQUIRED");
      return false;
    }
    const orgId = (request.params as { orgId: string }).orgId;
    if (!matchesTenant(principal, orgId)) {
      failure(reply, 403, "BROWSER_ACCESS_DENIED");
      return false;
    }
    if (
      request.method !== "GET" &&
      !validWrite(request, sharedSecret(request)!, request.headers["x-csrf-token"])
    ) {
      failure(reply, 403, "BROWSER_SECURITY_CHECK_FAILED");
      return false;
    }
    principals.set(request, principal);
    return true;
  }
  app.get<{ Params: { orgId: string } }>(routeBase, async (request, reply) => {
    const principal = await principalFor(request);
    if (!principal)
      return reply
        .header("cache-control", "no-store")
        .code(303)
        .redirect(`${path(request.params.orgId)}/login`);
    if (!matchesTenant(principal, request.params.orgId)) return denied(reply);
    return page(reply, (nonce) =>
      renderPermissionsPage({
        nonce,
        orgId: principal.orgId,
        organizationName: principal.organizationName,
        employeeName: principal.displayName,
        csrfToken: csrfTokenForSecret(sharedSecret(request)!)
      })
    );
  });
  app.get<{ Params: { orgId: string } }>(`${routeBase}/login`, async (request, reply) => {
    const principal = await principalFor(request);
    if (principal)
      return matchesTenant(principal, request.params.orgId)
        ? reply.header("cache-control", "no-store").code(303).redirect(path(principal.orgId))
        : denied(reply);
    if (!validOrgId(request.params.orgId)) return denied(reply);
    const secret = randomBytes(24).toString("base64url");
    reply.header("set-cookie", hostOnlyCookie(LOGIN_COOKIE, secret, 600));
    return page(reply, (nonce) =>
      renderPermissionsLogin({
        nonce,
        orgId: request.params.orgId,
        csrfToken: csrfTokenForSecret(secret)
      })
    );
  });
  app.post<{ Params: { orgId: string }; Body: Record<string, unknown> }>(
    `${routeBase}/login`,
    async (request, reply) => {
      const secret = cookieValue(request.headers.cookie, LOGIN_COOKIE);
      const body = request.body;
      if (
        !secret ||
        !body ||
        !validOrgId(request.params.orgId) ||
        !validWrite(request, secret, body["csrfToken"])
      )
        return page(reply.code(403), (nonce) =>
          renderPermissionsMessage({ nonce, kind: "expired" })
        );
      const email = body["email"],
        password = body["password"];
      if (
        typeof email !== "string" ||
        email.length > 320 ||
        typeof password !== "string" ||
        !password.length ||
        Array.from(password.normalize("NFC")).length > 128
      )
        return page(reply.code(400), (nonce) =>
          renderPermissionsLogin({
            nonce,
            orgId: request.params.orgId,
            csrfToken: csrfTokenForSecret(secret),
            error: "invalid"
          })
        );
      const identity = await options.auth.verifyLogin(email, password, browserAudit(request));
      if (!identity.ok)
        return page(reply.code(401), (nonce) =>
          renderPermissionsLogin({
            nonce,
            orgId: request.params.orgId,
            csrfToken: csrfTokenForSecret(secret),
            error: "invalid"
          })
        );
      // The URL never selects another tenant or grants administrative authority.
      if (identity.orgId !== request.params.orgId) return denied(reply);
      const issued = await options.browserSessions.issue(
        identity,
        sharedSecret(request),
        browserAudit(request)
      );
      const principal = await options.browserSessions.authenticate(issued);
      if (!issued || !principal)
        return page(reply.code(401), (nonce) =>
          renderPermissionsMessage({ nonce, kind: "expired" })
        );
      if (!matchesTenant(principal, request.params.orgId)) {
        await options.browserSessions.logout(issued);
        return denied(reply);
      }
      return reply
        .header("cache-control", "no-store")
        .header("set-cookie", [
          hostOnlyCookie(LOGIN_COOKIE, "deleted", 0),
          hostOnlyCookie(BROWSER_SESSION_COOKIE, issued, BROWSER_SESSION_SECONDS)
        ])
        .code(303)
        .redirect(path(principal.orgId));
    }
  );
  app.post<{ Params: { orgId: string }; Body: Record<string, unknown> }>(
    `${routeBase}/logout`,
    async (request, reply) => {
      const secret = sharedSecret(request);
      const principal = await principalFor(request);
      if (!principal)
        return page(
          reply
            .code(401)
            .header("set-cookie", hostOnlyCookie(BROWSER_SESSION_COOKIE, "deleted", 0)),
          (nonce) => renderPermissionsMessage({ nonce, kind: "expired" })
        );
      if (
        !matchesTenant(principal, request.params.orgId) ||
        !secret ||
        !validWrite(request, secret, request.body?.["csrfToken"])
      )
        return denied(reply);
      await options.browserSessions.logout(secret);
      return reply
        .header("cache-control", "no-store")
        .header("set-cookie", hostOnlyCookie(BROWSER_SESSION_COOKIE, "deleted", 0))
        .code(303)
        .redirect(`${path(principal.orgId)}/login`);
    }
  );
  registerBusinessAuthorizationRoutes(app, {
    auth: { authenticate, employee: (request) => principals.get(request)! },
    permissions: options.permissions,
    adminBase: `${routeBase}/api`,
    selfPath: `${routeBase}/api/me`
  });
  async function actor(request: FastifyRequest, reply: FastifyReply) {
    if (!(await authenticate(request, reply))) return null;
    return options.permissions().current(principals.get(request)!, true);
  }
  app.get<{ Params: { orgId: string } }>(`${routeBase}/api/enterprises`, async (request, reply) => {
    const current = await actor(request, reply);
    if (!current) return;
    return {
      authorizationVersion: current.authorizationVersion,
      enterprises: await options.metadata().listEnterprises(current.orgId)
    };
  });
  app.post<{ Params: { orgId: string }; Body: { name?: unknown; expectedVersion?: unknown } }>(
    `${routeBase}/api/enterprises`,
    async (request, reply) => {
      try {
        const current = await actor(request, reply);
        if (!current) return;
        const { name, expectedVersion } = request.body ?? {};
        if (typeof name !== "string" || typeof expectedVersion !== "string")
          return failure(reply, 400, "INVALID_ENTERPRISE_NAME");
        return await options.permissions().repository.declareEnterpriseIdentity({
          orgId: current.orgId,
          actorId: current.employeeId,
          expectedVersion,
          name
        });
      } catch (error) {
        return respondBusinessAuthorizationError(error, reply);
      }
    }
  );
  app.post<{ Params: { orgId: string }; Body: { name?: unknown } }>(
    `${routeBase}/api/enterprises/preview`,
    async (request, reply) => {
      const current = await actor(request, reply);
      if (!current) return;
      const name = request.body?.name;
      if (typeof name !== "string" || !name.trim() || name.length > 255)
        return failure(reply, 400, "INVALID_ENTERPRISE_NAME");
      const normalized = normalizeEnterpriseIdentity(name);
      if (normalized.enterpriseKey.length > 128)
        return failure(reply, 400, "INVALID_ENTERPRISE_NAME");
      return normalized;
    }
  );
  app.get<{ Params: { orgId: string }; Querystring: { search?: unknown; cursor?: unknown } }>(
    `${routeBase}/api/documents`,
    async (request, reply) => {
      const current = await actor(request, reply);
      if (!current) return;
      const { search, cursor } = request.query;
      if (
        (search !== undefined && (typeof search !== "string" || search.length > 256)) ||
        (cursor !== undefined &&
          (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(cursor)))
      )
        return failure(reply, 400, "INVALID_DOCUMENT_QUERY");
      return {
        authorizationVersion: current.authorizationVersion,
        ...(await options.metadata().listDocuments(current.orgId, {
          ...(typeof search === "string" && search ? { search } : {}),
          ...(typeof cursor === "string" ? { cursor } : {})
        }))
      };
    }
  );
}
