import { describe, expect, it } from "vitest";
import {
  buildRetrievalConfigSeed,
  loadActiveRetrievalConfig,
  type AuthenticatedEmployee
} from "@enterprise-hub/domain";
import {
  EvidenceSearchCursorError,
  HttpQdrantEvidenceSearcher,
  PrismaEvidenceRevalidator,
  createApiRerankProvider,
  createEvidenceSearchService,
  limitRerankDocuments,
  type EvidenceRevalidator,
  type QdrantEvidenceCandidate,
  type QdrantEvidenceSearcher
} from "./evidence.js";

const employee: AuthenticatedEmployee = {
  id: "emp_admin",
  orgId: "default-org",
  displayName: "Admin User",
  email: "admin@example.com",
  role: "admin",
  disabled: false,
  clearance: 3
};

const baoliEmployee: AuthenticatedEmployee = {
  id: "emp_baoli_employee",
  orgId: "default-org",
  displayName: "Baoli Employee",
  email: "baoli.employee@example.com",
  role: "employee",
  disabled: false,
  clearance: 3
};

describe("evidence search service", () => {
  it("sends dense and sparse hybrid Qdrant query with metadata filters", async () => {
    const requests: Array<{
      url: string;
      body: {
        prefetch: Array<{
          filter: {
            must: unknown[];
            min_should?: unknown;
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
                min_should?: unknown;
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
        documentIds: ["doc_active"]
      },
      limit: 5,
      cursor: null,
      cursorSecret: "cursor-secret",
      audit: {
        requestId: "req_http_1",
        sourceIp: "198.51.100.8",
        clientSource: "http_api" as const,
        launcherVersion: null
      },
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
    expect(request.body.prefetch[0]?.filter).toMatchObject({
      min_should: {
        conditions: [
          { key: "confidentialityLevel", range: { lte: 3 } },
          { is_empty: { key: "confidentialityLevel" } }
        ],
        min_count: 1
      }
    });
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
    const rerankedDocuments: Array<{ id: string; text: string }> = [];
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
        async rerank(input) {
          rerankedDocuments.push(...input.documents);
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
        documentIds: []
      },
      limit: 10,
      cursor: null,
      cursorSecret: "cursor-secret",
      audit: {
        requestId: "req_http_1",
        sourceIp: "198.51.100.8",
        clientSource: "http_api",
        launcherVersion: null
      }
    });

    expect(searchedQueries).toEqual(["差评处理 SOP"]);
    expect(rerankedDocuments).toEqual([
      {
        id: "chk_active",
        text: "差评处理 SOP：先联系客户，再登记处置结果。"
      }
    ]);
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

  it("returns signed evidence cursor pages and rejects tamper, expiry, and scope changes", async () => {
    const candidates = [candidate("chk_1", 0.9), candidate("chk_2", 0.8), candidate("chk_3", 0.7)];
    const qdrantSearcher: QdrantEvidenceSearcher = {
      async hybridSearch(input) {
        expect(input.limit).toBe(200);
        return candidates;
      }
    };
    const revalidator: EvidenceRevalidator = {
      async revalidate(input) {
        return input.candidates.map((next) => ({
          ...next,
          documentTitle: `Document ${next.documentId}`,
          fileType: "md",
          sectionHeadingPath: [],
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
      rerankProvider: null
    });
    const baseInput = {
      orgId: "default-org",
      employee,
      query: "差评处理 SOP",
      filters: {
        fileTypes: [],
        documentIds: []
      },
      limit: 2,
      cursor: null,
      cursorSecret: "cursor-secret",
      audit: {
        requestId: "req_http_1",
        sourceIp: "198.51.100.8",
        clientSource: "http_api" as const,
        launcherVersion: null
      },
      now: new Date("2026-07-20T00:00:00.000Z")
    };

    const firstPage = await service.searchEvidence(baseInput);
    expect(firstPage.results.map((result) => result.chunkId)).toEqual(["chk_1", "chk_2"]);
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    const secondPage = await service.searchEvidence({
      ...baseInput,
      cursor: firstPage.page.nextCursor,
      now: new Date("2026-07-20T00:01:00.000Z")
    });
    expect(secondPage.results.map((result) => result.chunkId)).toEqual(["chk_3"]);
    expect(secondPage.page.nextCursor).toBeNull();

    await expect(
      service.searchEvidence({
        ...baseInput,
        cursor: `${firstPage.page.nextCursor?.slice(0, -1)}x`
      })
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      service.searchEvidence({
        ...baseInput,
        cursor: firstPage.page.nextCursor,
        now: new Date("2026-07-20T00:16:00.000Z")
      })
    ).rejects.toBeInstanceOf(EvidenceSearchCursorError);
    await expect(
      service.searchEvidence({
        ...baseInput,
        cursor: firstPage.page.nextCursor,
        query: "另一个问题"
      })
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});

function candidate(chunkId: string, hybridScore: number): QdrantEvidenceCandidate {
  return {
    chunkId,
    documentId: `doc_${chunkId}`,
    qdrantPointId: `point_${chunkId}`,
    contentVersion: 1,
    retrievalConfigVersion: "phase3.retrieval.v1",
    text: `Evidence ${chunkId}`,
    hybridScore,
    matchedBy: ["dense"]
  };
}

describe("API evidence rerank provider", () => {
  it("uses DashScope rerank endpoint and maps output results to evidence indexes", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });

      return new Response(
        JSON.stringify({
          output: {
            results: [
              { index: 1, relevance_score: 0.22 },
              { index: 0, relevance_score: 0.93 }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const retrievalConfig = loadActiveRetrievalConfig(
        buildRetrievalConfigSeed({
          retrievalConfigVersion: "phase3.retrieval.v1",
          qdrantCollection: "enterprise_hub_evidence_test",
          llmProvider: "openai-compatible",
          embeddingModel: "text-embedding-v4",
          embeddingDimension: 1024,
          rerankProvider: "dashscope",
          rerankModel: "qwen3-rerank"
        }),
        "phase3.retrieval.v1"
      );
      const provider = createApiRerankProvider({
        retrievalConfig,
        openAiCompatibleApiKey: "sk-openai-compatible",
        openAiCompatibleBaseUrl: "https://provider.example/v1",
        dashscopeApiKey: "sk-dashscope",
        dashscopeApiBaseUrl: "https://dashscope.example/api/v1/",
        externalModelEgressAcknowledged: true
      });

      const result = await provider?.rerank({
        query: "synthetic query",
        documents: [
          { id: "chunk_a", text: "synthetic document A" },
          { id: "chunk_b", text: "synthetic document B" }
        ]
      });

      expect(result?.scores).toEqual([
        { index: 1, score: 0.22 },
        { index: 0, score: 0.93 }
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://dashscope.example/api/v1/services/rerank/text-rerank/text-rerank"
      );
      expect(requests[0]?.init.headers).toMatchObject({
        authorization: "Bearer sk-dashscope",
        "content-type": "application/json"
      });
      expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
        model: "qwen3-rerank",
        input: {
          query: "synthetic query",
          documents: ["synthetic document A", "synthetic document B"]
        },
        parameters: {
          top_n: 2,
          return_documents: false
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts top-level DashScope-compatible rerank results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.81 }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch;

    try {
      const retrievalConfig = loadActiveRetrievalConfig(
        buildRetrievalConfigSeed({
          retrievalConfigVersion: "phase3.retrieval.v1",
          qdrantCollection: "enterprise_hub_evidence_test",
          llmProvider: "openai-compatible",
          embeddingModel: "text-embedding-v4",
          embeddingDimension: 1024,
          rerankProvider: "dashscope",
          rerankModel: "qwen3-rerank"
        }),
        "phase3.retrieval.v1"
      );
      const provider = createApiRerankProvider({
        retrievalConfig,
        openAiCompatibleApiKey: "sk-openai-compatible",
        openAiCompatibleBaseUrl: "https://provider.example/v1",
        dashscopeApiKey: "sk-dashscope",
        dashscopeApiBaseUrl: "https://dashscope.example/api/v1",
        externalModelEgressAcknowledged: true
      });

      await expect(
        provider?.rerank({
          query: "synthetic query",
          documents: [{ id: "chunk_a", text: "synthetic document" }]
        })
      ).resolves.toEqual({
        scores: [{ index: 0, score: 0.81 }]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accounts for the query once per document when trimming a DashScope request", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ body: unknown }> = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });

      return new Response(JSON.stringify({ output: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    try {
      const retrievalConfig = loadActiveRetrievalConfig(
        buildRetrievalConfigSeed({
          retrievalConfigVersion: "phase3.retrieval.v1",
          qdrantCollection: "enterprise_hub_evidence_test",
          llmProvider: "openai-compatible",
          embeddingModel: "text-embedding-v4",
          embeddingDimension: 1024,
          rerankProvider: "dashscope",
          rerankModel: "qwen3.7-text-rerank"
        }),
        "phase3.retrieval.v1"
      );
      const provider = createApiRerankProvider({
        retrievalConfig,
        openAiCompatibleApiKey: "sk-openai-compatible",
        openAiCompatibleBaseUrl: "https://provider.example/v1",
        dashscopeApiKey: "sk-dashscope",
        dashscopeApiBaseUrl: "https://dashscope.example/api/v1",
        externalModelEgressAcknowledged: true
      });

      await provider?.rerank({
        query: "文".repeat(4_000),
        documents: Array.from({ length: 200 }, (_, index) => ({
          id: `chunk_${index}`,
          text: "文".repeat(1_600)
        }))
      });

      expect(requests).toHaveLength(1);
      const request = requests[0]?.body as {
        parameters: { top_n: number };
        input: { documents: string[] };
      };
      expect(request.parameters.top_n).toBe(17);
      expect(request.input.documents).toHaveLength(17);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps fused-order fallback when no DashScope document fits the input limit", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("DashScope must not receive an empty rerank request");
    }) as typeof fetch;

    try {
      const retrievalConfig = loadActiveRetrievalConfig(
        buildRetrievalConfigSeed({
          retrievalConfigVersion: "phase3.retrieval.v1",
          qdrantCollection: "enterprise_hub_evidence_test",
          llmProvider: "openai-compatible",
          embeddingModel: "text-embedding-v4",
          embeddingDimension: 1024,
          rerankProvider: "dashscope",
          rerankModel: "qwen3.7-text-rerank"
        }),
        "phase3.retrieval.v1"
      );
      const provider = createApiRerankProvider({
        retrievalConfig,
        openAiCompatibleApiKey: "sk-openai-compatible",
        openAiCompatibleBaseUrl: "https://provider.example/v1",
        dashscopeApiKey: "sk-dashscope",
        dashscopeApiBaseUrl: "https://dashscope.example/api/v1",
        externalModelEgressAcknowledged: true
      });

      await expect(
        provider?.rerank({
          query: "synthetic query",
          documents: [{ id: "chunk_oversized", text: "文".repeat(50_000) }]
        })
      ).resolves.toEqual({ scores: [] });
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("evidence MySQL revalidation", () => {
  function evidenceCandidate(
    overrides: Partial<QdrantEvidenceCandidate> = {}
  ): QdrantEvidenceCandidate {
    return {
      chunkId: "chk_active",
      documentId: "doc_active",
      qdrantPointId: "point_active",
      contentVersion: 2,
      retrievalConfigVersion: "phase3.retrieval.v1",
      text: "stale qdrant text must not be trusted",
      hybridScore: 0.9,
      matchedBy: ["dense", "lexical"],
      ...overrides
    };
  }

  function evidenceChunk(overrides: Record<string, unknown> = {}) {
    return {
      qdrantPointId: "point_active",
      documentId: "doc_active",
      chunkId: "chk_active",
      contentVersion: 2,
      retrievalConfigVersion: "phase3.retrieval.v1",
      chunkText: "authoritative MySQL chunk text",
      sourceLocation: {
        sectionHeadingPath: ["客户反馈", "差评处理"],
        blockTypes: ["paragraph"],
        pageNumber: 3
      },
      document: {
        title: "客户反馈处理 SOP.md",
        fileType: "md",
        confidentialityLevel: 0
      },
      documentIndex: {
        contentVersion: 2
      },
      ...overrides
    };
  }

  function createRevalidator(chunks: unknown[]) {
    const calls: unknown[] = [];
    const prisma = {
      documentChunk: {
        async findMany(query: unknown) {
          calls.push(query);
          return chunks;
        }
      }
    };

    return {
      calls,
      revalidator: new PrismaEvidenceRevalidator(
        prisma as ConstructorParameters<typeof PrismaEvidenceRevalidator>[0]
      )
    };
  }

  it("requeries only active ready evidence chunks and returns authoritative source metadata", async () => {
    const { calls, revalidator } = createRevalidator([evidenceChunk()]);

    const result = await revalidator.revalidate({
      orgId: "default-org",
      employee: baoliEmployee,
      candidates: [evidenceCandidate()],
      filters: {
        fileTypes: [],
        documentIds: []
      }
    });

    expect(calls).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          indexType: "evidence",
          document: {
            orgId: "default-org",
            status: "active",
            documentKind: "evidence"
          },
          documentIndex: {
            status: "ready"
          }
        })
      })
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        chunkId: "chk_active",
        text: "authoritative MySQL chunk text",
        documentTitle: "客户反馈处理 SOP.md",
        fileType: "md",
        sectionHeadingPath: ["客户反馈", "差评处理"],
        blockType: "paragraph",
        pageNumber: 3
      })
    ]);
    expect(result[0]?.text).not.toBe("stale qdrant text must not be trusted");
  });

  it("applies the current source document confidentiality level during revalidation", async () => {
    const suzhouOnlyChunk = evidenceChunk({
      document: {
        title: "客户反馈处理 SOP.md",
        fileType: "md",
        confidentialityLevel: 3
      }
    });
    const { revalidator } = createRevalidator([suzhouOnlyChunk]);

    const result = await revalidator.revalidate({
      orgId: "default-org",
      employee: { ...baoliEmployee, clearance: 2 },
      candidates: [evidenceCandidate()],
      filters: {
        fileTypes: [],
        documentIds: []
      }
    });

    expect(result).toEqual([]);
  });

  it("drops disabled employees and stale Qdrant payload mismatches", async () => {
    const { calls: disabledCalls, revalidator: disabledRevalidator } = createRevalidator([
      evidenceChunk()
    ]);

    await expect(
      disabledRevalidator.revalidate({
        orgId: "default-org",
        employee: { ...baoliEmployee, disabled: true },
        candidates: [evidenceCandidate()],
        filters: {
          fileTypes: [],
          documentIds: []
        }
      })
    ).resolves.toEqual([]);
    expect(disabledCalls).toEqual([]);

    const { revalidator } = createRevalidator([
      evidenceChunk({ qdrantPointId: "point_wrong_document", documentId: "doc_active" }),
      evidenceChunk({ qdrantPointId: "point_wrong_chunk", chunkId: "chk_active" }),
      evidenceChunk({ qdrantPointId: "point_wrong_content", contentVersion: 2 }),
      evidenceChunk({
        qdrantPointId: "point_wrong_config",
        retrievalConfigVersion: "phase3.retrieval.v1"
      }),
      evidenceChunk()
    ]);

    const result = await revalidator.revalidate({
      orgId: "default-org",
      employee: baoliEmployee,
      candidates: [
        evidenceCandidate({ qdrantPointId: "point_wrong_document", documentId: "doc_stale" }),
        evidenceCandidate({ qdrantPointId: "point_wrong_chunk", chunkId: "chk_stale" }),
        evidenceCandidate({ qdrantPointId: "point_wrong_content", contentVersion: 3 }),
        evidenceCandidate({
          qdrantPointId: "point_wrong_config",
          retrievalConfigVersion: "phase3.retrieval.v0"
        }),
        evidenceCandidate()
      ],
      filters: {
        fileTypes: [],
        documentIds: []
      }
    });

    expect(result.map((candidate) => candidate.qdrantPointId)).toEqual(["point_active"]);
  });
});

describe("rerank request budgeting", () => {
  it("keeps every candidate when the request fits the provider budget", () => {
    const documents = Array.from({ length: 50 }, (_, index) => ({
      text: "文".repeat(200) + index
    }));

    expect(limitRerankDocuments(documents)).toHaveLength(50);
  });

  it("trims the candidate list once the estimated request tokens exceed the budget", () => {
    const documents = Array.from({ length: 400 }, (_, index) => ({
      text: "文".repeat(1_600) + index
    }));
    const limited = limitRerankDocuments(documents);

    expect(limited.length).toBeGreaterThan(0);
    expect(limited.length).toBeLessThan(documents.length);
    expect(limited[0]).toEqual(documents[0]);
  });

  it("skips a single document that exceeds the provider input limit", () => {
    const documents = [{ text: "文".repeat(50_000) }];

    expect(limitRerankDocuments(documents)).toHaveLength(0);
  });

  it("caps the candidate count at the provider document limit", () => {
    const documents = Array.from({ length: 600 }, (_, index) => ({ text: `短文 ${index}` }));

    expect(limitRerankDocuments(documents)).toHaveLength(500);
  });
});
