import { describe, expect, it } from "vitest";
import {
  buildRetrievalConfigSeed,
  loadActiveRetrievalConfig,
  type AuthenticatedEmployee
} from "@enterprise-hub/domain";
import {
  HttpQdrantEvidenceSearcher,
  createEvidenceSearchService,
  type EvidenceRevalidator,
  type QdrantEvidenceSearcher
} from "./evidence.js";

const employee: AuthenticatedEmployee = {
  id: "emp_admin",
  orgId: "default-org",
  email: "admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff"]
};

describe("evidence search service", () => {
  it("sends dense and sparse hybrid Qdrant query with metadata filters", async () => {
    const requests: Array<{
      url: string;
      body: {
        prefetch: Array<{
          filter: {
            must: unknown[];
          };
        }>;
      };
    }> = [];
    const searcher = new HttpQdrantEvidenceSearcher({
      url: "http://127.0.0.1:6333",
      apiKey: "test-key",
      timeoutMs: 1_000,
      embeddingProvider: {
        async embedTexts() {
          return [[0.1, 0.2, 0.3, 0.4]];
        }
      },
      fetch: (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as {
            prefetch: Array<{
              filter: {
                must: unknown[];
              };
            }>;
          }
        });

        return new Response(
          JSON.stringify({
            result: {
              points: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  score: 0.77,
                  payload: {
                    documentId: "doc_active",
                    chunkId: "chk_active",
                    contentVersion: 2,
                    retrievalConfigVersion: "phase3.retrieval.v1",
                    text: "差评处理 SOP"
                  }
                }
              ]
            }
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });
    const retrievalConfig = loadActiveRetrievalConfig(
      buildRetrievalConfigSeed({
        retrievalConfigVersion: "phase3.retrieval.v1",
        qdrantCollection: "enterprise_hub_evidence_test"
      }),
      "phase3.retrieval.v1"
    );

    const candidates = await searcher.hybridSearch({
      orgId: "default-org",
      employee,
      query: "差评处理 SOP",
      filters: {
        fileTypes: [],
        documentIds: ["doc_active"],
        labelIds: []
      },
      limit: 5,
      cursor: null,
      requestId: "req_1",
      clientIp: "127.0.0.1",
      retrievalConfig
    });

    const request = requests[0];
    expect(request).toBeDefined();

    if (!request) {
      throw new Error("Expected Qdrant request.");
    }

    expect(request.url).toBe(
      "http://127.0.0.1:6333/collections/enterprise_hub_evidence_test/points/query"
    );
    expect(request.body.prefetch).toEqual([
      expect.objectContaining({ using: "dense", query: [0.1, 0.2, 0.3, 0.4] }),
      expect.objectContaining({
        using: "sparse",
        query: expect.objectContaining({
          indices: expect.any(Array),
          values: expect.any(Array)
        })
      })
    ]);
    expect(request.body.prefetch[0]?.filter.must).toEqual(
      expect.arrayContaining([
        { key: "orgId", match: { value: "default-org" } },
        { key: "retrievalConfigVersion", match: { value: "phase3.retrieval.v1" } },
        { key: "documentId", match: { any: ["doc_active"] } }
      ])
    );
    expect(candidates).toEqual([
      {
        chunkId: "chk_active",
        documentId: "doc_active",
        qdrantPointId: "00000000-0000-4000-8000-000000000001",
        contentVersion: 2,
        retrievalConfigVersion: "phase3.retrieval.v1",
        text: "差评处理 SOP",
        hybridScore: 0.77,
        matchedBy: ["dense", "lexical"]
      }
    ]);
  });

  it("reranks Qdrant hybrid hits and drops stale chunks through authoritative revalidation", async () => {
    const searchedQueries: string[] = [];
    const qdrantSearcher: QdrantEvidenceSearcher = {
      async hybridSearch(input) {
        searchedQueries.push(input.query);
        return [
          {
            chunkId: "chk_active",
            documentId: "doc_active",
            qdrantPointId: "point_active",
            contentVersion: 1,
            retrievalConfigVersion: "phase3.retrieval.v1",
            text: "差评处理 SOP：先联系客户，再登记处置结果。",
            hybridScore: 0.7,
            matchedBy: ["dense", "lexical"]
          },
          {
            chunkId: "chk_archived",
            documentId: "doc_archived",
            qdrantPointId: "point_archived",
            contentVersion: 1,
            retrievalConfigVersion: "phase3.retrieval.v1",
            text: "这个旧片段来自已归档文档。",
            hybridScore: 0.9,
            matchedBy: ["dense"]
          }
        ];
      }
    };
    const revalidator: EvidenceRevalidator = {
      async revalidate(input) {
        return input.candidates
          .filter((candidate) => candidate.chunkId === "chk_active")
          .map((candidate) => ({
            ...candidate,
            documentTitle: "客户反馈处理 SOP.docx",
            fileType: "docx",
            sectionHeadingPath: ["客户反馈", "差评处理"],
            blockType: "paragraph",
            pageNumber: null
          }));
      }
    };
    const service = createEvidenceSearchService({
      retrievalConfig: loadActiveRetrievalConfig(
        buildRetrievalConfigSeed({
          retrievalConfigVersion: "phase3.retrieval.v1",
          qdrantCollection: "enterprise_hub_evidence_test"
        }),
        "phase3.retrieval.v1"
      ),
      qdrantSearcher,
      revalidator,
      rerankProvider: {
        metadata: {
          provider: "fake",
          model: "fake-rerank-v1",
          version: "fake-rerank-v1@phase3.retrieval.v1"
        },
        async rerank() {
          return {
            metadata: this.metadata,
            scores: [
              { index: 0, score: 0.91 },
              { index: 1, score: 0.12 }
            ]
          };
        }
      }
    });

    const result = await service.searchEvidence({
      orgId: "default-org",
      employee,
      query: "差评处理 SOP",
      filters: {
        fileTypes: [],
        documentIds: [],
        labelIds: []
      },
      limit: 10,
      cursor: null,
      requestId: "req_1",
      clientIp: "127.0.0.1"
    });

    expect(searchedQueries).toEqual(["差评处理 SOP"]);
    expect(result.results).toEqual([
      {
        chunkId: "chk_active",
        documentId: "doc_active",
        documentTitle: "客户反馈处理 SOP.docx",
        text: "差评处理 SOP：先联系客户，再登记处置结果。",
        source: {
          fileType: "docx",
          sectionHeadingPath: ["客户反馈", "差评处理"],
          blockType: "paragraph",
          pageNumber: null
        },
        score: {
          hybrid: 0.7,
          rerank: 0.91
        },
        matchedBy: ["dense", "lexical", "rerank"]
      }
    ]);
    expect(result.retrieval).toMatchObject({
      retrievalConfigVersion: "phase3.retrieval.v1",
      rerankStatus: "enabled"
    });
  });
});
