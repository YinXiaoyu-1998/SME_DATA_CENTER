import { describe, expect, it } from "vitest";
import {
  QDRANT_BM25_OPTIONS,
  buildQdrantBm25Document,
  qdrantCollectionMatchesExpectedSchema,
  qdrantEvidenceCollectionSchema
} from "./retrieval-runtime.js";

describe("evidence retrieval runtime", () => {
  it("keeps the V1 sparse schema unchanged", () => {
    expect(qdrantEvidenceCollectionSchema(8, "phase3.retrieval.v1")).toEqual({
      vectors: { dense: { size: 8, distance: "Cosine" } },
      sparse_vectors: { sparse: { index: { on_disk: false } } }
    });
  });

  it("uses an IDF-modified BM25 sparse vector for V2", () => {
    const schema = qdrantEvidenceCollectionSchema(1536, "phase3.retrieval.v2-bm25");

    expect(schema).toEqual({
      vectors: { dense: { size: 1536, distance: "Cosine" } },
      sparse_vectors: { bm25: { index: { on_disk: false }, modifier: "idf" } }
    });
    expect(
      qdrantCollectionMatchesExpectedSchema(
        { result: { config: { params: schema } } },
        1536,
        "phase3.retrieval.v2-bm25"
      )
    ).toBe(true);
    expect(
      qdrantCollectionMatchesExpectedSchema(
        {
          result: {
            config: {
              params: {
                vectors: schema.vectors,
                sparse_vectors: { bm25: { index: { on_disk: false } } }
              }
            }
          }
        },
        1536,
        "phase3.retrieval.v2-bm25"
      )
    ).toBe(false);
    expect(
      qdrantCollectionMatchesExpectedSchema(
        { result: { config: { params: qdrantEvidenceCollectionSchema(1536) } } },
        1536,
        "phase3.retrieval.v2-bm25"
      )
    ).toBe(false);
  });

  it("builds one immutable multilingual BM25 document shape", () => {
    expect(buildQdrantBm25Document("肉夹馍制作步骤")).toEqual({
      text: "肉夹馍制作步骤",
      model: "qdrant/bm25",
      options: {
        tokenizer: "multilingual",
        stemmer: { type: "none" },
        stopwords: {},
        k: 1.2,
        b: 0.75,
        avg_len: 256
      }
    });
    expect(Object.isFrozen(QDRANT_BM25_OPTIONS)).toBe(true);
  });
});
