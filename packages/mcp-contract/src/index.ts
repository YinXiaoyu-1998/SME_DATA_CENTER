import path from "node:path";
import { z } from "zod";
import {
  PHASE3_RUNTIME_LIMIT_DEFAULTS,
  PUBLIC_INPUT_LIMITS,
  STRUCTURED_DATASETS,
  STRUCTURED_QUERY_LIMITS,
  getStructuredRegistry
} from "@enterprise-hub/domain";

export const MCP_UPLOAD_FILENAME_MAX_LENGTH = PUBLIC_INPUT_LIMITS.uploadFilenameChars;
export const MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH = PUBLIC_INPUT_LIMITS.uploadMediaTypeChars;
export const MCP_UPLOAD_MAX_BYTES = PHASE3_RUNTIME_LIMIT_DEFAULTS.maxUploadBytes;
export const MCP_LOCAL_FILE_PATH_MAX_LENGTH = 4096;
export const MCP_STRUCTURED_QUERY_LIMITS = STRUCTURED_QUERY_LIMITS;

const evidenceFileType = z.enum(["md", "txt", "docx"]).describe("Evidence file type filter.");
const structuredDataset = z.enum(STRUCTURED_DATASETS).describe("Phase 3 structured dataset name.");
const scalarStructuredValue = z.union([
  z.string().max(PUBLIC_INPUT_LIMITS.structuredQueryStringScalarChars),
  z.number(),
  z.boolean(),
  z.null()
]);
const labelKey = z.string().min(1).max(PUBLIC_INPUT_LIMITS.labelKeyChars);
const evidenceFilterId = z.string().min(1).max(PUBLIC_INPUT_LIMITS.evidenceFilterIdChars);
const structuredFilter: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z
      .object({
        field: z.string().min(1),
        op: z.string().min(1),
        value: z.union([
          scalarStructuredValue,
          z.array(scalarStructuredValue).max(MCP_STRUCTURED_QUERY_LIMITS.maxInValues)
        ])
      })
      .strict(),
    z.object({ and: z.array(structuredFilter).min(1) }).strict(),
    z.object({ or: z.array(structuredFilter).min(1) }).strict(),
    z.object({ not: structuredFilter }).strict()
  ])
);

const basenameOnlyFilename = z
  .string()
  .min(1)
  .max(MCP_UPLOAD_FILENAME_MAX_LENGTH)
  .refine((name) => !hasAsciiControlCharacter(name), {
    message: "Filename must not contain control characters."
  })
  .refine((name) => name === name.trim(), "Filename must not have surrounding whitespace.")
  .refine((name) => name !== "." && name !== "..", "Filename must be a basename.")
  .refine((name) => !name.includes("/") && !name.includes("\\") && !name.includes(":"), {
    message: "Filename must be a basename, not a path."
  });

const canonicalBase64 = z.string().min(1).refine(isCanonicalWhitespaceFreeBase64, {
  message: "Content must be canonical whitespace-free base64."
});

const uploadMediaType = z
  .string()
  .min(1)
  .max(MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH)
  .refine((mediaType) => !hasAsciiControlCharacter(mediaType), {
    message: "Upload MIME media type must not contain control characters."
  })
  .regex(
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[\t !#-[\]-~]*"))*$/,
    "Upload MIME media type must use strict MIME token syntax."
  )
  .describe("Upload MIME media type.");

const uploadFileInputSchema = z
  .object({
    name: basenameOnlyFilename.describe("Basename-only upload filename."),
    mediaType: uploadMediaType,
    encoding: z.literal("base64").describe("Upload content encoding."),
    contentBase64: canonicalBase64.describe("Canonical whitespace-free base64 upload content.")
  })
  .strict();

export const localFilePath = z
  .string()
  .min(1)
  .max(MCP_LOCAL_FILE_PATH_MAX_LENGTH)
  .refine((candidate) => path.isAbsolute(candidate), {
    message: "Local upload file path must be absolute."
  })
  .describe("Absolute local filesystem path read by the launcher.");

const launcherPathUploadFileInputSchema = z
  .object({
    name: basenameOnlyFilename.describe("Basename-only upload filename."),
    mediaType: uploadMediaType,
    encoding: z.literal("path").describe("Launcher-resolved local file path encoding."),
    filePath: localFilePath
  })
  .strict();

export const launcherUploadFileInputSchema = z.union([
  uploadFileInputSchema,
  launcherPathUploadFileInputSchema
]);

export const launcherUploadFileInputShape: z.ZodRawShape = {
  name: basenameOnlyFilename,
  mediaType: uploadMediaType,
  encoding: z.enum(["base64", "path"]),
  contentBase64: canonicalBase64.optional(),
  filePath: localFilePath.optional()
};

const listLabelsInputSchema = z.object({}).strict();

const listSkillsInputSchema = z
  .object({
    q: z.string().optional().describe("Optional keyword query."),
    category: z.string().min(1).optional().describe("Optional exact category filter.")
  })
  .strict();

const searchDocumentEvidenceInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.evidenceQueryChars)
      .describe("Evidence search query."),
    filters: z
      .object({
        fileTypes: z.array(evidenceFileType).optional().describe("Optional md/txt/docx filters."),
        documentIds: z
          .array(evidenceFilterId)
          .max(PUBLIC_INPUT_LIMITS.evidenceFilterIdsPerGroup)
          .optional()
          .describe("Optional document ids."),
        labelIds: z
          .array(evidenceFilterId)
          .max(PUBLIC_INPUT_LIMITS.evidenceFilterIdsPerGroup)
          .optional()
          .describe("Optional API label id filters when known.")
      })
      .strict()
      .optional()
      .describe("Optional evidence filters delegated to the API."),
    limit: z.number().int().min(1).max(50).optional().describe("Optional 1-50 result limit."),
    cursor: z
      .string()
      .max(PUBLIC_INPUT_LIMITS.cursorChars)
      .optional()
      .describe("Optional opaque cursor from the API.")
  })
  .strict();

const listStructuredDatasetsInputSchema = z.object({}).strict();

const queryStructuredDatasetInputSchema = z
  .object({
    dataset: structuredDataset,
    registryVersion: z.string().min(1).optional().describe("Optional registry version."),
    select: z
      .array(z.string().min(1))
      .max(MCP_STRUCTURED_QUERY_LIMITS.maxSelectedFields)
      .optional()
      .describe("Optional selected field names."),
    filter: structuredFilter.optional().describe("Optional controlled filter tree."),
    sort: z
      .array(
        z
          .object({
            field: z.string().min(1),
            direction: z.enum(["asc", "desc"]).default("asc")
          })
          .strict()
      )
      .max(MCP_STRUCTURED_QUERY_LIMITS.maxSortFields)
      .optional()
      .describe("Optional controlled sort fields."),
    page: z
      .object({
        limit: z.number().int().min(1).max(MCP_STRUCTURED_QUERY_LIMITS.maxRows).optional(),
        cursor: z.string().max(PUBLIC_INPUT_LIMITS.cursorChars).nullable().optional()
      })
      .strict()
      .optional()
      .describe("Optional page limit and cursor."),
    groupBy: z
      .array(z.string().min(1))
      .max(MCP_STRUCTURED_QUERY_LIMITS.maxGroupByFields)
      .optional()
      .describe("Optional aggregate group-by field."),
    aggregates: z
      .array(
        z
          .object({
            op: z.enum(["count", "countDistinct", "sum", "avg", "min", "max"]),
            field: z.string().min(1).optional(),
            as: z.string().min(1).optional()
          })
          .strict()
      )
      .max(MCP_STRUCTURED_QUERY_LIMITS.maxAggregates)
      .optional()
      .describe("Optional explicit mechanical aggregations.")
  })
  .strict()
  .superRefine(validateStructuredQueryBounds);

const uploadStructuredDatasetInputSchema = z
  .object({
    file: uploadFileInputSchema,
    dataset: structuredDataset,
    enterpriseName: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.enterpriseNameChars)
      .describe("Enterprise/source name for canonical naming."),
    startDate: z
      .string()
      .regex(/^\d{8}$/)
      .optional()
      .describe("YYYYMMDD business window start for dishes, business, or vip."),
    endDate: z
      .string()
      .regex(/^\d{8}$/)
      .optional()
      .describe("YYYYMMDD business window end for dishes, business, or vip."),
    snapshotDate: z
      .string()
      .regex(/^\d{8}$/)
      .optional()
      .describe("YYYYMMDD complete snapshot date for dish_catalog."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.idempotencyKeyChars)
      .describe("Client-generated retry/idempotency key."),
    labelKeys: z
      .array(labelKey)
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.labelsPerRequest)
      .describe("Explicit existing label keys/visibility for rows and source document.")
  })
  .strict()
  .superRefine((input, context) => {
    const metadataPolicy = getStructuredRegistry(input.dataset).metadataPolicy;

    switch (metadataPolicy) {
      case "snapshot":
        if (!input.snapshotDate) {
          context.addIssue({
            code: "custom",
            message: `${input.dataset} requires snapshotDate.`,
            path: ["snapshotDate"]
          });
        }
        for (const field of ["startDate", "endDate"] as const) {
          if (input[field] !== undefined) {
            context.addIssue({
              code: "custom",
              message: `${input.dataset} does not accept ${field}.`,
              path: [field]
            });
          }
        }
        return;
      case "window":
        if (input.snapshotDate !== undefined) {
          context.addIssue({
            code: "custom",
            message: "Window datasets do not accept snapshotDate.",
            path: ["snapshotDate"]
          });
        }
        for (const field of ["startDate", "endDate"] as const) {
          if (!input[field]) {
            context.addIssue({
              code: "custom",
              message: `${field} is required for window datasets.`,
              path: [field]
            });
          }
        }
        return;
      case "derived_receipt":
      case "none":
        for (const field of ["startDate", "endDate", "snapshotDate"] as const) {
          if (input[field] !== undefined) {
            context.addIssue({
              code: "custom",
              message: `${input.dataset} does not accept ${field}.`,
              path: [field]
            });
          }
        }
        return;
    }
  });

const uploadEvidenceDocumentInputSchema = z
  .object({
    file: uploadFileInputSchema,
    title: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.evidenceTitleChars)
      .describe("Evidence source title."),
    sourceSystem: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.sourceSystemChars)
      .optional()
      .describe("Optional source system."),
    labelKeys: z
      .array(labelKey)
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.labelsPerRequest)
      .describe("Explicit existing label keys/visibility for the evidence document.")
  })
  .strict();

const evidenceDocumentStatusInputSchema = z
  .object({
    documentId: z.string().min(1).describe("Evidence document id.")
  })
  .strict();

const importStatusInputSchema = z
  .object({
    importBatchId: z.string().min(1).describe("Structured import batch id.")
  })
  .strict();

const receiptId = z.string().min(1).max(255);

const uploadQuarantineCertificateInputSchema = z
  .object({
    file: uploadFileInputSchema,
    receiptId: receiptId.describe("Receipt ID linked to this certificate."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.idempotencyKeyChars)
      .describe("Client-generated retry/idempotency key."),
    labelKeys: z
      .array(labelKey)
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.labelsPerRequest)
      .describe("Explicit existing label keys/visibility for the certificate.")
  })
  .strict();

const queryQuarantineCertificatesInputSchema = z
  .object({
    receiptIds: z.array(receiptId).min(1).max(100).describe("Receipt IDs to query.")
  })
  .strict();

const archiveQuarantineCertificatesInputSchema = z
  .object({
    sourceDocumentId: z.string().min(1).optional().describe("Source document ID to archive."),
    receiptId: receiptId.optional().describe("Receipt ID whose certificates should be archived.")
  })
  .strict()
  .refine((input) => Boolean(input.sourceDocumentId) !== Boolean(input.receiptId), {
    message: "Provide exactly one of sourceDocumentId or receiptId."
  });

const sourceDocumentDownloadUrlInputSchema = z
  .object({
    sourceDocumentId: z.string().min(1).describe("Source document ID to download.")
  })
  .strict();

export const ENTERPRISE_HUB_MCP_TOOL_NAMES = [
  "enterprise_hub_list_labels",
  "enterprise_hub_list_skills",
  "search_document_evidence",
  "list_structured_datasets",
  "query_structured_dataset",
  "upload_structured_dataset",
  "upload_evidence_document",
  "upload_quarantine_certificate",
  "query_quarantine_certificates",
  "archive_quarantine_certificates",
  "get_source_document_download_url",
  "get_evidence_document_status",
  "get_import_status"
] as const;

export type EnterpriseHubMcpToolName = (typeof ENTERPRISE_HUB_MCP_TOOL_NAMES)[number];

export interface McpToolInputField {
  name: string;
  required: boolean;
  description: string;
}

export interface EnterpriseHubMcpToolContract {
  name: EnterpriseHubMcpToolName;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  inputShape: z.ZodRawShape;
  inputFields: McpToolInputField[];
  resultShape: string[];
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpJsonToolResult {
  [key: string]: unknown;
  content: McpTextContent[];
  isError: boolean;
}

export interface McpErrorBody {
  error: {
    code: McpErrorCode | string;
    message: string;
    retryable: boolean;
    requestId?: string;
    details?: unknown;
  };
}

export const MCP_ERROR_CODES = [
  "ENTERPRISE_HUB_API_ERROR",
  "MCP_INPUT_VALIDATION_ERROR",
  "MCP_TOOL_NOT_FOUND",
  "MCP_UNAUTHORIZED",
  "MCP_FORBIDDEN",
  "MCP_NOT_FOUND",
  "MCP_INTERNAL_ERROR",
  "MCP_UPLOAD_FILE_INVALID"
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const ENTERPRISE_HUB_MCP_TOOL_CONTRACTS = [
  defineToolContract({
    name: "enterprise_hub_list_labels",
    title: "List Enterprise Hub labels",
    description: "List label catalog entries by calling authenticated GET /labels on the API.",
    inputSchema: listLabelsInputSchema,
    inputFields: [],
    resultShape: ["labels[]: { key, name, type }"]
  }),
  defineToolContract({
    name: "enterprise_hub_list_skills",
    title: "List Enterprise Hub skills",
    description: "List approved Skill Directory entries by calling authenticated GET /skills.",
    inputSchema: listSkillsInputSchema,
    inputFields: [
      { name: "q", required: false, description: "Keyword query." },
      { name: "category", required: false, description: "Exact category filter." }
    ],
    resultShape: ["skills[]: approved metadata and instructions only"]
  }),
  defineToolContract({
    name: "search_document_evidence",
    title: "Search Enterprise Hub evidence chunks",
    description:
      "Return authorized evidence chunks by calling authenticated POST /v1/evidence/search; never generates answers.",
    inputSchema: searchDocumentEvidenceInputSchema,
    inputFields: [
      { name: "query", required: true, description: "Evidence search query." },
      { name: "filters", required: false, description: "Optional API-supported filters." },
      { name: "limit", required: false, description: "1-50 result limit." },
      { name: "cursor", required: false, description: "Opaque pagination cursor." }
    ],
    resultShape: ["results[]: evidence chunks and source metadata", "page", "retrieval", "warnings"]
  }),
  defineToolContract({
    name: "list_structured_datasets",
    title: "List Enterprise Hub structured datasets",
    description:
      "Discover registry-backed structured datasets by calling authenticated GET /v1/structured/datasets. Field canonicalName values are the structured-query field names; sourceColumn and aliases are for mapping user-facing/source labels to canonicalName and for result presentation.",
    inputSchema: listStructuredDatasetsInputSchema,
    inputFields: [],
    resultShape: [
      "limits",
      "datasets[]: registry versions, fields with canonicalName/sourceColumn/aliases, operators, capabilities"
    ]
  }),
  defineToolContract({
    name: "query_structured_dataset",
    title: "Query Enterprise Hub structured dataset",
    description:
      "Execute a controlled read-only structured query by calling authenticated POST /v1/structured/query.",
    inputSchema: queryStructuredDatasetInputSchema,
    inputFields: [
      {
        name: "dataset",
        required: true,
        description:
          "`dishes`, `business`, `vip`, `dish_catalog`, `delivery_ledger`, or `supplier_catalog`."
      },
      { name: "registryVersion", required: false, description: "Optional registry version." },
      {
        name: "select",
        required: false,
        description:
          "Selected canonicalName values only. Do not send sourceColumn or aliases directly."
      },
      {
        name: "filter",
        required: false,
        description:
          "Controlled filter tree. Field references must use canonicalName values from discovery."
      },
      {
        name: "sort",
        required: false,
        description:
          "Controlled sort fields. Field references must use canonicalName values from discovery."
      },
      { name: "page", required: false, description: "Page limit/cursor." },
      {
        name: "groupBy",
        required: false,
        description: "Aggregate group-by canonicalName values only."
      },
      {
        name: "aggregates",
        required: false,
        description:
          "Explicit mechanical aggregations. Aggregate field references must use canonicalName values from discovery."
      }
    ],
    resultShape: ["dataset", "registryVersion", "mode", "rows[]", "nextCursor"]
  }),
  defineToolContract({
    name: "upload_structured_dataset",
    title: "Upload Enterprise Hub structured dataset",
    description:
      "Queue XLSX/CSV structured data with authenticated multipart POST /v1/structured/imports; a 202 queued response requires status polling before success is reported.",
    inputSchema: uploadStructuredDatasetInputSchema,
    inputFields: [
      { name: "file", required: true, description: "Base64 upload file payload." },
      {
        name: "dataset",
        required: true,
        description:
          "`dishes`, `business`, `vip`, `dish_catalog`, `delivery_ledger`, or `supplier_catalog`."
      },
      { name: "enterpriseName", required: true, description: "Enterprise/source name." },
      { name: "startDate", required: false, description: "YYYYMMDD business window start." },
      { name: "endDate", required: false, description: "YYYYMMDD business window end." },
      { name: "snapshotDate", required: false, description: "YYYYMMDD catalog snapshot date." },
      { name: "idempotencyKey", required: true, description: "Retry/idempotency key." },
      { name: "labelKeys", required: true, description: "Explicit existing label keys." }
    ],
    resultShape: ["document", "processing", "importBatch"]
  }),
  defineToolContract({
    name: "upload_evidence_document",
    title: "Upload Enterprise Hub evidence document",
    description:
      "Upload MD/TXT/DOCX evidence by calling authenticated multipart POST /v1/documents/evidence.",
    inputSchema: uploadEvidenceDocumentInputSchema,
    inputFields: [
      { name: "file", required: true, description: "Base64 upload file payload." },
      { name: "title", required: true, description: "Evidence source title." },
      { name: "sourceSystem", required: false, description: "Optional source system." },
      { name: "labelKeys", required: true, description: "Explicit existing label keys." }
    ],
    resultShape: ["document", "processing", "documentIndex"]
  }),
  defineToolContract({
    name: "upload_quarantine_certificate",
    title: "Upload Enterprise Hub quarantine certificate",
    description:
      "Upload one JPG/PNG quarantine certificate linked to a receipt ID by calling authenticated multipart POST /v1/documents/quarantine-certificates.",
    inputSchema: uploadQuarantineCertificateInputSchema,
    inputFields: [
      { name: "file", required: true, description: "Base64 upload image payload." },
      { name: "receiptId", required: true, description: "Receipt ID linked to this image." },
      { name: "idempotencyKey", required: true, description: "Retry/idempotency key." },
      { name: "labelKeys", required: true, description: "Explicit existing label keys." }
    ],
    resultShape: [
      "sourceDocumentId",
      "receiptId",
      "originalFileName",
      "contentType",
      "byteSize",
      "uploadedAt"
    ]
  }),
  defineToolContract({
    name: "query_quarantine_certificates",
    title: "Query Enterprise Hub quarantine certificates",
    description:
      "Query visible quarantine certificates by receipt IDs using authenticated POST /v1/quarantine-certificates/query.",
    inputSchema: queryQuarantineCertificatesInputSchema,
    inputFields: [{ name: "receiptIds", required: true, description: "1-100 receipt IDs." }],
    resultShape: ["results[]: { receiptId, certificates[] }"]
  }),
  defineToolContract({
    name: "archive_quarantine_certificates",
    title: "Archive Enterprise Hub quarantine certificates",
    description:
      "Archive one quarantine certificate by source document ID, or admin-archive all certificates under one receipt ID.",
    inputSchema: archiveQuarantineCertificatesInputSchema,
    inputFields: [
      { name: "sourceDocumentId", required: false, description: "Single source document ID." },
      {
        name: "receiptId",
        required: false,
        description: "Single receipt ID for admin bulk archive."
      }
    ],
    resultShape: ["archivedCount"]
  }),
  defineToolContract({
    name: "get_source_document_download_url",
    title: "Get Enterprise Hub source document download URL",
    description:
      "Issue an authorized temporary source-file download URL using authenticated POST /v1/source-documents/:sourceDocumentId/download-url.",
    inputSchema: sourceDocumentDownloadUrlInputSchema,
    inputFields: [{ name: "sourceDocumentId", required: true, description: "Source document ID." }],
    resultShape: [
      "sourceDocumentId",
      "downloadUrl",
      "expiresAt",
      "originalFileName",
      "contentType",
      "byteSize"
    ]
  }),
  defineToolContract({
    name: "get_evidence_document_status",
    title: "Get Enterprise Hub evidence document status",
    description:
      "Read evidence indexing status by calling authenticated GET /v1/documents/evidence/:documentId/status.",
    inputSchema: evidenceDocumentStatusInputSchema,
    inputFields: [{ name: "documentId", required: true, description: "Evidence document id." }],
    resultShape: ["document", "processing", "documentIndex"]
  }),
  defineToolContract({
    name: "get_import_status",
    title: "Get Enterprise Hub structured import status",
    description:
      "Read structured import status and its terminal outcome by calling authenticated GET /v1/structured/imports/:importBatchId.",
    inputSchema: importStatusInputSchema,
    inputFields: [
      { name: "importBatchId", required: true, description: "Structured import batch id." }
    ],
    resultShape: ["document", "processing", "importBatch"]
  })
] as const satisfies readonly EnterpriseHubMcpToolContract[];

export const mcpToolContractSchema = z
  .object({
    name: z.enum(ENTERPRISE_HUB_MCP_TOOL_NAMES),
    title: z.string().min(1),
    description: z.string().min(1),
    inputSchema: z.custom<z.ZodObject<z.ZodRawShape>>(isZodObject),
    inputShape: z.record(z.string(), z.custom<z.ZodType>(isZodType)),
    inputFields: z.array(
      z
        .object({
          name: z.string().min(1),
          required: z.boolean(),
          description: z.string().min(1)
        })
        .strict()
    ),
    resultShape: z.array(z.string().min(1)).min(1)
  })
  .strict()
  .superRefine((contract, context) => {
    const shapeNames = Object.keys(contract.inputShape);
    const fieldNames = contract.inputFields.map((field) => field.name);

    if (shapeNames.join("\0") !== fieldNames.join("\0")) {
      context.addIssue({
        code: "custom",
        message: "Input fields must match input shape keys in registration order.",
        path: ["inputFields"]
      });
    }

    for (const forbiddenField of ["sessionName", "filePath"]) {
      if (forbiddenField in contract.inputShape) {
        context.addIssue({
          code: "custom",
          message: `${forbiddenField} is not part of the stateless MCP contract.`,
          path: ["inputShape", forbiddenField]
        });
      }
    }
  });

export function jsonToolResult(payload: unknown, isError = false): McpJsonToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    isError
  };
}

export function errorToolResult(
  code: McpErrorCode | string,
  message: string,
  details?: unknown,
  options: { retryable?: boolean; requestId?: string } = {}
): McpJsonToolResult {
  const body: McpErrorBody = {
    error: {
      code,
      message,
      retryable: options.retryable ?? defaultMcpErrorRetryable(code)
    }
  };

  if (options.requestId !== undefined) {
    body.error.requestId = options.requestId;
  }

  if (details !== undefined) {
    body.error.details = details;
  }

  return jsonToolResult(body, true);
}

export function apiErrorToolResult(body: unknown): McpJsonToolResult {
  if (isApiErrorBody(body)) {
    const defaultRetryable = defaultApiErrorRetryable(body.error.code);

    return errorToolResult(body.error.code, body.error.message, undefined, {
      retryable:
        defaultRetryable && typeof body.error.retryable === "boolean"
          ? body.error.retryable
          : defaultRetryable,
      requestId: safeRequestId(body.error.requestId)
    });
  }

  return errorToolResult(
    "ENTERPRISE_HUB_API_ERROR",
    "Enterprise Hub API request failed.",
    undefined,
    {
      retryable: true
    }
  );
}

export function validationErrorToolResult(details: unknown): McpJsonToolResult {
  return errorToolResult("MCP_INPUT_VALIDATION_ERROR", "Invalid MCP tool input.", details);
}

export function toolNotFoundResult(toolName: string): McpJsonToolResult {
  return errorToolResult("MCP_TOOL_NOT_FOUND", `Unknown Enterprise Hub MCP tool: ${toolName}`);
}

export function isMcpErrorBody(body: unknown): body is McpErrorBody {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }

  const error = (body as { error: unknown }).error;

  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  );
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable?: unknown;
    requestId?: unknown;
  };
}

function isApiErrorBody(body: unknown): body is ApiErrorBody {
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

function defaultMcpErrorRetryable(code: McpErrorCode | string): boolean {
  if (code === "ENTERPRISE_HUB_API_ERROR" || code === "MCP_INTERNAL_ERROR") {
    return true;
  }

  return false;
}

function defaultApiErrorRetryable(code: string): boolean {
  const normalized = code.toUpperCase();

  if (
    normalized.includes("VALIDATION") ||
    normalized.includes("INVALID") ||
    normalized.includes("UNAUTH") ||
    normalized.includes("AUTH") ||
    normalized.includes("BAD_REQUEST") ||
    normalized.includes("FORBIDDEN") ||
    normalized.includes("DENIED") ||
    normalized.includes("NOT_FOUND") ||
    normalized.includes("NOTFOUND") ||
    normalized.includes("CONFLICT") ||
    normalized.includes("IDEMPOTENCY") ||
    normalized.includes("ACTIVE_IMPORT_EXISTS") ||
    normalized.includes("IMPORT_IN_PROGRESS")
  ) {
    return false;
  }

  return true;
}

function validateStructuredQueryBounds(
  input: {
    filter?: unknown;
    page?: { limit?: number };
    groupBy?: string[];
    aggregates?: unknown[];
  },
  context: z.RefinementCtx
): void {
  const isAggregateMode = Boolean(input.groupBy?.length || input.aggregates?.length);
  const maxLimit = isAggregateMode
    ? MCP_STRUCTURED_QUERY_LIMITS.maxAggregateGroups
    : MCP_STRUCTURED_QUERY_LIMITS.maxRows;

  if (input.page?.limit !== undefined && input.page.limit > maxLimit) {
    context.addIssue({
      code: "custom",
      message: `Page limit must be no greater than ${maxLimit}.`,
      path: ["page", "limit"]
    });
  }

  if (input.filter !== undefined) {
    validateStructuredFilterBounds(input.filter, 1, context, ["filter"]);
  }
}

function validateStructuredFilterBounds(
  filter: unknown,
  depth: number,
  context: z.RefinementCtx,
  path: Array<string | number>
): number {
  if (depth > MCP_STRUCTURED_QUERY_LIMITS.maxBooleanDepth) {
    context.addIssue({
      code: "custom",
      message: `Filter boolean depth must be no greater than ${MCP_STRUCTURED_QUERY_LIMITS.maxBooleanDepth}.`,
      path
    });
    return 0;
  }

  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    return 0;
  }

  if ("and" in filter || "or" in filter) {
    const values = "and" in filter ? filter.and : filter.or;

    if (!Array.isArray(values)) {
      return 0;
    }

    const count = values.reduce((total, value, index) => {
      return (
        total +
        validateStructuredFilterBounds(value, depth + 1, context, [
          ...path,
          "and" in filter ? "and" : "or",
          index
        ])
      );
    }, 0);

    if (count > MCP_STRUCTURED_QUERY_LIMITS.maxConditions) {
      context.addIssue({
        code: "custom",
        message: `Filter condition count must be no greater than ${MCP_STRUCTURED_QUERY_LIMITS.maxConditions}.`,
        path
      });
    }

    return count;
  }

  if ("not" in filter) {
    return validateStructuredFilterBounds(filter.not, depth + 1, context, [...path, "not"]);
  }

  return 1;
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return undefined;
  }

  return value;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
}

function defineToolContract(
  contract: Omit<EnterpriseHubMcpToolContract, "inputShape">
): EnterpriseHubMcpToolContract {
  return {
    ...contract,
    inputShape: contract.inputSchema.shape
  };
}

function isCanonicalWhitespaceFreeBase64(value: string): boolean {
  if (/\s/.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }

  const firstPaddingIndex = value.indexOf("=");

  if (firstPaddingIndex !== -1 && !/^=+$/.test(value.slice(firstPaddingIndex))) {
    return false;
  }

  const unpadded = value.replace(/=+$/, "");
  const remainder = unpadded.length % 4;

  if (remainder === 1) {
    return false;
  }

  const providedPadding = value.length - unpadded.length;
  const requiredPadding = remainder === 0 ? 0 : 4 - remainder;

  if (providedPadding !== 0 && providedPadding !== requiredPadding) {
    return false;
  }

  try {
    const padded = unpadded.padEnd(unpadded.length + requiredPadding, "=");
    const canonical = Buffer.from(padded, "base64").toString("base64").replace(/=+$/, "");

    return canonical === unpadded;
  } catch {
    return false;
  }
}

function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  return (
    isZodType(value) &&
    "_def" in value &&
    (value as { _def?: { type?: unknown } })._def?.type === "object"
  );
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value;
}
