import type { EvidenceSearchRepository } from "../evidence.js";

export function createEvidenceSearchRepository(): EvidenceSearchRepository & {
  queries: Array<{ query: string; employeeId: string }>;
  inputs: Array<{
    orgId: string;
    employeeId: string;
    audit: Parameters<EvidenceSearchRepository["searchEvidence"]>[0]["audit"];
  }>;
} {
  const queries: Array<{ query: string; employeeId: string }> = [];
  const inputs: Array<{
    orgId: string;
    employeeId: string;
    audit: Parameters<EvidenceSearchRepository["searchEvidence"]>[0]["audit"];
  }> = [];

  return {
    queries,
    inputs,
    async searchEvidence(input) {
      queries.push({ query: input.query, employeeId: input.employee.id });
      inputs.push({ orgId: input.orgId, employeeId: input.employee.id, audit: input.audit });

      return {
        results: [
          {
            chunkId: "chk_1",
            documentId: "doc_evidence",
            documentTitle: "客户反馈处理 SOP.docx",
            text: "差评处理 SOP：先联系客户，再登记处置结果。",
            sectionText:
              "## 差评处理\n\n差评处理 SOP：先联系客户，再登记处置结果。\n\n超过 24 小时未回复需升级到店长。",
            sectionTruncated: false,
            source: {
              fileType: "docx",
              sectionHeadingPath: ["客户反馈", "差评处理"],
              blockType: "paragraph",
              pageNumber: null
            },
            score: {
              hybrid: 0.82,
              rerank: 0.91
            },
            matchedBy: ["dense", "lexical", "rerank"]
          }
        ],
        page: {
          limit: input.limit,
          nextCursor: null,
          hasMore: false
        },
        retrieval: {
          retrievalConfigVersion: "phase3.retrieval.v2",
          embeddingVersion: "fake-embedding-v1@phase3.retrieval.v2",
          lexicalIndexVersion: "lexical.v2",
          rerankVersion: "fake-rerank-v1@phase3.retrieval.v2",
          rerankStatus: "enabled"
        },
        warnings: []
      };
    }
  };
}
