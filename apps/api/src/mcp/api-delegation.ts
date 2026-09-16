import {
  apiErrorToolResult,
  errorToolResult,
  jsonToolResult,
  type McpJsonToolResult
} from "@smedc/mcp-contract";
import type { RequestAuditContext } from "../request-audit-context.js";

export type ApiDelegationMethod = "GET" | "POST";

export interface ApiDelegationInjectRequest {
  method: ApiDelegationMethod;
  url: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  payload?: unknown;
  remoteAddress?: string;
}

export interface ApiDelegationInjectResponse {
  statusCode: number;
  payload: string;
  headers?: Record<string, string | string[] | undefined>;
  json?: <T = unknown>() => T;
}

export interface ApiDelegationContext {
  bearerToken: string;
  audit: RequestAuditContext;
  delegationProof: string;
  abortSignal?: AbortSignal;
  inject(request: ApiDelegationInjectRequest): Promise<ApiDelegationInjectResponse>;
}

export interface DelegateJsonApiRequest {
  method: ApiDelegationMethod;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  mapSuccess?: (value: unknown) => unknown;
}

export async function delegateJsonApiRequest(
  context: ApiDelegationContext,
  request: DelegateJsonApiRequest
): Promise<McpJsonToolResult> {
  if (context.abortSignal?.aborted) {
    return requestCancelledApiError(context.audit.requestId);
  }

  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${context.bearerToken}`,
      "x-request-id": context.audit.requestId,
      "x-smedc-internal-delegation": context.delegationProof,
      ...(context.audit.launcherVersion
        ? { "x-smedc-launcher-version": context.audit.launcherVersion }
        : {})
    };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await context.inject({
      method: request.method,
      url: request.path,
      query: normalizedQuery(request.query),
      headers,
      payload: request.body,
      remoteAddress: context.audit.sourceIp
    });
    const parsed = parseJsonResponse(response);

    if (!parsed.ok) {
      return genericApiError(context.audit.requestId);
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return jsonToolResult(request.mapSuccess ? request.mapSuccess(parsed.value) : parsed.value);
    }

    return apiErrorToolResult(parsed.value);
  } catch {
    return genericApiError(context.audit.requestId);
  }
}

function normalizedQuery(
  query: Record<string, string | undefined> | undefined
): Record<string, string> | undefined {
  if (!query) {
    return undefined;
  }

  const entries = Object.entries(query).filter((entry): entry is [string, string] => {
    return entry[1] !== undefined;
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseJsonResponse(
  response: ApiDelegationInjectResponse
): { ok: true; value: unknown } | { ok: false } {
  try {
    if (response.json) {
      return { ok: true, value: response.json() };
    }

    return { ok: true, value: JSON.parse(response.payload) };
  } catch {
    return { ok: false };
  }
}

function genericApiError(requestId: string): McpJsonToolResult {
  return errorToolResult(
    "SMEDC_API_ERROR",
    "SMEDC API request failed.",
    undefined,
    {
      retryable: true,
      requestId
    }
  );
}

function requestCancelledApiError(requestId: string): McpJsonToolResult {
  return errorToolResult(
    "MCP_REQUEST_CANCELLED",
    "MCP request was cancelled before API delegation started.",
    undefined,
    {
      retryable: false,
      requestId
    }
  );
}
