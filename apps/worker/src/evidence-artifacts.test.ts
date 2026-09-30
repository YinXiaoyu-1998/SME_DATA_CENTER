import { describe, expect, it } from "vitest";
import {
  reconcilePdfEvidenceAttempt,
  type PdfEvidenceAttempt,
  type PdfEvidenceAttemptRepository
} from "./evidence-artifacts.js";

const attempt: PdfEvidenceAttempt = {
  id: "attempt_1",
  orgId: "org_1",
  documentId: "doc_1",
  runId: "run_1",
  attemptNumber: 1,
  contentVersion: 1,
  retrievalConfigVersion: "v1",
  parserFingerprint: "fp",
  generation: "g1",
  collection: "collection",
  pointIds: ["p1"],
  parsedObjectKey: "owned/attempt_1.json",
  state: "staged"
};
function harness(ownership: "owned" | "cleanup" | "live" = "cleanup") {
  const deleted: string[] = [];
  let finished = false;
  const repository: PdfEvidenceAttemptRepository = {
    async stage() {},
    async listRecoverable() {
      return [attempt];
    },
    async claimCleanup() {
      return ownership;
    },
    async finishCleanup() {
      finished = true;
    }
  };
  return {
    repository,
    deleted,
    get finished() {
      return finished;
    },
    storage: {
      async deleteObject(key: string) {
        deleted.push(key);
      }
    },
    writer: {
      async deleteEvidencePoints(input: { collection: string; pointIds: string[] }) {
        deleted.push(...input.pointIds);
      }
    }
  };
}
describe("PDF candidate artifact recovery", () => {
  it("cleans only recorded candidate IDs and its object", async () => {
    const h = harness();
    await reconcilePdfEvidenceAttempt({
      attempt,
      repository: h.repository,
      storage: h.storage,
      qdrantWriter: h.writer
    });
    expect(h.deleted).toEqual(["p1", "owned/attempt_1.json"]);
    expect(h.finished).toBe(true);
  });
  it.each(["owned", "live"] as const)("preserves %s candidates", async (ownership) => {
    const h = harness(ownership);
    expect(
      await reconcilePdfEvidenceAttempt({
        attempt,
        repository: h.repository,
        storage: h.storage,
        qdrantWriter: h.writer
      })
    ).toBe(ownership);
    expect(h.deleted).toEqual([]);
  });
  it("preserves manifest when DB commit ownership is unknown", async () => {
    const h = harness();
    h.repository.claimCleanup = async () => {
      throw new Error("DB unavailable");
    };
    await expect(
      reconcilePdfEvidenceAttempt({
        attempt,
        repository: h.repository,
        storage: h.storage,
        qdrantWriter: h.writer
      })
    ).rejects.toThrow("DB unavailable");
    expect(h.deleted).toEqual([]);
    expect(h.finished).toBe(false);
  });
  it("keeps manifest on failed cleanup and retries idempotently", async () => {
    const h = harness();
    let failures = 1;
    h.storage.deleteObject = async (key) => {
      if (failures--) throw new Error("object unavailable");
      h.deleted.push(key);
    };
    await expect(
      reconcilePdfEvidenceAttempt({
        attempt,
        repository: h.repository,
        storage: h.storage,
        qdrantWriter: h.writer
      })
    ).rejects.toThrow("object unavailable");
    expect(h.finished).toBe(false);
    await reconcilePdfEvidenceAttempt({
      attempt,
      repository: h.repository,
      storage: h.storage,
      qdrantWriter: h.writer
    });
    expect(h.finished).toBe(true);
  });
});
