import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EnterpriseHubApiError, type EnterpriseHubApiClient } from "./api-client.js";
import { apiErrorToolResult, jsonToolResult, type McpJsonToolResult } from "./tools.js";
import type { McpEmployeeSession } from "./session-store.js";

const documentTypeSchema = z.enum([
  "raw_material",
  "structured_dataset",
  "analysis_artifact",
  "business_event",
  "management_knowledge"
]);

const listLabelsInputSchema = z.object({
  sessionName: z.string().min(1).optional()
});

const uploadDocumentInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  filePath: z.string().min(1),
  title: z.string().min(1),
  documentType: documentTypeSchema,
  sourceSystem: z.string().min(1).optional(),
  sourceTime: z.string().datetime().optional(),
  labelKeys: z.array(z.string().min(1)).default([])
});

const documentIdInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  documentId: z.string().min(1)
});

const searchDocumentsInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  q: z.string().optional(),
  documentType: documentTypeSchema.optional(),
  labelKey: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().optional()
});

const listSkillsInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  q: z.string().optional(),
  category: z.string().min(1).optional()
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
      case "enterprise_hub_upload_document":
        return uploadDocument(input, session, apiClient);
      case "enterprise_hub_get_document_status":
        return jsonToolResult(await getDocumentStatus(input, session, apiClient));
      case "enterprise_hub_search_documents":
        return jsonToolResult(await searchDocuments(input, session, apiClient));
      case "enterprise_hub_get_document":
        return jsonToolResult(await getDocument(input, session, apiClient));
      case "enterprise_hub_get_document_download_url":
        return jsonToolResult(await getDocumentDownloadUrl(input, session, apiClient));
      case "enterprise_hub_archive_document":
        return jsonToolResult(await archiveDocument(input, session, apiClient));
      case "enterprise_hub_list_skills":
        return jsonToolResult(await listSkills(input, session, apiClient));
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

async function uploadDocument(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<McpJsonToolResult> {
  const parsedInput = uploadDocumentInputSchema.parse(input);
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
  formData.append("documentType", parsedInput.documentType);

  if (parsedInput.sourceSystem) {
    formData.append("sourceSystem", parsedInput.sourceSystem);
  }

  if (parsedInput.sourceTime) {
    formData.append("sourceTime", parsedInput.sourceTime);
  }

  for (const labelKey of parsedInput.labelKeys) {
    formData.append("labelKeys[]", labelKey);
  }

  return jsonToolResult(
    await apiClient.requestJson({
      method: "POST",
      path: "/documents",
      accessToken: session.accessToken,
      body: formData
    })
  );
}

async function getDocumentStatus(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = documentIdInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: `/documents/${encodeURIComponent(parsedInput.documentId)}/status`,
    accessToken: session.accessToken
  });
}

async function searchDocuments(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = searchDocumentsInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: "/documents",
    accessToken: session.accessToken,
    query: {
      q: parsedInput.q,
      documentType: parsedInput.documentType,
      labelKey: parsedInput.labelKey,
      limit: parsedInput.limit,
      cursor: parsedInput.cursor
    }
  });
}

async function getDocument(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = documentIdInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: `/documents/${encodeURIComponent(parsedInput.documentId)}`,
    accessToken: session.accessToken
  });
}

async function getDocumentDownloadUrl(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = documentIdInputSchema.parse(input);

  return apiClient.requestJson({
    method: "GET",
    path: `/documents/${encodeURIComponent(parsedInput.documentId)}/download`,
    accessToken: session.accessToken
  });
}

async function archiveDocument(
  input: unknown,
  session: McpEmployeeSession,
  apiClient: EnterpriseHubApiClient
): Promise<unknown> {
  const parsedInput = documentIdInputSchema.parse(input);

  return apiClient.requestJson({
    method: "POST",
    path: `/documents/${encodeURIComponent(parsedInput.documentId)}/archive`,
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
