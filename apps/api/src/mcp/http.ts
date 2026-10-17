import { randomUUID } from "node:crypto";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { InjectOptions, InjectPayload, Response as InjectResponse } from "light-my-request";
import { PHASE3_RUNTIME_LIMIT_DEFAULTS, type AuthenticatedEmployee } from "@smedc/domain";
import {
  assertValidMcpPublicOrigin,
  createMcpConcurrencyLimiter,
  isAllowedMcpHost,
  isLoopbackAddress,
  isSafeMcpRequestId,
  mcpBodyLimitBytes
} from "./guards.js";
import { createSmedcHttpMcpServer } from "./server.js";
import {
  createSmedcMcpToolHandlers,
  type SmedcMcpToolHandlers,
  type McpRequestContext
} from "./tool-handlers.js";
import { createRequestAuditContext } from "../request-audit-context.js";
import type { UploadAuthorizationAuditRepository } from "../file-upload-authorization.js";

export interface McpHttpRouteOptions {
  uploadAuthorizationAudit: () => UploadAuthorizationAuditRepository;
  maxUploadBytes: number;
  delegationProof: string;
  mcpMaxConcurrentRequests?: number;
  publicOrigin?: string;
  authenticate: (
    request: FastifyRequest,
    reply: FastifyReply
  ) => Promise<AuthenticatedEmployee | null>;
  toolHandlers?: SmedcMcpToolHandlers;
}

interface McpErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

export function registerMcpHttpRoute(app: FastifyInstance, options: McpHttpRouteOptions): void {
  assertValidMcpPublicOrigin(options.publicOrigin);
  const limiter = createMcpConcurrencyLimiter(
    options.mcpMaxConcurrentRequests ?? PHASE3_RUNTIME_LIMIT_DEFAULTS.mcpMaxConcurrentRequests
  );
  const bodyLimit = mcpBodyLimitBytes(options.maxUploadBytes);
  const releasesByRequest = new WeakMap<FastifyRequest, () => void>();
  const employeesByRequest = new WeakMap<FastifyRequest, AuthenticatedEmployee>();
  const safeRequestIdsByRequest = new WeakMap<FastifyRequest, string>();

  function releaseRequest(request: FastifyRequest) {
    const release = releasesByRequest.get(request);

    if (!release) {
      return;
    }

    releasesByRequest.delete(request);
    release();
  }

  function safeRequestId(request: FastifyRequest): string {
    const existing = safeRequestIdsByRequest.get(request);

    if (existing) {
      return existing;
    }

    const requestId = isSafeMcpRequestId(request.id) ? request.id : `mcp_${randomUUID()}`;
    safeRequestIdsByRequest.set(request, requestId);

    return requestId;
  }

  void app.register(async (mcpApp) => {
    // Scores may contain any own dimension key, including __proto__ and constructor.
    // Keep JSON keys intact; strict tool schemas and domain parsers validate their shape.
    mcpApp.removeContentTypeParser("application/json");
    mcpApp.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      mcpApp.getDefaultJsonParser("ignore", "ignore")
    );
    mcpApp.setErrorHandler((error, request, reply) => {
      releaseRequest(request);
      const statusCode = fastifyErrorStatusCode(error);
      const errorCode = fastifyErrorCode(error);

      if (statusCode === 413 || errorCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return sendMcpHttpError(
          reply,
          request,
          413,
          "MCP_REQUEST_TOO_LARGE",
          "MCP body is too large."
        );
      }

      if (errorCode === "FST_ERR_CTP_INVALID_JSON_BODY") {
        return sendMcpHttpError(reply, request, 400, "MCP_MALFORMED_JSON", "Malformed JSON body.");
      }

      if (errorCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
        return sendMcpHttpError(
          reply,
          request,
          415,
          "MCP_UNSUPPORTED_MEDIA_TYPE",
          "MCP requests must use application/json."
        );
      }

      request.log.error({ err: error, requestId: request.id }, "mcp request failed");
      return sendMcpHttpError(reply, request, 500, "MCP_INTERNAL_ERROR", "MCP request failed.");
    });

    mcpApp.all(
      "/mcp",
      {
        bodyLimit,
        onRequest: async (request, reply) => {
          if (hasInvalidSuppliedRequestId(request)) {
            return sendMcpHttpError(
              reply,
              request,
              400,
              "MCP_INVALID_REQUEST_ID",
              "MCP x-request-id must be a bounded structured value."
            );
          }

          if (
            !isAllowedMcpHost(request.headers.host, options.publicOrigin) ||
            !isLoopbackAddress(peerAddress(request))
          ) {
            return sendMcpHttpError(
              reply,
              request,
              403,
              "MCP_LOOPBACK_REQUIRED",
              "MCP endpoint requires an approved host through the local reverse proxy."
            );
          }

          const release = limiter.tryAcquire();

          if (!release) {
            return sendMcpHttpError(
              reply,
              request,
              503,
              "MCP_BUSY",
              "MCP endpoint is busy. Retry later."
            );
          }

          releasesByRequest.set(request, release);
          const employee = await options.authenticate(request, reply);

          if (!employee) {
            releaseRequest(request);
            return;
          }

          employeesByRequest.set(request, employee);
        }
      },
      async (request, reply) => {
        try {
          if (request.method !== "POST") {
            reply.header("allow", "POST");
            return sendMcpHttpError(
              reply,
              request,
              405,
              "MCP_METHOD_NOT_ALLOWED",
              "MCP endpoint supports POST only."
            );
          }

          if (hasMcpSessionId(request)) {
            return sendMcpHttpError(
              reply,
              request,
              400,
              "MCP_SESSION_UNSUPPORTED",
              "MCP endpoint is stateless and does not accept MCP session IDs."
            );
          }

          if (!isJsonContentType(request.headers["content-type"])) {
            return sendMcpHttpError(
              reply,
              request,
              415,
              "MCP_UNSUPPORTED_MEDIA_TYPE",
              "MCP requests must use application/json."
            );
          }

          if (!acceptsMcpResponseTypes(request.headers.accept)) {
            return sendMcpHttpError(
              reply,
              request,
              406,
              "MCP_NOT_ACCEPTABLE",
              "MCP requests must accept application/json and text/event-stream."
            );
          }

          if (!hasSupportedMcpProtocolVersion(request)) {
            return sendMcpHttpError(
              reply,
              request,
              400,
              "MCP_UNSUPPORTED_PROTOCOL_VERSION",
              "Unsupported MCP protocol version."
            );
          }

          if (!isJsonRpcEnvelope(request.body)) {
            return sendMcpHttpError(
              reply,
              request,
              400,
              "MCP_MALFORMED_ENVELOPE",
              "Malformed JSON-RPC envelope."
            );
          }

          const employee = employeesByRequest.get(request);

          if (!employee) {
            return sendMcpHttpError(
              reply,
              request,
              500,
              "MCP_INTERNAL_ERROR",
              "MCP auth context lost."
            );
          }

          const context: McpRequestContext = {
            employee,
            audit: createRequestAuditContext(request, "mcp_launcher")
          };
          const bearerToken = bearerTokenFromAuthenticatedRequest(request);

          if (!bearerToken) {
            return sendMcpHttpError(
              reply,
              request,
              500,
              "MCP_INTERNAL_ERROR",
              "MCP auth token context lost."
            );
          }

          const handlers =
            options.toolHandlers ??
            createSmedcMcpToolHandlers({
              uploadAuthorizationAudit: options.uploadAuthorizationAudit,
              logAuditFailure: (context) =>
                request.log.error(context, "upload denial audit failed"),
              bearerToken,
              audit: context.audit,
              delegationProof: options.delegationProof,
              maxUploadBytes: options.maxUploadBytes,
              inject: async (delegateRequest) => {
                const delegatedResponse = await injectFastify(app, {
                  method: delegateRequest.method,
                  url: urlWithQuery(delegateRequest.url, delegateRequest.query),
                  headers: delegateRequest.headers,
                  payload: delegateRequest.payload as InjectPayload | undefined,
                  remoteAddress: delegateRequest.remoteAddress
                });

                return {
                  statusCode: delegatedResponse.statusCode,
                  payload: delegatedResponse.payload,
                  json: () => delegatedResponse.json()
                };
              },
              uploadDelegate: async (delegateRequest) => {
                const delegatedResponse = await injectFastify(app, {
                  method: delegateRequest.method,
                  url: delegateRequest.url,
                  headers: delegateRequest.headers,
                  payload: delegateRequest.payload,
                  remoteAddress: delegateRequest.remoteAddress
                });

                return {
                  statusCode: delegatedResponse.statusCode,
                  payload: delegatedResponse.payload,
                  json: () => delegatedResponse.json()
                };
              }
            });
          const mcpServer = createSmedcHttpMcpServer({
            context,
            handlers
          });
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
          });

          await mcpServer.connect(transport);
          reply.raw.setHeader("x-request-id", safeRequestId(request));
          reply.hijack();

          try {
            await transport.handleRequest(request.raw, reply.raw, request.body);
          } finally {
            await mcpServer.close();
          }
        } finally {
          employeesByRequest.delete(request);
          safeRequestIdsByRequest.delete(request);
          releaseRequest(request);
        }
      }
    );
  });
  function sendMcpHttpError(
    reply: FastifyReply,
    request: FastifyRequest,
    statusCode: number,
    code: string,
    message: string
  ) {
    const requestId = safeRequestId(request);
    const body: McpErrorBody = {
      error: {
        code,
        message,
        retryable: statusCode === 503,
        requestId
      }
    };

    return reply.header("x-request-id", requestId).code(statusCode).send(body);
  }
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.split(";").some((part) => part.trim().toLowerCase() === "application/json");
}

function bearerTokenFromAuthenticatedRequest(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();

  return token || null;
}

function urlWithQuery(url: string, query: Record<string, string> | undefined): string {
  if (!query || Object.keys(query).length === 0) {
    return url;
  }

  const search = new URLSearchParams(query);

  return `${url}?${search.toString()}`;
}

async function injectFastify(
  app: FastifyInstance,
  options: InjectOptions
): Promise<InjectResponse> {
  return app.inject(options) as unknown as Promise<InjectResponse>;
}

function acceptsMcpResponseTypes(acceptHeader: string | string[] | undefined): boolean {
  const values = Array.isArray(acceptHeader) ? acceptHeader : acceptHeader ? [acceptHeader] : [];
  const mediaTypes = values
    .flatMap((value) => value.split(","))
    .map((value) => value.split(";")[0]?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));

  return mediaTypes.includes("application/json") && mediaTypes.includes("text/event-stream");
}

function fastifyErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
}

function fastifyErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;

  return typeof statusCode === "number" ? statusCode : undefined;
}

function hasMcpSessionId(request: FastifyRequest): boolean {
  const header = request.headers["mcp-session-id"];

  if (Array.isArray(header)) {
    return header.some((value) => value.trim().length > 0);
  }

  return typeof header === "string" && header.trim().length > 0;
}

function hasInvalidSuppliedRequestId(request: FastifyRequest): boolean {
  const requestId = request.headers["x-request-id"];

  if (requestId === undefined) {
    return false;
  }

  if (Array.isArray(requestId)) {
    return requestId.length !== 1 || !isSafeMcpRequestId(requestId[0]);
  }

  return !isSafeMcpRequestId(requestId);
}

function hasSupportedMcpProtocolVersion(request: FastifyRequest): boolean {
  const protocolVersion = request.headers["mcp-protocol-version"];

  if (protocolVersion === undefined) {
    return true;
  }

  if (Array.isArray(protocolVersion)) {
    return (
      protocolVersion.length === 1 &&
      SUPPORTED_PROTOCOL_VERSIONS.includes(
        protocolVersion[0] as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number]
      )
    );
  }

  return SUPPORTED_PROTOCOL_VERSIONS.includes(
    protocolVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number]
  );
}

function peerAddress(request: FastifyRequest): string | undefined {
  return request.raw.socket.remoteAddress;
}

function isJsonRpcEnvelope(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isJsonRpcMessage);
  }

  return isJsonRpcMessage(value);
}

function isJsonRpcMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (message["jsonrpc"] !== "2.0") {
    return false;
  }

  if (typeof message["method"] === "string") {
    return !("id" in message) || isJsonRpcId(message["id"]);
  }

  return isJsonRpcId(message["id"]) && ("result" in message || "error" in message);
}

function isJsonRpcId(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || value === null;
}
