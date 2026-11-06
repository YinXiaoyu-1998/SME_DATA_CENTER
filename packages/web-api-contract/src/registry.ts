import { WEB_API_ERROR_CODES } from "./errors.js";
import {
  WEB_API_PREFIX,
  requiresSession,
  requiresWriteCheck,
  type WebApiAuth,
  type WebApiRoute
} from "./route-types.js";
import { ledgerWebApiRoutes } from "./routes/ledger.js";
import { permissionsWebApiRoutes } from "./routes/permissions.js";
import { sessionWebApiRoutes } from "./routes/session.js";
import { workflowsWebApiRoutes } from "./routes/workflows.js";

export {
  WEB_API_CONTRACT_VERSION,
  WEB_API_PREFIX,
  defineWebApiRoute,
  requiresSession,
  requiresWriteCheck
} from "./route-types.js";
export type { WebApiAuth, WebApiMethod, WebApiRoute } from "./route-types.js";

/**
 * 浏览器接口总表。各域在自己的 `routes/*.ts` 里登记，这里只做汇总，
 * 这样不同批次可以并行维护互不重叠的文件。
 */
export const WEB_API_ROUTES: readonly WebApiRoute[] = Object.freeze([
  ...sessionWebApiRoutes,
  ...permissionsWebApiRoutes,
  ...workflowsWebApiRoutes,
  ...ledgerWebApiRoutes
]);

/** 按 id 取路由；拼写错误立即失败，避免 handler 与契约脱节。 */
export function getWebApiRoute(id: string): WebApiRoute {
  const route = WEB_API_ROUTES.find((candidate) => candidate.id === id);
  if (!route) {
    throw new Error(`unknown web api route: ${id}`);
  }
  return route;
}

const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PATH_SEGMENT_PATTERN = /^(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*)$/;

export interface WebApiRouteValidationOptions {
  readonly routes: readonly WebApiRoute[];
}

/** 静态校验路由表；违反任何一条都抛错，防止契约悄悄变形。 */
export function validateWebApiRoutes({ routes }: WebApiRouteValidationOptions): void {
  const ids = new Set<string>();
  const keyed = new Set<string>();

  for (const route of routes) {
    if (!ID_PATTERN.test(route.id)) {
      throw new Error(`route id must be dot-separated lowerCamelCase: ${route.id}`);
    }
    if (ids.has(route.id)) {
      throw new Error(`duplicate route id: ${route.id}`);
    }
    ids.add(route.id);

    if (!route.path.startsWith(`${WEB_API_PREFIX}/`)) {
      throw new Error(`route ${route.id} must live under ${WEB_API_PREFIX}`);
    }
    if (route.path.endsWith("/")) {
      throw new Error(`route ${route.id} must not end with a slash`);
    }
    const segments = route.path.slice(1).split("/");
    const seenParams = new Set<string>();
    for (const segment of segments) {
      if (!PATH_SEGMENT_PATTERN.test(segment)) {
        throw new Error(`route ${route.id} has an invalid path segment: ${segment}`);
      }
      if (segment.startsWith(":")) {
        if (seenParams.has(segment)) {
          throw new Error(`route ${route.id} repeats path parameter ${segment}`);
        }
        seenParams.add(segment);
      }
    }

    const key = `${route.method} ${route.path}`;
    if (keyed.has(key)) {
      throw new Error(`duplicate route method+path: ${key}`);
    }
    keyed.add(key);

    if (requiresWriteCheck(route.auth) && route.method === "GET") {
      throw new Error(`route ${route.id} cannot require a write check on GET`);
    }
    if (!requiresWriteCheck(route.auth) && route.method !== "GET") {
      throw new Error(`route ${route.id} uses ${route.method} without a write auth kind`);
    }

    if (requiresSession(route.auth) && !route.errors.includes("BROWSER_SIGN_IN_REQUIRED")) {
      throw new Error(
        `route ${route.id} requires a session but does not declare BROWSER_SIGN_IN_REQUIRED`
      );
    }
    if (requiresWriteCheck(route.auth) && !route.errors.includes("BROWSER_SECURITY_CHECK_FAILED")) {
      throw new Error(
        `route ${route.id} requires a write check but does not declare BROWSER_SECURITY_CHECK_FAILED`
      );
    }
    if ((route.params ?? route.query ?? route.body) !== undefined) {
      if (!route.errors.includes("WEB_API_INVALID_REQUEST")) {
        throw new Error(
          `route ${route.id} accepts input but does not declare WEB_API_INVALID_REQUEST`
        );
      }
    }

    const codes = new Set<string>();
    for (const code of route.errors) {
      if (!ERROR_CODE_PATTERN.test(code)) {
        throw new Error(`route ${route.id} declares an invalid error code: ${code}`);
      }
      if (codes.has(code)) {
        throw new Error(`route ${route.id} repeats error code ${code}`);
      }
      codes.add(code);
    }

    if (route.summary.trim().length === 0) {
      throw new Error(`route ${route.id} needs a summary`);
    }
  }

  const shared = new Set<string>(WEB_API_ERROR_CODES);
  for (const route of routes) {
    for (const code of route.errors) {
      if (code.startsWith("WEB_API_") && !shared.has(code)) {
        throw new Error(`route ${route.id} declares unknown shared code ${code}`);
      }
    }
  }
}

/** 供 emit 与测试复查：路由表当前只允许出现这些 auth 值。 */
export const WEB_API_AUTH_KINDS: readonly WebApiAuth[] = [
  "anonymous",
  "anonymous-write",
  "session",
  "session-write"
];
