import { describe, expect, it } from "vitest";
import {
  assertReindexTargetMatchesRuntime,
  buildEvidenceReindexJobKey,
  buildEvidenceReindexPlan
} from "./reindex-evidence-support.js";

const target = {
  targetRetrievalConfigVersion: "phase3.retrieval.v2-bm25",
  targetCollection: "smedc_evidence_local_v2"
};

describe("evidence reindex planning", () => {
  it("selects only active, non-archived evidence in stable order", () => {
    const plan = buildEvidenceReindexPlan({
      ...target,
      documents: [
        document("doc_z", { orgId: "org_b" }),
        document("doc_b", { orgId: "org_a" }),
        document("doc_a", { orgId: "org_a" }),
        document("doc_archived", { archivedAt: new Date("2026-01-01") }),
        document("doc_inactive", { status: "processing_failed" }),
        document("doc_structured", { documentKind: "structured" })
      ],
      existingTargetIndexes: []
    });

    expect(plan.jobs.map((job) => job.documentId)).toEqual(["doc_a", "doc_b", "doc_z"]);
    expect(plan.excludedDocumentCount).toBe(3);
  });

  it("uses exact versioned job keys and skips existing target indexes", () => {
    const plan = buildEvidenceReindexPlan({
      ...target,
      documents: [document("doc_2", { contentVersion: 3 }), document("doc_1")],
      existingTargetIndexes: [
        {
          documentId: "doc_1",
          contentVersion: 1,
          retrievalConfigVersion: target.targetRetrievalConfigVersion
        }
      ]
    });

    expect(plan.jobs).toEqual([
      {
        orgId: "org_1",
        documentId: "doc_2",
        contentVersion: 3,
        targetRetrievalConfigVersion: target.targetRetrievalConfigVersion,
        targetCollection: target.targetCollection,
        jobKey: "evidence_document_index:doc_2:3:phase3.retrieval.v2-bm25"
      }
    ]);
    expect(plan.existingTargetIndexCount).toBe(1);
    expect(buildEvidenceReindexJobKey("doc_2", 3, target.targetRetrievalConfigVersion)).toBe(
      "evidence_document_index:doc_2:3:phase3.retrieval.v2-bm25"
    );
  });

  it("produces zero jobs on exact replay after target indexes exist", () => {
    const documents = [document("doc_1"), document("doc_2")];
    const plan = buildEvidenceReindexPlan({
      ...target,
      documents,
      existingTargetIndexes: documents.map((item) => ({
        documentId: item.id,
        contentVersion: item.contentVersion,
        retrievalConfigVersion: target.targetRetrievalConfigVersion
      }))
    });

    expect(plan.jobs).toEqual([]);
    expect(plan.existingTargetIndexCount).toBe(2);
  });

  it("rejects an execute target that differs from worker runtime", () => {
    expect(() =>
      assertReindexTargetMatchesRuntime({
        ...target,
        runtimeRetrievalConfigVersion: "phase3.retrieval.v1",
        runtimeCollection: "smedc_evidence_local"
      })
    ).toThrow(/target.*runtime/i);
    expect(() =>
      assertReindexTargetMatchesRuntime({
        ...target,
        runtimeRetrievalConfigVersion: target.targetRetrievalConfigVersion,
        runtimeCollection: "smedc_evidence_wrong"
      })
    ).toThrow(/target.*runtime/i);
  });
});

function document(
  id: string,
  overrides: Partial<{
    orgId: string;
    contentVersion: number;
    status: string;
    documentKind: string | null;
    archivedAt: Date | null;
  }> = {}
) {
  return {
    id,
    orgId: "org_1",
    contentVersion: 1,
    status: "active",
    documentKind: "evidence",
    archivedAt: null,
    ...overrides
  };
}
