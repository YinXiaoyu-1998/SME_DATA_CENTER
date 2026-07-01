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
  }
];

export function plannedToolResult(toolName: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: {
              code: "TOOL_NOT_IMPLEMENTED",
              message: `${toolName} is defined in the Phase 2 Day 1 contract; its body is implemented in a later Phase 2 day.`
            }
          },
          null,
          2
        )
      }
    ],
    isError: true
  };
}
