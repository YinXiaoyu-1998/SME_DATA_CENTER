import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { cleanupRun, runConfig } from "./official-manual-acceptance.js";

it("rejects another uploader's explicit cleanup IDs before deleting any data", async () => {
  const run = runConfig("cleanup-scope", {
    reuseSession: "qa@example.invalid",
    documentIds: ["doc_other_owner"],
    partitionJobIds: []
  });
  run.reusedEmployeeId = "emp_qa";
  const findDocuments = vi.fn();
  const prisma = {
    loginIdentity: { findMany: vi.fn().mockResolvedValue([]) },
    document: { count: vi.fn().mockResolvedValue(1), findMany: findDocuments },
    partitionImportJob: { count: vi.fn().mockResolvedValue(0) },
    ledgerArtifactRequest: { count: vi.fn().mockResolvedValue(0) }
  };
  await expect(cleanupRun(prisma as unknown as PrismaClient, run)).rejects.toThrow(
    "Cleanup IDs do not belong to the selected QA account"
  );
  expect(findDocuments).not.toHaveBeenCalled();
});
