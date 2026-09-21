import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SourceDocumentDownloadIssuer } from "../source-document-downloads.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse, validationError } from "../request-errors.js";

export function registerSourceDocumentRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    sourceDocumentDownloads: () => SourceDocumentDownloadIssuer;
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
      const issued = await dependencies.sourceDocumentDownloads().issueMany({
        orgId: employee.orgId,
        employee,
        requestedSources: [{ sourceDocumentId, documentTitle: null }],
        audit: dependencies.createBusinessRequestAudit(request),
        reason: "explicit_request"
      });
      const sourceDocument = issued.sources[0];
      if (!sourceDocument || sourceDocument.downloadStatus !== "available") {
        return reply
          .code(404)
          .send(errorResponse("SOURCE_DOCUMENT_NOT_FOUND", "Source document not found."));
      }

      return {
        sourceDocumentId,
        downloadUrl: sourceDocument.downloadUrl,
        expiresAt: sourceDocument.expiresAt,
        originalFileName: sourceDocument.originalFileName,
        contentType: sourceDocument.contentType,
        byteSize: sourceDocument.byteSize
      };
    }
  );
}
