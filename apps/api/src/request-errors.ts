import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export class PublicRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 413,
    readonly code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE",
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "PublicRequestError";
  }
}

const PAYLOAD_TOO_LARGE_CODES = new Set([
  "FST_ERR_CTP_BODY_TOO_LARGE",
  "FST_REQ_FILE_TOO_LARGE",
  "FST_FILES_LIMIT",
  "FST_FIELDS_LIMIT",
  "FST_PARTS_LIMIT"
]);

function publicErrorBody(code: string, message: string, requestId: string) {
  return {
    error: {
      code,
      message,
      requestId
    }
  };
}

export function errorResponse(code: string, message: string) {
  return {
    error: {
      code,
      message
    }
  };
}

export function phase3ErrorResponse(
  request: FastifyRequest,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
) {
  return {
    error: {
      code,
      message,
      retryable: false,
      details,
      requestId: request.id
    }
  };
}

export function validationError(reply: FastifyReply, code: string, message: string) {
  return reply.code(400).send(errorResponse(code, message));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }

  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

export function isPayloadTooLargeError(error: unknown): boolean {
  const code = errorCode(error);
  return errorStatusCode(error) === 413 || (code ? PAYLOAD_TOO_LARGE_CODES.has(code) : false);
}

function isMalformedClientRequest(error: unknown): boolean {
  const code = errorCode(error);
  return errorStatusCode(error) === 400 && Boolean(code?.startsWith("FST_ERR_CTP_"));
}

export function registerApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PublicRequestError) {
      return reply
        .code(error.statusCode)
        .send(publicErrorBody(error.code, error.message, request.id));
    }

    if (isPayloadTooLargeError(error)) {
      return reply
        .code(413)
        .send(publicErrorBody("PAYLOAD_TOO_LARGE", "Request payload is too large.", request.id));
    }

    if (isMalformedClientRequest(error)) {
      return reply
        .code(400)
        .send(publicErrorBody("INVALID_REQUEST", "Request is invalid.", request.id));
    }

    request.log.error(
      {
        err: error,
        method: request.method,
        url: request.url,
        requestId: request.id
      },
      "request failed"
    );
    return reply
      .code(500)
      .send(publicErrorBody("INTERNAL_ERROR", "Internal server error.", request.id));
  });
}
