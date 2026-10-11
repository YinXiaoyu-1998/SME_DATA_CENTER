import type { AuthorizationSnapshot, AuthenticatedEmployee } from "@smedc/domain";
import type { StorageAdapter } from "@smedc/storage";
import type { RequestAuditContext } from "./request-audit-context.js";
import {
  SOURCE_DOCUMENT_DOWNLOAD_EXPIRES_SECONDS,
  type SourceDocumentRecord
} from "./source-documents.js";

export interface EvidenceSourceDownload {
  sourceDocumentId: string;
  documentTitle: string;
  originalFileName: string | null;
  contentType: string | null;
  byteSize: number | null;
  downloadStatus: "available" | "unavailable";
  downloadUrl: string | null;
  expiresAt: string | null;
}

export interface SourceDocumentDownloadRepository {
  findDownloadableSourceDocuments(input: {
    orgId: string;
    employee: AuthenticatedEmployee;
    authorization?: AuthorizationSnapshot;
    sourceDocumentIds: readonly string[];
  }): Promise<SourceDocumentRecord[]>;
  recordDownloadsIssued(input: {
    authorizationVersion?: string;
    orgId: string;
    employee: AuthenticatedEmployee;
    sourceDocumentIds: readonly string[];
    audit: RequestAuditContext;
    reason: "explicit_request" | "evidence_search_auto";
  }): Promise<void>;
}

export interface SourceDocumentDownloadIssuer {
  issueMany(input: {
    orgId: string;
    employee: AuthenticatedEmployee;
    authorization?: AuthorizationSnapshot;
    requestedSources: readonly {
      sourceDocumentId: string;
      documentTitle: string | null;
    }[];
    audit: RequestAuditContext;
    reason: "explicit_request" | "evidence_search_auto";
  }): Promise<{ sources: EvidenceSourceDownload[]; warnings: string[] }>;
}

export function createSourceDocumentDownloadIssuer(input: {
  repository: SourceDocumentDownloadRepository;
  storage: StorageAdapter;
  now?: () => Date;
  ledgerPdfDeliveryEnabled?: boolean;
}): SourceDocumentDownloadIssuer {
  return {
    async issueMany(request) {
      const requestedSources = dedupeRequestedSources(request.requestedSources);
      if (requestedSources.length > 50) {
        throw new Error("Source document download issuance is limited to 50 documents.");
      }
      if (requestedSources.length === 0) return { sources: [], warnings: [] };

      const authorized = request.employee.disabled
        ? []
        : await input.repository.findDownloadableSourceDocuments({
            orgId: request.orgId,
            employee: request.employee,
            ...(request.authorization ? { authorization: request.authorization } : {}),
            sourceDocumentIds: requestedSources.map((source) => source.sourceDocumentId)
          });
      const authorizedById = new Map(
        authorized
          .filter(
            (document) =>
              document.importDataset !== undefined &&
              document.importDataset !== "delivery_ledger" &&
              (request.reason !== "evidence_search_auto" || document.status === "active")
          )
          .map((document) => [document.sourceDocumentId, document])
      );
      if (
        request.reason === "explicit_request" &&
        requestedSources.some((source) => !authorizedById.has(source.sourceDocumentId))
      )
        return {
          sources: requestedSources.map(unavailableSource),
          warnings: ["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]
        };
      const expiresAt = new Date(
        (input.now?.() ?? new Date()).getTime() + SOURCE_DOCUMENT_DOWNLOAD_EXPIRES_SECONDS * 1000
      ).toISOString();
      if (request.reason === "explicit_request") {
        const preflight = await Promise.allSettled(
          requestedSources.map((requested) =>
            input.storage.statObject(
              authorizedById.get(requested.sourceDocumentId)!.storageObjectKey
            )
          )
        );
        if (preflight.some((result) => result.status === "rejected"))
          return {
            sources: requestedSources.map(unavailableSource),
            warnings: ["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]
          };
      }
      const settled = await Promise.allSettled(
        requestedSources.map(async (requested): Promise<EvidenceSourceDownload> => {
          const document = authorizedById.get(requested.sourceDocumentId);
          if (!document) return unavailableSource(requested);

          await input.storage.statObject(document.storageObjectKey);
          const downloadUrl = await input.storage.createDownloadUrl(document.storageObjectKey, {
            expiresInSeconds: SOURCE_DOCUMENT_DOWNLOAD_EXPIRES_SECONDS,
            downloadFileName: document.originalFileName ?? undefined
          });
          return {
            sourceDocumentId: requested.sourceDocumentId,
            documentTitle: requested.documentTitle ?? requested.sourceDocumentId,
            originalFileName: document.originalFileName,
            contentType: document.contentType,
            byteSize: document.byteSize,
            downloadStatus: "available",
            downloadUrl,
            expiresAt
          };
        })
      );
      const sources = settled.map((result, index) =>
        result.status === "fulfilled" ? result.value : unavailableSource(requestedSources[index]!)
      );
      if (
        request.reason === "explicit_request" &&
        sources.some((source) => source.downloadStatus !== "available")
      )
        return {
          sources: requestedSources.map(unavailableSource),
          warnings: ["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]
        };
      const issuedIds = sources
        .filter((source) => source.downloadStatus === "available")
        .map((source) => source.sourceDocumentId);

      if (issuedIds.length > 0) {
        try {
          await input.repository.recordDownloadsIssued({
            orgId: request.orgId,
            employee: request.employee,
            ...(authorized[0]?.authorizationVersion !== undefined
              ? { authorizationVersion: authorized[0].authorizationVersion }
              : {}),
            sourceDocumentIds: issuedIds,
            audit: request.audit,
            reason: request.reason
          });
        } catch {
          const issuedIdSet = new Set(issuedIds);
          for (let index = 0; index < sources.length; index += 1) {
            const source = sources[index];
            const requested = requestedSources[index];
            if (source && requested && issuedIdSet.has(source.sourceDocumentId)) {
              sources[index] = unavailableSource(requested);
            }
          }
        }
      }

      return {
        sources,
        warnings: sources.some((source) => source.downloadStatus === "unavailable")
          ? ["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]
          : []
      };
    }
  };
}

function dedupeRequestedSources(
  sources: readonly { sourceDocumentId: string; documentTitle: string | null }[]
) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.sourceDocumentId)) return false;
    seen.add(source.sourceDocumentId);
    return true;
  });
}

function unavailableSource(source: {
  sourceDocumentId: string;
  documentTitle: string | null;
}): EvidenceSourceDownload {
  return {
    sourceDocumentId: source.sourceDocumentId,
    documentTitle: source.documentTitle ?? source.sourceDocumentId,
    originalFileName: null,
    contentType: null,
    byteSize: null,
    downloadStatus: "unavailable",
    downloadUrl: null,
    expiresAt: null
  };
}
