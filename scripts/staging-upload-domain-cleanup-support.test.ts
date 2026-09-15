import { describe, expect, it } from "vitest";
import {
  CLEANUP_CONFIRMATION,
  buildStagingUploadDomainCleanupPlan,
  parseStagingUploadDomainCleanupArgs
} from "./staging-upload-domain-cleanup-support.js";

const inventory = {
  documentIds: ["doc-2", "doc-1"],
  processingRunIds: ["run-1"],
  documentChunkIds: ["chunk-1"],
  documentIndexIds: ["index-1"],
  importBatchIds: ["batch-1"],
  importWindowClaimIds: ["claim-1"],
  structuredPartitionIds: ["dish-1"],
  partitionImportJobIds: ["business-1"],
  storageGarbageIds: ["garbage-1"],
  quarantineCertificateIds: ["certificate-1"],
  vipRowIds: ["vip-1"],
  dishCatalogRowIds: ["catalog-1"],
  uploadAuditLogIds: ["audit-1"],
  storageObjectKeys: ["uploads/doc-1.csv"],
  qdrantPoints: [{ collection: "evidence", pointId: "point-1" }]
};

describe("staging upload-domain cleanup support", () => {
  it("defaults command parsing to dry-run", () => {
    expect(parseStagingUploadDomainCleanupArgs([])).toMatchObject({ dryRun: true });
  });

  it("requires an explicit staging target even for a dry-run plan", () => {
    expect(() =>
      buildStagingUploadDomainCleanupPlan({
        options: parseStagingUploadDomainCleanupArgs([]),
        inventory
      })
    ).toThrow("--target staging");
  });

  it("requires the exact confirmation before building an executable plan", () => {
    expect(() =>
      buildStagingUploadDomainCleanupPlan({
        options: { dryRun: false, target: "staging", confirmation: "yes" },
        inventory
      })
    ).toThrow(`--confirm ${CLEANUP_CONFIRMATION}`);
  });

  it("builds a dry-run plan from exact identifiers without exposing object keys in its log", () => {
    const plan = buildStagingUploadDomainCleanupPlan({
      options: { dryRun: true, target: "staging", confirmation: undefined },
      inventory
    });

    expect(plan.mode).toBe("dry-run");
    expect(plan.documentIds).toEqual(["doc-1", "doc-2"]);
    expect(plan.qdrantPoints).toEqual([{ collection: "evidence", pointId: "point-1" }]);
    expect(plan.safeLog).toEqual(
      expect.objectContaining({
        mode: "dry-run",
        documentIds: ["doc-1", "doc-2"],
        counts: expect.objectContaining({ storageObjects: 1, qdrantPoints: 1 })
      })
    );
    expect(JSON.stringify(plan.safeLog)).not.toContain("uploads/doc-1.csv");
  });

  it("rejects duplicate exact targets so deletion requests stay unambiguous", () => {
    expect(() =>
      buildStagingUploadDomainCleanupPlan({
        options: { dryRun: true, target: "staging", confirmation: undefined },
        inventory: { ...inventory, documentIds: ["doc-1", "doc-1"] }
      })
    ).toThrow("duplicate document ID");
  });

  it.each([
    [{ collection: "", pointId: "point-1" }, "Qdrant collection"],
    [{ collection: "evidence", pointId: "" }, "Qdrant point ID"]
  ])("rejects an empty %s target component", (qdrantPoint, expectedError) => {
    expect(() =>
      buildStagingUploadDomainCleanupPlan({
        options: { dryRun: true, target: "staging", confirmation: undefined },
        inventory: { ...inventory, qdrantPoints: [qdrantPoint] }
      })
    ).toThrow(expectedError);
  });

  it("allows separate exact points in the same Qdrant collection", () => {
    expect(() =>
      buildStagingUploadDomainCleanupPlan({
        options: { dryRun: true, target: "staging", confirmation: undefined },
        inventory: {
          ...inventory,
          qdrantPoints: [
            { collection: "evidence", pointId: "point-1" },
            { collection: "evidence", pointId: "point-2" }
          ]
        }
      })
    ).not.toThrow();
  });

  it("preserves identity, authorization, skill, retrieval, and auth audit records", () => {
    const plan = buildStagingUploadDomainCleanupPlan({
      options: { dryRun: false, target: "staging", confirmation: CLEANUP_CONFIRMATION },
      inventory
    });

    expect(plan.mode).toBe("execute");
    expect(plan.deletionTargets).toEqual([
      "Qdrant points by exact collection/point identifier",
      "OSS objects by exact database-recorded key",
      "related upload audit events",
      "ProcessingRun",
      "DocumentChunk",
      "DocumentIndex",
      "ImportWindowClaim",
      "PartitionImportJob",
      "StructuredPartition",
      "StorageGarbage",
      "QuarantineCertificate",
      "VipRow",
      "DishCatalogRow",
      "ImportBatch",
      "Document"
    ]);
    expect(plan.preservedDomains).toEqual([
      "Organization",
      "Employee",
      "login identity and authorization records",
      "SkillEntry",
      "RetrievalConfig",
      "auth audit"
    ]);
  });
});
