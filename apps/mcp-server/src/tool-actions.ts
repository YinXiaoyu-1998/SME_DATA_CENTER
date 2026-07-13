import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EnterpriseHubApiError, type EnterpriseHubApiClient } from "./api-client.js";
import { apiErrorToolResult, jsonToolResult, type McpJsonToolResult } from "./tools.js";
import type { McpEmployeeSession } from "./session-store.js";

const evidenceFileTypeSchema = z.enum(["md", "txt", "docx"]);
const structuredDatasetSchema = z.enum(["dishes", "business"]);
const scalarStructuredValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const structuredFilterSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({
      field: z.string().min(1),
      op: z.string().min(1),
      value: z.union([scalarStructuredValueSchema, z.array(scalarStructuredValueSchema)])
    }),
    z.object({ and: z.array(structuredFilterSchema).min(1) }),
    z.object({ or: z.array(structuredFilterSchema).min(1) }),
    z.object({ not: structuredFilterSchema })
  ])
);

const listLabelsInputSchema = z.object({
  sessionName: z.string().min(1).optional()
});

const documentIdInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  documentId: z.string().min(1)
});

const listSkillsInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  q: z.string().optional(),
  category: z.string().min(1).optional()
});

const searchDocumentEvidenceInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  query: z.string().min(1),
  filters: z
    .object({
      fileTypes: z.array(evidenceFileTypeSchema).optional(),
      documentIds: z.array(z.string().min(1)).optional(),
      labelIds: z.array(z.string().min(1)).optional()
    })
    .optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().optional()
});

const listStructuredDatasetsInputSchema = z.object({
  sessionName: z.string().min(1).optional()
});

const queryStructuredDatasetInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  dataset: structuredDatasetSchema,
  registryVersion: z.string().min(1).optional(),
  select: z.array(z.string().min(1)).optional(),
  filter: structuredFilterSchema.optional(),
  sort: z
    .array(
      z.object({
        field: z.string().min(1),
        direction: z.enum(["asc", "desc"]).default("asc")
      })
    )
    .optional(),
  page: z
    .object({
      limit: z.number().int().min(1).optional(),
      cursor: z.string().nullable().optional()
    })
    .optional(),
  groupBy: z.array(z.string().min(1)).optional(),
  aggregates: z
    .array(
      z.object({
        op: z.enum(["count", "countDistinct", "sum", "avg", "min", "max"]),
        field: z.string().min(1).optional(),
        as: z.string().min(1).optional()
      })
    )
    .optional()
});

const uploadStructuredDatasetInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  filePath: z.string().min(1),
  dataset: structuredDatasetSchema,
  enterpriseName: z.string().min(1),
  startDate: z.string().regex(/^\d{8}$/),
  endDate: z.string().regex(/^\d{8}$/),
  idempotencyKey: z.string().min(1),
  labelKeys: z.array(z.string().min(1)).min(1)
});

const uploadEvidenceDocumentInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  filePath: z.string().min(1),
  title: z.string().min(1),
  sourceSystem: z.string().min(1).optional(),
  labelKeys: z.array(z.string().min(1)).min(1)
});

const importStatusInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  importBatchId: z.string().min(1)
});

export async function executeAuthenticatedTool(
  toolName: string,
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<McpJsonToolResult> {
  try {
    switch (toolName) {
      case "enterprise_hub_list_labels":
        return jsonToolResult(await listLabels(input, session, apiClient));
      case "enterprise_hub_list_skills":
        return jsonToolResult(await listSkills(input, session, apiClient));
      case "search_document_evidence":
        return jsonToolResult(await searchDocumentEvidence(input, session, apiClient));
      case "list_structured_datasets":
        return jsonToolResult(await listStructuredDatasets(input, session, apiClient));
      case "query_structured_dataset":
        return jsonToolResult(await queryStructuredDataset(input, session, apiClient));
      case "upload_structured_dataset":
        return uploadStructuredDataset(input, session, apiClient);
      case "upload_evidence_document":
        return uploadEvidenceDocument(input, session, apiClient);
      case "get_evidence_document_status":
        return jsonToolResult(await getEvidenceDocumentStatus(input, session, apiClient));
      case "get_import_status":
        return jsonToolResult(await getImportStatus(input, session, apiClient));
      default:
        throw new Error(`Unknown authenticated Enterprise Hub MCP tool: ${toolName}`);
    }
  } catch (error) {
    if (error instanceof EnterpriseHubApiError) {
      return apiErrorToolResult(error.body);
    }

    throw error;
  }
}

async function listLabels(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  listLabelsInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: "/labels",
    accessToken: session.accessToken
  });
}

async function listSkills(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = listSkillsInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: "/skills",
    accessToken: session.accessToken,
    query: {
      q: parsedInput.q,
      category: parsedInput.category
    }
  });
}

async function searchDocumentEvidence(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = searchDocumentEvidenceInputSchema.parse(input);

  return apiClient.requestJson({
    method: "POST",
    path: "/v1/evidence/search",
    accessToken: session.accessToken,
    body: {
      query: parsedInput.query,
      filters: parsedInput.filters,
      limit: parsedInput.limit,
      cursor: parsedInput.cursor ?? null
    }
  });
}

async function listStructuredDatasets(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  listStructuredDatasetsInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: "/v1/structured/datasets",
    accessToken: session.accessToken
  });
}

async function queryStructuredDataset(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = queryStructuredDatasetInputSchema.parse(input);

  return apiClient.requestJson({
    method: "POST",
    path: "/v1/structured/query",
    accessToken: session.accessToken,
    body: {
      dataset: parsedInput.dataset,
      registryVersion: parsedInput.registryVersion,
      select: parsedInput.select,
      filter: parsedInput.filter,
      sort: parsedInput.sort,
      page: parsedInput.page,
      groupBy: parsedInput.groupBy,
      aggregates: parsedInput.aggregates
    }
  });
}

async function uploadStructuredDataset(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<McpJsonToolResult> {
  const parsedInput = uploadStructuredDatasetInputSchema.parse(input);
  const file = await readUploadFile(parsedInput.filePath);

  if (!file) {
    return localFileNotFoundResult();
  }

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([file.bytes as unknown as BlobPart]),
    path.basename(parsedInput.filePath)
  );
  formData.append("dataset", parsedInput.dataset);
  formData.append("enterprise_name", parsedInput.enterpriseName);
  formData.append("startDate", parsedInput.startDate);
  formData.append("endDate", parsedInput.endDate);
  formData.append("idempotencyKey", parsedInput.idempotencyKey);

  for (const labelKey of parsedInput.labelKeys) {
    formData.append("labelKeys[]", labelKey);
  }

  return jsonToolResult(
    await apiClient.requestJson({
      method: "POST",
      path: "/v1/structured/imports",
      accessToken: session.accessToken,
      body: formData
    })
  );
}

async function uploadEvidenceDocument(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<McpJsonToolResult> {
  const parsedInput = uploadEvidenceDocumentInputSchema.parse(input);
  const file = await readUploadFile(parsedInput.filePath);

  if (!file) {
    return localFileNotFoundResult();
  }

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([file.bytes as unknown as BlobPart]),
    path.basename(parsedInput.filePath)
  );
  formData.append("title", parsedInput.title);

  if (parsedInput.sourceSystem) {
    formData.append("sourceSystem", parsedInput.sourceSystem);
  }

  for (const labelKey of parsedInput.labelKeys) {
    formData.append("labelKeys[]", labelKey);
  }

  return jsonToolResult(
    await apiClient.requestJson({
      method: "POST",
      path: "/v1/documents/evidence",
      accessToken: session.accessToken,
      body: formData
    })
  );
}

async function getEvidenceDocumentStatus(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = documentIdInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: `/v1/documents/evidence/${encodeURIComponent(parsedInput.documentId)}/status`,
    accessToken: session.accessToken
  });
}

async function getImportStatus(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = importStatusInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: `/v1/structured/imports/${encodeURIComponent(parsedInput.importBatchId)}`,
    accessToken: session.accessToken
  });
}

async function readUploadFile(filePath: string): Promise<{ bytes: Buffer } | null> {
  try {
    return {
      bytes: await readFile(filePath)
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: string }).code;

      if (code === "ENOENT" || code === "EISDIR") {
        return null;
      }
    }

    throw error;
  }
}

function localFileNotFoundResult(): McpJsonToolResult {
  return jsonToolResult(
    {
      error: {
        code: "LOCAL_FILE_NOT_FOUND",
        message: "Local upload file was not found."
      }
    },
    true
  );
}
