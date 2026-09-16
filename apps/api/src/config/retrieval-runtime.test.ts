import { describe, expect, it } from "vitest";
import { parseApiRetrievalRuntimeConfig } from "./retrieval-runtime.js";

describe("API retrieval runtime config", () => {
  it("uses the shared Phase 3 Qdrant and fake-provider defaults", () => {
    const config = parseApiRetrievalRuntimeConfig({});

    expect(config.qdrant.collectionName).toBe("smedc_evidence_local");
    expect(config.modelProvider.provider).toBe("fake");
  });
});
