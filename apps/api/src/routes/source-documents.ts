import type { FastifyInstance, FastifyRequest } from "fastify";
import type { StorageAdapter } from "@smedc/storage";
import {
  SOURCE_DOCUMENT_DOWNLOAD_EXPIRES_SECONDS,
  type SourceDocumentRepository
} from "../source-documents.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse, validationError } from "../request-errors.js";

export function registerSourceDocumentRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    sourceDocuments: () => SourceDocumentRepository;
    storage: () => StorageAdapter;
    createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
  }
): void {
  app.post<{ Params: { sourceDocumentId: string } }>(
    "/v1/source-documents/:sourceDocumentId/download-url",
    async (request, reply) => {
      const authenticated = await dependencies.auth.authenticate(request, reply);
      if (!authenticated) return;

      const sourceDocumentId = request.params.sourceDocumentId.trim();
      if (!sourceDocumentId) {
        return validationError(
          reply,
          "INVALID_SOURCE_DOCUMENT_ID",
          "Source document ID is invalid."
        );
      }

      const employee = dependencies.auth.employee(request);
      const sourceDocument = await dependencies.sourceDocuments().findDownloadableSourceDocument({
        orgId: employee.orgId,
        employee,
        sourceDocumentId
      });
      if (!sourceDocument) {
        return reply
          .code(404)
          .send(errorResponse("SOURCE_DOCUMENT_NOT_FOUND", "Source document not found."));
      }

      const downloadUrl = await createDownloadUrlOrNull({
        storage: dependencies.storage(),
        storageObjectKey: sourceDocument.storageObjectKey,
        originalFileName: sourceDocument.originalFileName
      });
      if (!downloadUrl) {
        return reply
          .code(404)
          .send(errorResponse("SOURCE_DOCUMENT_NOT_FOUND", "Source document not found."));
      }

      const expiresAt = new Date(
        Date.now() + SOURCE_DOCUMENT_DOWNLOAD_EXPIRES_SECONDS * 1000
      ).toISOString();
      await dependencies.sourceDocuments().recordDownloadIssued({
        orgId: employee.orgId,
        employee,
        sourceDocumentId,
        audit: dependencies.createBusinessRequestAudit(request)
      });

      return {
        sourceDocumentId,
        downloadUrl,
        expiresAt,
        originalFileName: sourceDocument.originalFileName,
        contentType: sourceDocument.contentType,
        byteSize: sourceDocument.byteSize
      };
    }
  );
}

async function createDownloadUrlOrNull(input: {
  storage: StorageAdapter;
  storageObjectKey: string;
  originalFileName: string;
}): Promise<string | null> {
  try {
    await input.storage.statObject(input.storageObjectKey);
    return await input.storage.createDownloadUrl(input.storageObjectKey, {
      expiresInSeconds: SOURCE_DOCUMENT_DOWNLOAD_EXPIRES_SECONDS,
      downloadFileName: input.originalFileName
    });
  } catch {
    return null;
  }
}
