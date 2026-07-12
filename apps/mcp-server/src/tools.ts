import { z } from "zod";

const optionalSessionName = z
  .string()
  .min(1)
  .optional()
  .describe("Optional local MCP session name. Defaults are implemented in Phase 2 Day 2.");

const documentType = z
  .enum([
    "raw_material",
    "structured_dataset",
    "analysis_artifact",
    "business_event",
    "management_knowledge"
  ])
  .describe("Existing Enterprise Hub document type.");

const evidenceFileType = z.enum(["md", "txt", "docx"]).describe("Evidence file type filter.");
const structuredDataset = z
  .enum(["dishes", "business"])
  .describe("Phase 3 structured dataset name.");
const scalarStructuredValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const structuredFilter: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({
      field: z.string().min(1),
      op: z.string().min(1),
      value: z.union([scalarStructuredValue, z.array(scalarStructuredValue)])
    }),
    z.object({ and: z.array(structuredFilter).min(1) }),
    z.object({ or: z.array(structuredFilter).min(1) }),
    z.object({ not: structuredFilter })
  ])
);

export interface McpToolInputField {
  name: string;
  required: boolean;
  description: string;
}

export interface McpToolContract {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  inputFields: McpToolInputField[];
  resultShape: string[];
}

export interface McpJsonToolResult {
  [key: string]: unknown;
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

export const MCP_TOOL_CONTRACTS: McpToolContract[] = [
  {
    name: "enterprise_hub_login_dev",
    title: "Enterprise Hub local development login",
    description: "Log in as a seeded local employee through the existing API dev-login endpoint.",
    inputSchema: {
      email: z.string().email().describe("Seeded local employee email."),
      sessionName: optionalSessionName
    },
    inputFields: [
      { name: "email", required: true, description: "Seeded local employee email." },
      {
        name: "sessionName",
        required: false,
        description: "Optional local session name for later tools."
      }
    ],
    resultShape: ["employee", "sessionName", "apiUrl"]
  },
  {
    name: "enterprise_hub_list_labels",
    title: "List Enterprise Hub labels",
    description: "List label catalog entries by calling authenticated GET /labels on the API.",
    inputSchema: {
      sessionName: optionalSessionName
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." }
    ],
    resultShape: ["labels[]: { key, name, type }"]
  },
  {
    name: "enterprise_hub_upload_document",
    title: "Upload Enterprise Hub document",
    description:
      "Upload a local file by calling authenticated multipart POST /documents on the API.",
    inputSchema: {
      sessionName: optionalSessionName,
      filePath: z.string().min(1).describe("Local file path visible to the MCP server process."),
      title: z.string().min(1).describe("Document title."),
      documentType,
      sourceSystem: z.string().min(1).optional().describe("Optional source system."),
      sourceTime: z.string().datetime().optional().describe("Optional ISO source timestamp."),
      labelKeys: z.array(z.string().min(1)).default([]).describe("Existing label keys to request.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "filePath", required: true, description: "Local upload file path." },
      { name: "title", required: true, description: "Document title." },
      { name: "documentType", required: true, description: "Existing document type enum value." },
      { name: "sourceSystem", required: false, description: "Optional source system." },
      { name: "sourceTime", required: false, description: "Optional ISO source timestamp." },
      { name: "labelKeys", required: false, description: "Existing label keys to request." }
    ],
    resultShape: ["document id", "status", "labels", "processingRunStatus"]
  },
  {
    name: "enterprise_hub_get_document_status",
    title: "Get Enterprise Hub document status",
    description: "Read processing status by calling authenticated GET /documents/:id/status.",
    inputSchema: {
      sessionName: optionalSessionName,
      documentId: z.string().min(1).describe("Document id.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "documentId", required: true, description: "Document id." }
    ],
    resultShape: ["id", "status", "labels", "processingRunStatus"]
  },
  {
    name: "enterprise_hub_search_documents",
    title: "Search Enterprise Hub documents",
    description: "Search visible active documents by calling authenticated GET /documents.",
    inputSchema: {
      sessionName: optionalSessionName,
      q: z.string().optional().describe("Optional keyword query."),
      documentType: documentType.optional(),
      labelKey: z.string().min(1).optional().describe("Optional label filter."),
      limit: z.number().int().min(1).max(50).optional().describe("Optional result limit."),
      cursor: z.string().optional().describe("Optional cursor from a previous result.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "q", required: false, description: "Keyword query." },
      { name: "documentType", required: false, description: "Existing document type enum value." },
      { name: "labelKey", required: false, description: "Existing label filter." },
      { name: "limit", required: false, description: "1-50 result limit." },
      { name: "cursor", required: false, description: "Pagination cursor." }
    ],
    resultShape: ["documents[]", "nextCursor"]
  },
  {
    name: "enterprise_hub_get_document",
    title: "Get Enterprise Hub document",
    description:
      "Read accessible active document metadata by calling authenticated GET /documents/:id.",
    inputSchema: {
      sessionName: optionalSessionName,
      documentId: z.string().min(1).describe("Document id.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "documentId", required: true, description: "Document id." }
    ],
    resultShape: ["document metadata or API not-found error"]
  },
  {
    name: "enterprise_hub_get_document_download_url",
    title: "Get Enterprise Hub document download URL",
    description:
      "Get an accessible active document download URL through GET /documents/:id/download.",
    inputSchema: {
      sessionName: optionalSessionName,
      documentId: z.string().min(1).describe("Document id.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "documentId", required: true, description: "Document id." }
    ],
    resultShape: ["id", "downloadUrl"]
  },
  {
    name: "enterprise_hub_archive_document",
    title: "Archive Enterprise Hub document",
    description: "Archive a document by calling authenticated POST /documents/:id/archive.",
    inputSchema: {
      sessionName: optionalSessionName,
      documentId: z.string().min(1).describe("Document id.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "documentId", required: true, description: "Document id." }
    ],
    resultShape: ["archived document metadata or API error"]
  },
  {
    name: "enterprise_hub_list_skills",
    title: "List Enterprise Hub skills",
    description: "List approved Skill Directory entries by calling authenticated GET /skills.",
    inputSchema: {
      sessionName: optionalSessionName,
      q: z.string().optional().describe("Optional keyword query."),
      category: z.string().min(1).optional().describe("Optional exact category filter.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "q", required: false, description: "Keyword query." },
      { name: "category", required: false, description: "Exact category filter." }
    ],
    resultShape: ["skills[]: approved metadata and instructions only"]
  },
  {
    name: "search_document_evidence",
    title: "Search Enterprise Hub evidence chunks",
    description:
      "Return authorized evidence chunks by calling authenticated POST /v1/evidence/search; never generates answers.",
    inputSchema: {
      sessionName: optionalSessionName,
      query: z.string().min(1).describe("Evidence search query."),
      filters: z
        .object({
          fileTypes: z.array(evidenceFileType).optional().describe("Optional md/txt/docx filters."),
          documentIds: z.array(z.string().min(1)).optional().describe("Optional document ids."),
          labelIds: z
            .array(z.string().min(1))
            .optional()
            .describe("Optional API label id filters when known.")
        })
        .optional()
        .describe("Optional evidence filters delegated to the API."),
      limit: z.number().int().min(1).max(50).optional().describe("Optional 1-50 result limit."),
      cursor: z.string().optional().describe("Optional opaque cursor from the API.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "query", required: true, description: "Evidence search query." },
      { name: "filters", required: false, description: "Optional API-supported filters." },
      { name: "limit", required: false, description: "1-50 result limit." },
      { name: "cursor", required: false, description: "Opaque pagination cursor." }
    ],
    resultShape: ["results[]: evidence chunks and source metadata", "page", "retrieval", "warnings"]
  },
  {
    name: "list_structured_datasets",
    title: "List Enterprise Hub structured datasets",
    description:
      "Discover registry-backed structured datasets by calling authenticated GET /v1/structured/datasets.",
    inputSchema: {
      sessionName: optionalSessionName
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." }
    ],
    resultShape: ["limits", "datasets[]: registry versions, fields, operators, capabilities"]
  },
  {
    name: "query_structured_dataset",
    title: "Query Enterprise Hub structured dataset",
    description:
      "Execute a controlled read-only structured query by calling authenticated POST /v1/structured/query.",
    inputSchema: {
      sessionName: optionalSessionName,
      dataset: structuredDataset,
      registryVersion: z.string().min(1).optional().describe("Optional registry version."),
      select: z.array(z.string().min(1)).optional().describe("Optional selected field names."),
      filter: structuredFilter.optional().describe("Optional controlled filter tree."),
      sort: z
        .array(
          z.object({
            field: z.string().min(1),
            direction: z.enum(["asc", "desc"]).default("asc")
          })
        )
        .optional()
        .describe("Optional controlled sort fields."),
      page: z
        .object({
          limit: z.number().int().min(1).optional(),
          cursor: z.string().nullable().optional()
        })
        .optional()
        .describe("Optional page limit and cursor."),
      groupBy: z.array(z.string().min(1)).optional().describe("Optional aggregate group-by field."),
      aggregates: z
        .array(
          z.object({
            op: z.enum(["count", "countDistinct", "sum", "avg", "min", "max"]),
            field: z.string().min(1).optional(),
            as: z.string().min(1).optional()
          })
        )
        .optional()
        .describe("Optional explicit mechanical aggregations.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "dataset", required: true, description: "`dishes` or `business`." },
      { name: "registryVersion", required: false, description: "Optional registry version." },
      { name: "select", required: false, description: "Selected field names." },
      { name: "filter", required: false, description: "Controlled filter tree." },
      { name: "sort", required: false, description: "Controlled sort fields." },
      { name: "page", required: false, description: "Page limit/cursor." },
      { name: "groupBy", required: false, description: "Aggregate group-by fields." },
      { name: "aggregates", required: false, description: "Explicit mechanical aggregations." }
    ],
    resultShape: ["dataset", "registryVersion", "mode", "rows[]", "nextCursor"]
  },
  {
    name: "upload_structured_dataset",
    title: "Upload Enterprise Hub structured dataset",
    description:
      "Upload XLSX/CSV structured data by calling authenticated multipart POST /v1/structured/imports.",
    inputSchema: {
      sessionName: optionalSessionName,
      filePath: z.string().min(1).describe("Local XLSX/CSV file path visible to MCP server."),
      dataset: structuredDataset,
      enterpriseName: z.string().min(1).describe("Enterprise/source name for canonical naming."),
      startDate: z
        .string()
        .regex(/^\d{8}$/)
        .describe("YYYYMMDD business window start."),
      endDate: z
        .string()
        .regex(/^\d{8}$/)
        .describe("YYYYMMDD business window end."),
      idempotencyKey: z.string().min(1).describe("Client-generated retry/idempotency key."),
      labelKeys: z
        .array(z.string().min(1))
        .min(1)
        .describe("Explicit existing label keys/visibility for rows and source document.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "filePath", required: true, description: "Local XLSX/CSV file path." },
      { name: "dataset", required: true, description: "`dishes` or `business`." },
      { name: "enterpriseName", required: true, description: "Enterprise/source name." },
      { name: "startDate", required: true, description: "YYYYMMDD business window start." },
      { name: "endDate", required: true, description: "YYYYMMDD business window end." },
      { name: "idempotencyKey", required: true, description: "Retry/idempotency key." },
      { name: "labelKeys", required: true, description: "Explicit existing label keys." }
    ],
    resultShape: ["document", "processing", "importBatch"]
  },
  {
    name: "upload_evidence_document",
    title: "Upload Enterprise Hub evidence document",
    description:
      "Upload MD/TXT/DOCX evidence by calling authenticated multipart POST /v1/documents/evidence.",
    inputSchema: {
      sessionName: optionalSessionName,
      filePath: z.string().min(1).describe("Local MD/TXT/DOCX file path visible to MCP server."),
      title: z.string().min(1).describe("Evidence source title."),
      sourceSystem: z.string().min(1).optional().describe("Optional source system."),
      labelKeys: z
        .array(z.string().min(1))
        .min(1)
        .describe("Explicit existing label keys/visibility for the evidence document.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "filePath", required: true, description: "Local MD/TXT/DOCX file path." },
      { name: "title", required: true, description: "Evidence source title." },
      { name: "sourceSystem", required: false, description: "Optional source system." },
      { name: "labelKeys", required: true, description: "Explicit existing label keys." }
    ],
    resultShape: ["document", "processing", "documentIndex"]
  },
  {
    name: "get_import_status",
    title: "Get Enterprise Hub structured import status",
    description:
      "Read structured import status by calling authenticated GET /v1/structured/imports/:importBatchId.",
    inputSchema: {
      sessionName: optionalSessionName,
      importBatchId: z.string().min(1).describe("Structured import batch id.")
    },
    inputFields: [
      { name: "sessionName", required: false, description: "Local authenticated session name." },
      { name: "importBatchId", required: true, description: "Structured import batch id." }
    ],
    resultShape: ["importBatch"]
  }
];

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

export function plannedToolResult(toolName: string): McpJsonToolResult {
  return jsonToolResult(
    {
      error: {
        code: "TOOL_NOT_IMPLEMENTED",
        message: `${toolName} is defined in the Phase 2 Day 1 contract; its body is implemented in a later Phase 2 day.`
      }
    },
    true
  );
}

export function sessionRequiredToolResult(): McpJsonToolResult {
  return jsonToolResult(
    {
      error: {
        code: "MCP_SESSION_REQUIRED",
        message:
          "Run enterprise_hub_login_dev first or pass sessionName for an existing local MCP session."
      }
    },
    true
  );
}

export function apiErrorToolResult(body: unknown): McpJsonToolResult {
  if (isApiErrorBody(body)) {
    return jsonToolResult(body, true);
  }

  return jsonToolResult(
    {
      error: {
        code: "ENTERPRISE_HUB_API_ERROR",
        message: "Enterprise Hub API request failed."
      }
    },
    true
  );
}

function isApiErrorBody(body: unknown): body is { error: { code: string; message: string } } {
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
