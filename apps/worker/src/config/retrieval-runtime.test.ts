import { describe, expect, it } from "vitest";
import { parseWorkerRetrievalRuntimeConfig } from "./retrieval-runtime.js";

describe("worker retrieval runtime config", () => {
  it("uses the shared Phase 3 Qdrant and fake-provider defaults", () => {
    const config = parseWorkerRetrievalRuntimeConfig({});

    expect(config.qdrant.retrievalConfigVersion).toBe("phase3.retrieval.v1");
    expect(config.modelProvider.embeddingModel).toBe("fake-embedding");
  });
});
