import { describe, expect, it } from "vitest";
import { createPartitionObjectKey, createPartitionStagingObjectKey } from "./object-key.js";

describe("partition object keys", () => {
  it("uses opaque organization, job, and partition identifiers", () => {
    expect(createPartitionStagingObjectKey({ orgId: "org_1", jobId: "pjob_1" })).toBe(
      "structured-import-staging/org_1/pjob_1/source"
    );
    expect(
      createPartitionObjectKey({ orgId: "org_1", jobId: "pjob_1", partitionId: "part_1" })
    ).toBe("structured-partitions/org_1/pjob_1/part_1.csv");
  });

  it("rejects names and path traversal in opaque identifiers", () => {
    expect(() => createPartitionStagingObjectKey({ orgId: "../org", jobId: "pjob_1" })).toThrow(
      "unsafe"
    );
  });
});

it("cost-card candidate keys are run-owned immutable and reject path segments", async () => {
  const storage = await import("./object-key.js");
  const first = storage.createCostCardObjectKey({
    orgId: "org",
    runId: "run",
    attemptNumber: 1,
    candidateId: "candidate"
  });
  expect(first).toBe("cost-cards/org/run/1/candidate.csv");
  expect(
    storage.createCostCardObjectKey({
      orgId: "org",
      runId: "run",
      attemptNumber: 2,
      candidateId: "candidate"
    })
  ).not.toBe(first);
  expect(() =>
    storage.createCostCardObjectKey({
      orgId: "../org",
      runId: "run",
      attemptNumber: 1,
      candidateId: "candidate"
    })
  ).toThrow(/unsafe/);
});
