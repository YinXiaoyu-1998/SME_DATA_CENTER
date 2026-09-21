export interface EvidenceReindexSourceDocument {
  id: string;
  orgId: string;
  contentVersion: number;
  status: string;
  documentKind: string | null;
  archivedAt: Date | null;
}

export interface EvidenceTargetIndex {
  documentId: string;
  contentVersion: number;
  retrievalConfigVersion: string;
}

export interface EvidenceReindexJob {
  orgId: string;
  documentId: string;
  contentVersion: number;
  targetRetrievalConfigVersion: string;
  targetCollection: string;
  jobKey: string;
}

export function buildEvidenceReindexJobKey(
  documentId: string,
  contentVersion: number,
  targetRetrievalConfigVersion: string
): string {
  return `evidence_document_index:${documentId}:${contentVersion}:${targetRetrievalConfigVersion}`;
}

export function buildEvidenceReindexPlan(input: {
  documents: readonly EvidenceReindexSourceDocument[];
  existingTargetIndexes: readonly EvidenceTargetIndex[];
  targetRetrievalConfigVersion: string;
  targetCollection: string;
}): {
  jobs: EvidenceReindexJob[];
  eligibleDocumentCount: number;
  excludedDocumentCount: number;
  existingTargetIndexCount: number;
} {
  const eligible = input.documents
    .filter(
      (document) =>
        document.status === "active" &&
        document.documentKind === "evidence" &&
        document.archivedAt === null
    )
    .sort(
      (left, right) => left.orgId.localeCompare(right.orgId) || left.id.localeCompare(right.id)
    );
  const existing = new Set(
    input.existingTargetIndexes
      .filter((index) => index.retrievalConfigVersion === input.targetRetrievalConfigVersion)
      .map((index) => `${index.documentId}:${index.contentVersion}`)
  );
  const jobs = eligible.flatMap((document) =>
    existing.has(`${document.id}:${document.contentVersion}`)
      ? []
      : [
          {
            orgId: document.orgId,
            documentId: document.id,
            contentVersion: document.contentVersion,
            targetRetrievalConfigVersion: input.targetRetrievalConfigVersion,
            targetCollection: input.targetCollection,
            jobKey: buildEvidenceReindexJobKey(
              document.id,
              document.contentVersion,
              input.targetRetrievalConfigVersion
            )
          }
        ]
  );

  return {
    jobs,
    eligibleDocumentCount: eligible.length,
    excludedDocumentCount: input.documents.length - eligible.length,
    existingTargetIndexCount: eligible.length - jobs.length
  };
}

export function assertReindexTargetMatchesRuntime(input: {
  targetRetrievalConfigVersion: string;
  targetCollection: string;
  runtimeRetrievalConfigVersion: string;
  runtimeCollection: string;
}): void {
  if (
    input.targetRetrievalConfigVersion !== input.runtimeRetrievalConfigVersion ||
    input.targetCollection !== input.runtimeCollection
  ) {
    throw new Error(
      `Evidence reindex target ${input.targetRetrievalConfigVersion}/${input.targetCollection} does not match worker runtime ${input.runtimeRetrievalConfigVersion}/${input.runtimeCollection}.`
    );
  }
}
