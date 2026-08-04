import { randomBytes } from "node:crypto";
import {
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS,
  apiErrorToolResult,
  errorToolResult,
  jsonToolResult,
  validationErrorToolResult,
  type EnterpriseHubMcpToolName,
  type McpJsonToolResult
} from "@enterprise-hub/mcp-contract";
import type { EnterpriseHubMcpToolHandlers, McpRequestContext } from "./tool-handlers.js";
import type { RequestAuditContext } from "../request-audit-context.js";

interface InlineUploadFile {
  name: string;
  mediaType: string;
  encoding: "base64";
  contentBase64: string;
}

interface UploadStructuredDatasetInput {
  file: InlineUploadFile;
  dataset: "dishes" | "business";
  enterpriseName: string;
  startDate: string;
  endDate: string;
  idempotencyKey: string;
  labelKeys: string[];
}

interface UploadEvidenceDocumentInput {
  file: InlineUploadFile;
  title: string;
  sourceSystem?: string;
  labelKeys: string[];
}

export interface UploadApiDelegationContext {
  authorization: string;
  audit: RequestAuditContext;
  delegationProof: string;
  maxUploadBytes: number;
}

export interface UploadApiDelegationRequest {
  method: "POST";
  url: "/v1/structured/imports" | "/v1/documents/evidence";
  headers: Record<string, string>;
  payload: Buffer;
  remoteAddress: string;
}

export interface UploadApiDelegationResponse {
  statusCode: number;
  payload: string;
  json?: () => unknown;
}

export type UploadApiDelegate = (
  request: UploadApiDelegationRequest
) => Promise<UploadApiDelegationResponse>;

export interface UploadToolHandlerOptions {
  delegate: UploadApiDelegate;
  getDelegationContext: (context: McpRequestContext) => UploadApiDelegationContext;
}

type MultipartPart =
  | {
      type: "field";
      name: string;
      value: string;
    }
  | {
      type: "file";
      name: string;
      filename: string;
      contentType: string;
      body: Buffer;
    };

const uploadStructuredDatasetContract = requireToolContract("upload_structured_dataset");
const uploadEvidenceDocumentContract = requireToolContract("upload_evidence_document");

export function createUploadToolHandlers(
  options: UploadToolHandlerOptions
): EnterpriseHubMcpToolHandlers {
  return {
    upload_structured_dataset: async (input, context) =>
      uploadStructuredDataset(input, context, options),
    upload_evidence_document: async (input, context) =>
      uploadEvidenceDocument(input, context, options)
  };
}

async function uploadStructuredDataset(
  input: unknown,
  context: McpRequestContext,
  options: UploadToolHandlerOptions
): Promise<McpJsonToolResult> {
  if (context.abortSignal?.aborted) {
    return requestCancelledUploadError(context.audit.requestId);
  }

  const delegation = options.getDelegationContext(context);
  const encodedSize = preflightEncodedUploadSize(input, delegation);

  if (!encodedSize.ok) {
    return encodedSize.result;
  }

  const parsedInput = uploadStructuredDatasetContract.inputSchema.safeParse(input);

  if (!parsedInput.success) {
    return validationErrorToolResult(sanitizeValidationIssues(parsedInput.error.issues));
  }

  const uploadInput = parsedInput.data as unknown as UploadStructuredDatasetInput;
  const decodedFile = decodeUploadFile(uploadInput.file, delegation);

  if (!decodedFile.ok) {
    return decodedFile.result;
  }

  const multipart = createMultipartBody([
    {
      type: "file",
      name: "file",
      filename: uploadInput.file.name,
      contentType: uploadInput.file.mediaType,
      body: decodedFile.body
    },
    { type: "field", name: "dataset", value: uploadInput.dataset },
    { type: "field", name: "enterpriseName", value: uploadInput.enterpriseName },
    { type: "field", name: "startDate", value: uploadInput.startDate },
    { type: "field", name: "endDate", value: uploadInput.endDate },
    { type: "field", name: "idempotencyKey", value: uploadInput.idempotencyKey },
    ...uploadInput.labelKeys.map((labelKey) => ({
      type: "field" as const,
      name: "labelKeys[]",
      value: labelKey
    }))
  ]);

  return delegateMultipartRequest(options.delegate, delegation, {
    url: "/v1/structured/imports",
    multipart
  });
}

async function uploadEvidenceDocument(
  input: unknown,
  context: McpRequestContext,
  options: UploadToolHandlerOptions
): Promise<McpJsonToolResult> {
  if (context.abortSignal?.aborted) {
    return requestCancelledUploadError(context.audit.requestId);
  }

  const delegation = options.getDelegationContext(context);
  const encodedSize = preflightEncodedUploadSize(input, delegation);

  if (!encodedSize.ok) {
    return encodedSize.result;
  }

  const parsedInput = uploadEvidenceDocumentContract.inputSchema.safeParse(input);

  if (!parsedInput.success) {
    return validationErrorToolResult(sanitizeValidationIssues(parsedInput.error.issues));
  }

  const uploadInput = parsedInput.data as unknown as UploadEvidenceDocumentInput;
  const decodedFile = decodeUploadFile(uploadInput.file, delegation);

  if (!decodedFile.ok) {
    return decodedFile.result;
  }

  const parts: MultipartPart[] = [
    {
      type: "file",
      name: "file",
      filename: uploadInput.file.name,
      contentType: uploadInput.file.mediaType,
      body: decodedFile.body
    },
    { type: "field", name: "title", value: uploadInput.title },
    ...uploadInput.labelKeys.map((labelKey) => ({
      type: "field" as const,
      name: "labelKeys[]",
      value: labelKey
    }))
  ];

  if (uploadInput.sourceSystem) {
    parts.push({ type: "field", name: "sourceSystem", value: uploadInput.sourceSystem });
  }

  return delegateMultipartRequest(options.delegate, delegation, {
    url: "/v1/documents/evidence",
    multipart: createMultipartBody(parts)
  });
}

function decodeUploadFile(
  file: InlineUploadFile,
  context: UploadApiDelegationContext
):
  | {
      ok: true;
      body: Buffer;
    }
  | {
      ok: false;
      result: McpJsonToolResult;
    } {
  const body = Buffer.from(file.contentBase64, "base64");

  if (body.byteLength > context.maxUploadBytes) {
    return {
      ok: false,
      result: errorToolResult(
        "MCP_INLINE_FILE_TOO_LARGE",
        "Upload file is too large.",
        {
          maxUploadBytes: context.maxUploadBytes,
          actualBytes: body.byteLength
        },
        {
          requestId: context.audit.requestId,
          retryable: false
        }
      )
    };
  }

  return {
    ok: true,
    body
  };
}

function preflightEncodedUploadSize(
  input: unknown,
  context: UploadApiDelegationContext
):
  | {
      ok: true;
    }
  | {
      ok: false;
      result: McpJsonToolResult;
    } {
  const contentBase64 = contentBase64FromRawInput(input);

  if (contentBase64 === undefined) {
    return { ok: true };
  }

  const maxEncodedBytes = maxBase64EncodedLength(context.maxUploadBytes);

  if (contentBase64.length <= maxEncodedBytes) {
    return { ok: true };
  }

  return {
    ok: false,
    result: errorToolResult(
      "MCP_INLINE_FILE_TOO_LARGE",
      "Upload file is too large.",
      {
        maxUploadBytes: context.maxUploadBytes,
        maxEncodedBytes,
        actualEncodedBytes: contentBase64.length
      },
      {
        requestId: context.audit.requestId,
        retryable: false
      }
    )
  };
}

function contentBase64FromRawInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("file" in input)) {
    return undefined;
  }

  const file = (input as { file?: unknown }).file;

  if (typeof file !== "object" || file === null || !("contentBase64" in file)) {
    return undefined;
  }

  const contentBase64 = (file as { contentBase64?: unknown }).contentBase64;

  return typeof contentBase64 === "string" ? contentBase64 : undefined;
}

function maxBase64EncodedLength(maxUploadBytes: number): number {
  const maxQuantaBeforeOverflow = Math.floor(Number.MAX_SAFE_INTEGER / 4);
  const uploadQuanta = Math.ceil(maxUploadBytes / 3);

  if (uploadQuanta >= maxQuantaBeforeOverflow) {
    return Number.MAX_SAFE_INTEGER;
  }

  return uploadQuanta * 4;
}

function requestCancelledUploadError(requestId: string): McpJsonToolResult {
  return errorToolResult(
    "MCP_REQUEST_CANCELLED",
    "MCP request was cancelled before upload processing started.",
    undefined,
    {
      requestId,
      retryable: false
    }
  );
}

async function delegateMultipartRequest(
  delegate: UploadApiDelegate,
  context: UploadApiDelegationContext,
  input: {
    url: UploadApiDelegationRequest["url"];
    multipart: { body: Buffer; contentType: string };
  }
): Promise<McpJsonToolResult> {
  let response: UploadApiDelegationResponse;

  try {
    response = await delegate({
      method: "POST",
      url: input.url,
      headers: {
        authorization: context.authorization,
        accept: "application/json",
        "content-type": input.multipart.contentType,
        "x-request-id": context.audit.requestId,
        "x-enterprise-hub-internal-delegation": context.delegationProof,
        ...(context.audit.launcherVersion
          ? { "x-enterprise-hub-launcher-version": context.audit.launcherVersion }
          : {})
      },
      payload: input.multipart.body,
      remoteAddress: context.audit.sourceIp
    });
  } catch {
    return errorToolResult(
      "ENTERPRISE_HUB_API_ERROR",
      "Enterprise Hub API request failed.",
      undefined,
      {
        requestId: context.audit.requestId,
        retryable: true
      }
    );
  }

  const responseBody = parseResponseBody(response);

  if (response.statusCode >= 200 && response.statusCode < 300) {
    if (responseBody.ok) {
      return jsonToolResult(responseBody.body);
    }

    return errorToolResult(
      "ENTERPRISE_HUB_API_ERROR",
      "Enterprise Hub API returned invalid JSON.",
      undefined,
      {
        requestId: context.audit.requestId,
        retryable: true
      }
    );
  }

  return apiErrorToolResult(
    responseBody.ok ? withResponseRetryability(responseBody.body, response.statusCode) : undefined
  );
}

function createMultipartBody(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `enterprise-hub-mcp-${randomBytes(12).toString("hex")}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));

    if (part.type === "file") {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${escapeMultipartValue(
            part.name
          )}"; filename="${escapeMultipartValue(part.filename)}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
          "utf8"
        )
      );
      chunks.push(part.body);
      chunks.push(Buffer.from("\r\n", "utf8"));
      continue;
    }

    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${escapeMultipartValue(part.name)}"\r\n\r\n` +
          `${part.value}\r\n`,
        "utf8"
      )
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function escapeMultipartValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseResponseBody(response: UploadApiDelegationResponse):
  | {
      ok: true;
      body: unknown;
    }
  | {
      ok: false;
    } {
  if (response.json) {
    try {
      return {
        ok: true,
        body: response.json()
      };
    } catch {
      return {
        ok: false
      };
    }
  }

  try {
    return {
      ok: true,
      body: JSON.parse(response.payload)
    };
  } catch {
    return {
      ok: false
    };
  }
}

function withResponseRetryability(body: unknown, statusCode: number): unknown {
  if (!isApiErrorBody(body)) {
    return body;
  }

  if (typeof body.error.retryable === "boolean") {
    return body;
  }

  return {
    ...body,
    error: {
      ...body.error,
      retryable: statusCode === 429 || statusCode >= 500
    }
  };
}

function isApiErrorBody(body: unknown): body is {
  error: {
    code: string;
    message: string;
    retryable?: unknown;
    requestId?: unknown;
  };
} {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }

  const error = (body as { error: unknown }).error;

  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function requireToolContract(name: EnterpriseHubMcpToolName) {
  const contract = ENTERPRISE_HUB_MCP_TOOL_CONTRACTS.find((candidate) => candidate.name === name);

  if (!contract) {
    throw new Error(`Missing Enterprise Hub MCP tool contract: ${name}`);
  }

  return contract;
}

function sanitizeValidationIssues(
  issues: Array<{
    code: string;
    message: string;
    path: PropertyKey[];
  }>
) {
  return {
    issues: issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path.map((segment) => String(segment))
    }))
  };
}
