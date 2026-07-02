import type { McpRuntimeConfig } from "./config.js";

export type EnterpriseHubApiMethod = "GET" | "POST";

export interface EnterpriseHubApiRequest {
  method: EnterpriseHubApiMethod;
  path: string;
  accessToken?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

export interface EnterpriseHubApiClient {
  requestJson<T = unknown>(request: EnterpriseHubApiRequest): Promise<T>;
}

export function createEnterpriseHubApiClient(
  config: Pick<McpRuntimeConfig, "apiUrl">,
  fetchImplementation: typeof fetch = fetch
): EnterpriseHubApiClient {
  return {
    async requestJson<T = unknown>(request: EnterpriseHubApiRequest): Promise<T> {
      const url = new URL(request.path, `${config.apiUrl}/`);

      for (const [key, value] of Object.entries(request.query ?? {})) {
        if (value !== null && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }

      const headers = new Headers();

      if (request.accessToken) {
        headers.set("authorization", `Bearer ${request.accessToken}`);
      }

      if (request.body !== undefined && !(request.body instanceof FormData)) {
        headers.set("content-type", "application/json");
      }

      const response = await fetchImplementation(url, {
        method: request.method,
        headers,
        body: requestBody(request.body)
      });
      const body = await readJsonResponse(response);

      if (!response.ok) {
        throw new EnterpriseHubApiError(response.status, body);
      }

      return body as T;
    }
  };
}

function requestBody(body: unknown): BodyInit | undefined {
  if (body === undefined) {
    return undefined;
  }

  if (body instanceof FormData) {
    return body;
  }

  return JSON.stringify(body);
}

export class EnterpriseHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`Enterprise Hub API request failed with HTTP ${status}.`);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
