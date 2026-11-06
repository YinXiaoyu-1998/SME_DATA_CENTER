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

/**
 * 把一份 schema 内部的所有 `$defs` 名与对应 `$ref` 加前缀。
 *
 * zod 的 `reused: "ref"` 对每次转换都从 `__schema0` 开始命名，同一条路由的
 * params / query / body / response 放在一起就会重名。前端生成器按路由合并
 * `$defs`，所以必须在产出契约时先把命名空间隔开。
 */
function namespaceDefs(schema: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const defs = schema["$defs"];
  if (!defs || typeof defs !== "object") {
    return schema;
  }

  const rename = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(rename);
    }
    if (node === null || typeof node !== "object") {
      return node;
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
        result[key] = `#/$defs/${prefix}${value.slice("#/$defs/".length)}`;
      } else {
        result[key] = rename(value);
      }
    }
    return result;
  };

  const renamedDefs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defs as Record<string, unknown>)) {
    renamedDefs[`${prefix}${key}`] = rename(value);
  }

  return { ...(rename(schema) as Record<string, unknown>), ["$defs"]: renamedDefs };
}

function describeRoute(route: WebApiRoute): WebApiContractRoute {
  const request: WebApiContractRoute["request"] = {
    ...(route.params ? { params: namespaceDefs(toJsonSchema(route.params), "p_") } : {}),
    ...(route.query ? { query: namespaceDefs(toJsonSchema(route.query), "q_") } : {}),
    ...(route.body ? { body: namespaceDefs(toJsonSchema(route.body), "b_") } : {})
  };

  return {
    id: route.id,
    method: route.method,
    path: route.path,
    auth: route.auth,
    summary: route.summary,
    request,
    response: namespaceDefs(toJsonSchema(route.response), "r_"),
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
