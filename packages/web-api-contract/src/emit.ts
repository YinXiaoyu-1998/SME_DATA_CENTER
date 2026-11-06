import { toJsonSchema } from "./json-schema.js";
import {
  WEB_API_CONTRACT_VERSION,
  WEB_API_PREFIX,
  WEB_API_ROUTES,
  type WebApiRoute
} from "./registry.js";

export interface WebApiContractRoute {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly auth: string;
  readonly summary: string;
  readonly request: {
    readonly params?: Record<string, unknown>;
    readonly query?: Record<string, unknown>;
    readonly body?: Record<string, unknown>;
  };
  readonly response: Record<string, unknown>;
  readonly errors: readonly string[];
}

export interface WebApiContractDocument {
  readonly contractVersion: number;
  readonly prefix: string;
  readonly routes: readonly WebApiContractRoute[];
}

function describeRoute(route: WebApiRoute): WebApiContractRoute {
  const request: WebApiContractRoute["request"] = {
    ...(route.params ? { params: toJsonSchema(route.params) } : {}),
    ...(route.query ? { query: toJsonSchema(route.query) } : {}),
    ...(route.body ? { body: toJsonSchema(route.body) } : {})
  };

  return {
    id: route.id,
    method: route.method,
    path: route.path,
    auth: route.auth,
    summary: route.summary,
    request,
    response: toJsonSchema(route.response),
    errors: [...route.errors].sort()
  };
}

/** 构建契约文档。输出不含时间戳或提交号，因此同一份路由表必然生成同一份字节。 */
export function buildWebApiContract(
  routes: readonly WebApiRoute[] = WEB_API_ROUTES
): WebApiContractDocument {
  return {
    contractVersion: WEB_API_CONTRACT_VERSION,
    prefix: WEB_API_PREFIX,
    routes: [...routes]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(describeRoute)
  };
}

export function serializeWebApiContract(document: WebApiContractDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
