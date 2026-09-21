# Evidence Retrieval V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade evidence retrieval to fixture-backed Chinese BM25 hybrid search with versioned relevance pruning and an automatically issued source-file download link for every distinct source document returned on the current page.

**Architecture:** Keep MySQL as the authorization and document-state authority and Qdrant as a rebuildable derived index. Introduce a versioned `phase3.retrieval.v2-bm25` configuration that writes dense vectors plus Qdrant native BM25 vectors into a new collection, scopes BM25 IDF statistics to the authenticated organization, reranks authorized candidates, then applies a configurable absolute floor and score-gap cutoff before pagination. After the visible page is fixed, batch-load the distinct authorized source documents and issue one audited 24-hour download URL per document directly in `search_document_evidence`; retain `phase3.retrieval.v1` during the migration and rollback window.

**Tech Stack:** TypeScript, Fastify, Prisma/MySQL, Qdrant 1.19.1, Qdrant native `qdrant/bm25`, DashScope/OpenAI-compatible rerank, Vitest, MCP contract package, `smedc-mcp-launcher`, OSS/local storage adapters.

**Spec:** [Phase 3 retrieval design](phase-3-retrieval-docs.md), [ADR 0012](../adr/0012-qdrant-native-hybrid-retrieval.md), [ADR 0014](../adr/0014-versioned-retrieval-model-migration.md), [API contract](api-contract.md), and the product decisions recorded below.

## Approved Change Specification

- Import the five non-temporary DOCX files from `/Users/xiaoyuyin/Desktop/MAIJIA_DATA/EVIDENCE_EXAMPLES` as repository fixtures and judged retrieval examples. Never import `.DS_Store` or `.~*.docx` lock files.
- Replace the current hashed raw-term-frequency lexical path with BM25 for the V2 retrieval configuration. Chinese text must use the same multilingual tokenization options at ingest and query time.
- Apply a configurable relevance policy after reranking and before pagination. The initial V2 values are `rerankMinScore = 0.30`, `rerankMinGap = 0.30`, and `rerankLowClusterMaxScore = 0.40`; these are versioned defaults, not permanent product constants.
- Never compare a rerank score with a hybrid/RRF score as though they share a scale. A candidate without a rerank score is not eligible for V2 thresholded output and causes an explicit warning.
- When evidence results are returned, automatically issue one download URL for every distinct source document on that response page. This is the default behavior, not an opt-in and not an agent judgment.
- A healthy, authorized source returns a 24-hour download link. Only an empty result set, a concurrent authorization/status change, or a storage/signing failure may prevent a link; the response must then expose an unavailable status and warning instead of silently omitting the source.
- Keep evaluation deliberately light in this implementation round: one old-version baseline, one new-version comparison, focused automated tests, and a concise recorded result. Do not repeatedly tune relevance values unless a correctness, authorization, or gross retrieval failure is found. QA performs the broader manual acceptance later.

## Global Constraints

- Preserve the service boundary: SMEDC returns authorized evidence and source links; it does not generate the employee-facing final answer.
- Every non-health API remains backend-authorized. Search results and source URLs must satisfy same-organization, active-document, non-archived, active-employee, and clearance checks at issuance time.
- Do not commit secrets, live customer exports, private tokens, temporary Word lock files, or generated evaluation output under `.data/`. Before committing the five manuals, inspect their OOXML text and metadata for credentials, personal data, or material that is not approved for this repository; sanitize document properties or the fixture copy when required while preserving retrieval-relevant content.
- Keep `phase3.retrieval.v1` readable during the rollout and rollback window. V2 must use a new Qdrant collection; never mutate the active V1 collection schema in place.
- Pin local and staging Qdrant to `v1.19.1` for V2. A persistent staging volume must be upgraded through `v1.16.3`, `v1.17.1`, and `v1.18.3` before `v1.19.1`, with a snapshot and readiness check at each step.
- Configure the BM25 sparse vector with `modifier: "idf"`; use `tokenizer: "multilingual"`, `stemmer: { type: "none" }`, empty stopwords, `k = 1.2`, `b = 0.75`, and `avg_len = 256` at both ingest and query time.
- Scope BM25 IDF corpus statistics by the authenticated `orgId`; the IDF corpus filter must not include narrower document/file filters.
- The source URL list is document-level and page-level. Multiple matching chunks from one document produce exactly one `sources[]` entry and one issued-link audit event for that response.
- Any MCP tool behavior/result-contract or usage-guidance change must update `packages/mcp-contract`, the published launcher, the repo-local `skills/smedc-mcp/`, and the standalone `YinXiaoyu-1998/smedc-mcp-skill` repository in the required release order.
- Do not deploy or mutate staging in the implementation PR. Perform the Qdrant upgrade, V2 reindex, runtime environment cutover, and staging smoke only after merge and explicit staging-release authorization.
- Run the smallest focused tests during implementation and the repository-wide gates once on the final tree. Clean all local MySQL/Qdrant containers, volumes, networks, `.data/` artifacts, and temporary worktrees before handoff.

## Review Focus

- A no-answer query whose rerank scores are all below `0.30` must return zero chunks and zero sources, not a page filled to `limit`.
- A partial rerank response must not mix missing candidates' RRF scores with rerank scores; scored candidates are pruned normally and the response includes `RERANK_INCOMPLETE`.
- Duplicate chunks, repeated pages, and multiple chunks from one document must not create duplicate source entries or duplicate link-issuance audit rows within one response.
- A source document archived or raised above the employee's clearance between retrieval revalidation and URL issuance must not receive a link; the already-authorized search response must carry a safe unavailable warning without leaking new metadata.
- BM25 IDF must use only the caller's organization corpus even when retrieval adds document ID, file type, status, content-version, or confidentiality filters.

---

## File and Interface Map

- `fixtures/evidence/maijia/`: approved DOCX fixture bytes and their judged manifest.
- `scripts/evidence-fixture-golden-support.ts`: manifest validation, metric calculation, and stable report types.
- `scripts/evidence-fixture-golden.ts`: disposable local end-to-end fixture runner; uploads, waits for indexing, searches, records sources, and writes `.data/evaluation/*.json`.
- `apps/api/src/evidence-relevance.ts`: pure score-ordering and pruning policy; it has no storage, database, or HTTP responsibility.
- `packages/domain/src/retrieval-config.ts`: V1/V2 retrieval, BM25, and relevance-policy configuration.
- `packages/domain/src/retrieval-runtime.ts`: V1/V2 Qdrant collection schema and payload-index expectations.
- `apps/worker/src/evidence-index.ts`: version-aware lexical indexing; V2 sends raw chunk text to Qdrant native BM25.
- `apps/api/src/evidence.ts`: version-aware hybrid query, organization-scoped BM25 IDF, rerank, relevance pruning, dedupe, and pagination.
- `scripts/reindex-evidence.ts`: idempotently queues existing active evidence documents for the target retrieval version.
- `apps/api/src/source-document-downloads.ts`: shared batch authorization, URL issuance, status mapping, and audit orchestration for explicit and automatic downloads.
- `apps/api/src/routes/evidence.ts`: always enriches a non-empty evidence page with source downloads.
- `apps/api/src/routes/source-documents.ts`: delegates its existing explicit endpoint to the shared download service.
- `packages/mcp-contract/src/index.ts`: advertises `sources[]` in `search_document_evidence` output.

---

### Task 1 — Add the approved real-world evidence fixtures and judged manifest

**Files:**

- Create: `fixtures/evidence/maijia/2.餐厅运营管理手册(1).docx`
- Create: `fixtures/evidence/maijia/2_7-厨房生产管理指导手册(1).docx`
- Create: `fixtures/evidence/maijia/丰茂岗位服务流程手册-前厅(1).docx`
- Create: `fixtures/evidence/maijia/管氏 开店手册 （1月27日）(1).docx`
- Create: `fixtures/evidence/maijia/肉夹馍SOP.docx`
- Create: `fixtures/evidence/maijia/golden.json`
- Modify: `fixtures/README.md`
- Modify/Test: `apps/worker/src/parsers/evidence-parser.test.ts`

**Interfaces:**

- Produces: `EvidenceFixtureManifestV1`, consumed by Task 2.
- Produces: five stable fixture IDs: `restaurant-operations`, `kitchen-production`, `front-of-house-service`, `store-opening`, and `roujiamo-sop`.

- [ ] **Step 1: inventory and inspect the source directory without copying temporary files**

  Run `find /Users/xiaoyuyin/Desktop/MAIJIA_DATA/EVIDENCE_EXAMPLES -maxdepth 1 -type f -print0 | xargs -0 file` and `shasum -a 256` for the five named documents. Extract OOXML text and `docProps/*` metadata into a temporary directory created with `mktemp -d`; inspect for credentials, personal contact data, and unapproved document properties. Do not print sensitive findings into logs or plan/progress files.

- [ ] **Step 2: create the fixture directory and copy only the five approved files**

  Copy the exact five files listed above. Assert that `find fixtures/evidence/maijia -maxdepth 1 -type f \( -name '.DS_Store' -o -name '.~*' \)` returns no rows. Preserve the approved content; strip only disallowed OOXML properties or explicitly identified sensitive values from the fixture copy, never from the user's source directory.

- [ ] **Step 3: write the manifest with a fixed schema and initial judgments**

  Use this shape:

  ```ts
  interface EvidenceFixtureManifestV1 {
    schemaVersion: 1;
    documents: Array<{
      fixtureId: string;
      path: string;
      title: string;
      sha256: string;
      confidentialityLevel: 0;
    }>;
    cases: Array<{
      caseId: string;
      query: string;
      relevantFixtureIds: string[];
      unacceptableFixtureIds: string[];
      expectNoAnswer: boolean;
      notes: string;
    }>;
  }
  ```

  Include at least these fixed regression cases after verifying the matching passages in the parsed documents:

  - `roujiamo-how-to`: `肉夹馍怎么做？`; relevant `roujiamo-sop`; all other fixture IDs unacceptable.
  - `roujiamo-steps`: `肉夹馍的制作步骤和关键控制点是什么？`; relevant `roujiamo-sop`; all other fixture IDs unacceptable.
  - `kitchen-manager-duty`: `店长在厨房生产管理中的职责是什么？`; relevant `restaurant-operations` and `kitchen-production`; front-of-house/opening/roujiamo documents are unacceptable.
  - `front-of-house-flow`: `前厅岗位的标准服务流程是什么？`; relevant `front-of-house-service`.
  - `store-opening-preparation`: `新店开业前需要完成哪些准备？`; relevant `store-opening`.
  - `unanswered-expense-policy`: `员工差旅报销的审批标准是什么？`; no answer; all five documents unacceptable.

- [ ] **Step 4: add parser regression coverage for every committed DOCX**

  Parameterize the existing parser test to read every manifest document, assert a non-empty ordered block list, assert no OOXML control garbage in text, and assert that each document produces at least one chunk under the configured evidence limits. The test must use the real parser and chunker, not unzip text directly.

- [ ] **Step 5: document fixture provenance and exclusions**

  In `fixtures/README.md`, record the fixture directory, five filenames, SHA-256 values, intended regression-only use, and explicit exclusion of `.DS_Store` and `.~*.docx` files. Do not copy extracted text or sensitive review notes into the README.

- [ ] **Step 6: run the focused parser test and commit**

  Run `npm test -- apps/worker/src/parsers/evidence-parser.test.ts apps/worker/src/chunking/evidence-chunker.test.ts`.

  Commit: `test(evidence): add real-world retrieval fixtures`

---

### Task 2 — Build the lightweight fixture-backed evaluator and capture the V1 baseline

**Files:**

- Create: `scripts/evidence-fixture-golden-support.ts`
- Create: `scripts/evidence-fixture-golden-support.test.ts`
- Create: `scripts/evidence-fixture-golden.ts`
- Modify: `package.json`
- Create later from one recorded run: `docs/implementation/evidence-retrieval-v2-evaluation.md`

**Interfaces:**

- Consumes: `EvidenceFixtureManifestV1` from Task 1.
- Produces: `EvidenceFixtureEvaluationReport` with `runLabel`, `gitSha`, retrieval metadata, per-case ordered documents/scores/sources, `hitRateAt5`, `recallAt10`, `mrrAt10`, `unacceptableReturnCount`, `noAnswerFalsePositiveRate`, and download-link coverage.

- [ ] **Step 1: write manifest and metric validation tests**

  Cover duplicate fixture IDs, missing fixture files, a case that is simultaneously answerable and `expectNoAnswer`, unknown relevant/unacceptable IDs, overlap between relevant and unacceptable IDs, duplicate returned chunks from one document, and zero-result no-answer scoring.

- [ ] **Step 2: implement the pure support module**

  Export:

  ```ts
  export function loadEvidenceFixtureManifest(path: string): Promise<EvidenceFixtureManifestV1>;
  export function evaluateEvidenceFixtureCases(
    manifest: EvidenceFixtureManifestV1,
    observations: readonly EvidenceCaseObservation[]
  ): EvidenceFixtureEvaluationReport;
  ```

  Document-level metrics must dedupe repeated chunks by `documentId`. `unacceptableReturnCount` counts every case/document pair at most once. Download coverage is `distinct returned documents with a non-null URL / distinct returned documents`.

- [ ] **Step 3: implement a disposable local runner**

  Add `npm run test:phase3:fixture-golden -- --run-label v1-baseline --output .data/evaluation/v1-baseline.json`. The script must read `SMEDC_BASE_URL` and `SMEDC_ACCESS_TOKEN` from the environment, upload the five fixture documents, poll evidence status until ready with a bounded timeout, execute each manifest query, and save raw scores plus the document-level summary. It must refuse non-loopback URLs unless `--allow-remote` is explicitly supplied; remote mode must never perform cleanup automatically.

- [ ] **Step 4: capture one V1 baseline before retrieval changes**

  Start a disposable local MySQL/Qdrant V1 environment with the real local provider configuration loaded from `.env`, upload the fixture set once, run the evaluator with `--run-label v1-baseline`, and preserve the JSON under `.data/evaluation/` only. Record the base commit SHA and a concise metric/result table in `docs/implementation/evidence-retrieval-v2-evaluation.md`; do not commit the raw report.

- [ ] **Step 5: clean the baseline environment and commit**

  Run the repository's purge/compose cleanup, verify no run-owned Docker or `.data/` residue, then run `npm test -- scripts/evidence-fixture-golden-support.test.ts`.

  Commit: `test(evidence): add fixture-backed retrieval evaluator`

---

### Task 3 — Add versioned rerank relevance pruning before pagination

**Files:**

- Create: `apps/api/src/evidence-relevance.ts`
- Create: `apps/api/src/evidence-relevance.test.ts`
- Modify: `packages/domain/src/retrieval-config.ts`
- Modify: `packages/domain/src/retrieval-config.test.ts`
- Modify: `apps/api/src/evidence.ts`
- Modify: `apps/api/src/evidence.test.ts`
- Modify: `apps/api/src/test-support/evidence-fixtures.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface EvidenceRelevancePolicy {
    version: string;
    mode: "disabled" | "rerank_floor_and_gap";
    rerankMinScore: number;
    rerankMinGap: number;
    rerankLowClusterMaxScore: number;
  }

  export function pruneEvidenceCandidates<
    T extends {
      chunkId: string;
      rerankScore: number | null;
    }
  >(
    candidates: readonly T[],
    policy: EvidenceRelevancePolicy
  ): {
    kept: T[];
    droppedCount: number;
    warnings: string[];
    cutoffReason: "disabled" | "below_floor" | "score_gap" | "none";
  };
  ```

- [ ] **Step 1: write failing pure-policy tests**

  Pin these cases:

  - `[0.67, 0.62, 0.20, 0.20]` keeps the first two.
  - `[0.28, 0.26, 0.24]` returns none because the top score is below `0.30`.
  - `[0.80, 0.48, 0.47]` keeps all three because the lower cluster is above `0.40` even though the first gap exceeds `0.30`.
  - `[0.72, 0.61, 0.31]` keeps the first two by the score-gap rule.
  - equal scores remain stable by `chunkId`.
  - a missing rerank score is excluded and produces `RERANK_INCOMPLETE`.
  - disabled policy returns the input order without threshold warnings.

- [ ] **Step 2: add V1 and V2 relevance configs**

  `phase3.retrieval.v1` retains `mode: "disabled"`. `phase3.retrieval.v2-bm25` uses:

  ```ts
  relevance: {
    version: "relevance.v1@phase3.retrieval.v2-bm25",
    mode: "rerank_floor_and_gap",
    rerankMinScore: 0.30,
    rerankMinGap: 0.30,
    rerankLowClusterMaxScore: 0.40
  }
  ```

  Validate every configured score as finite and within `[0, 1]`; validate the gap as greater than zero.

- [ ] **Step 3: implement pruning as a pure function**

  Sort only by rerank score and stable `chunkId`. Remove unscored candidates in V2. Apply the absolute floor first, then locate the largest adjacent gap among survivors; cut only when the gap is at least `rerankMinGap` and the first score below the gap is at most `rerankLowClusterMaxScore`.

- [ ] **Step 4: integrate pruning before dedupe pagination**

  In `searchEvidence`, preserve the sequence: hybrid candidates → MySQL revalidation → rerank → rerank-only ordering → relevance pruning → dedupe → cursor page. Remove `rerankScore ?? hybridScore` comparisons from the V2 path. V1 may retain legacy ordering only behind the V1 configuration.

- [ ] **Step 5: extend response retrieval metadata**

  Add:

  ```ts
  relevance: {
    policyVersion: string;
    cutoffReason: "disabled" | "below_floor" | "score_gap" | "none";
    droppedCount: number;
  }
  ```

  Cursor scope already contains retrieval config version; assert that V1 and V2 cursors are mutually invalid.

- [ ] **Step 6: run focused tests and commit**

  Run `npm test -- apps/api/src/evidence-relevance.test.ts apps/api/src/evidence.test.ts packages/domain/src/retrieval-config.test.ts` and `npm run typecheck`.

  Commit: `feat(evidence): prune low-relevance rerank results`

---

### Task 4 — Implement Qdrant native multilingual BM25 as Retrieval V2

**Files:**

- Modify: `docker-compose.yml`
- Modify: `packages/domain/src/retrieval-config.ts`
- Modify: `packages/domain/src/retrieval-runtime.ts`
- Modify: `packages/domain/src/retrieval-runtime.test.ts`
- Modify: `scripts/readiness.ts`
- Modify: `scripts/readiness.test.ts`
- Modify: `apps/worker/src/evidence-index.ts`
- Modify: `apps/worker/src/evidence-index.test.ts`
- Modify: `apps/api/src/evidence.ts`
- Modify: `apps/api/src/evidence.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Adds lexical strategy `"legacy_hash_tf" | "qdrant_bm25"` to `RetrievalModelConfig.lexical`.
- Adds `QDRANT_BM25_VECTOR_NAME = "bm25"`, `QDRANT_BM25_MODEL = "qdrant/bm25"`, and one shared immutable options object used by API and worker.
- V2 collection schema contains dense vector `dense` and sparse vector `bm25` with `modifier: "idf"`.

- [ ] **Step 1: write failing collection/config tests**

  Assert V1 still expects sparse vector `sparse` without changing its schema. Assert V2 expects `bm25` with IDF modifier and rejects an existing collection that lacks the modifier. Assert the active runtime config fails fast when V2 is pointed at the V1 collection schema.

- [ ] **Step 2: pin Qdrant 1.19.1 locally**

  Change `qdrant/qdrant:v1.15.4` to `qdrant/qdrant:v1.19.1` in local compose. Do not change staging runtime environment in this task.

- [ ] **Step 3: define one BM25 document/query object builder**

  Export a shared serializable builder returning:

  ```ts
  {
    text,
    model: "qdrant/bm25",
    options: {
      tokenizer: "multilingual",
      stemmer: { type: "none" },
      stopwords: {},
      k: 1.2,
      b: 0.75,
      avg_len: 256
    }
  }
  ```

  Tests must prove byte-equivalent options at worker ingest and API query construction.

- [ ] **Step 4: create V2 collections and required payload indexes**

  Extend `npm run qdrant:init` to create/validate the V2 collection and create `orgId` as a keyword payload index with `is_tenant: true`. Keep the existing retrieval filter fields unchanged. Treat an incompatible existing V2 collection as a hard readiness failure rather than mutating it.

- [ ] **Step 5: write BM25 text at indexing time**

  For V2, the worker sends the chunk text through the shared BM25 document object under vector `bm25`; it no longer calls the hashed token counter. Preserve the legacy sparse-vector encoder only inside the V1 adapter during the rollback window. The payload continues to include `orgId`, `documentId`, clearance, content/retrieval versions, text, and source location.

- [ ] **Step 6: query dense plus BM25 with organization-scoped IDF**

  V2's BM25 prefetch uses the shared BM25 query object and:

  ```ts
  {
    params: {
      idf: {
        corpus: {
          must: [{ key: "orgId", match: { value: input.orgId } }];
        }
      }
    }
  }
  ```

  Retrieval filters may additionally narrow by confidentiality, document ID, file type, status, or version; the IDF corpus remains organization-only. Fuse dense and BM25 with RRF, then follow Task 3's rerank/pruning path.

- [ ] **Step 7: update readiness and environment documentation**

  Document V2 collection naming, Qdrant minimum version `1.19.1`, and the V1/V2 config mapping in `.env.example` comments and readiness messages. Do not silently select V2 based only on the server version.

- [ ] **Step 8: run focused tests against real local Qdrant and commit**

  Run domain/readiness/index/search tests, start disposable Qdrant 1.19.1, initialize one V2 collection, insert Chinese fixture chunks, and prove the BM25 lane returns a Chinese keyword match. Clean the container and volume immediately afterward.

  Commit: `feat(retrieval): add multilingual Qdrant BM25`

---

### Task 5 — Add safe V2 reindex and collection cutover tooling

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260920000000_support_versioned_evidence_reindex/migration.sql`
- Create: `scripts/reindex-evidence-support.ts`
- Create: `scripts/reindex-evidence-support.test.ts`
- Create: `scripts/reindex-evidence.ts`
- Modify: `package.json`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/worker.test.ts`
- Modify: `scripts/test-integration.ts`

**Interfaces:**

- Adds `npm run evidence:reindex -- --target-config phase3.retrieval.v2-bm25 --target-collection smedc_evidence_local_v2 --dry-run` and the matching `--execute` form.
- Uses idempotency key template `evidence_document_index:${documentId}:${contentVersion}:${targetRetrievalConfigVersion}`.

- [ ] **Step 1: write failing reindex-plan tests**

  Cover active evidence only, archived/non-evidence exclusion, stable ordering, exact job keys, exact replay producing zero new jobs, conflicting runtime target rejection, and preservation of current document/index rows.

- [ ] **Step 2: remove the cross-version chunk uniqueness collision**

  The existing `@@unique([documentId, chunkHash, indexType])` prevents the same source chunk from belonging to multiple retrieval configurations. Replace it with a non-unique lookup index while retaining `@@unique([documentIndexId, chunkId])`; write a forward-only migration that drops only the obsolete unique index and adds the lookup index. Verify existing rows remain untouched.

- [ ] **Step 3: implement dry-run and execute modes**

  The script loads active, non-archived evidence documents and existing target indexes, prints counts only, and performs no writes by default. `--execute` transactionally creates missing queued processing runs using the target-version job key. It must refuse a non-local database unless `--allow-remote` is supplied and must never delete V1 runs, indexes, chunks, or points.

- [ ] **Step 4: make worker persistence version-safe**

  Ensure the worker creates a distinct `RetrievalConfig`, `DocumentIndex`, and `DocumentChunk` set for V2 and updates only that target index. A V2 reindex must not mark or delete V1 index rows. Processing replay after a worker crash must reuse the same V2 rows and point IDs.

- [ ] **Step 5: add a local dual-collection integration test**

  Upload one DOCX into V1, create V2 collection, queue V2 reindex, run a V2-configured deterministic worker pass, and prove both V1 and V2 indexes remain queryable with their matching config. Then switch the API config to V2 and prove a V1 cursor is rejected.

- [ ] **Step 6: document the controlled cutover sequence in command help**

  The operator sequence is: create V2 collection → quiesce ordinary evidence workers/uploads → queue target-version jobs → run only a V2-configured worker until all target indexes are ready → run fixture smoke → change API/worker environment to V2 → retain V1 collection for rollback. Do not automate staging mutation in this script.

- [ ] **Step 7: run focused migration/reindex tests and commit**

  Apply the migration to disposable local MySQL, run reindex support tests plus the focused integration, then clean all local state.

  Commit: `feat(evidence): add versioned reindex workflow`

---

### Task 6 — Automatically return one authorized download link per source document

**Files:**

- Create: `apps/api/src/source-document-downloads.ts`
- Create: `apps/api/src/source-document-downloads.test.ts`
- Modify: `apps/api/src/source-documents.ts`
- Modify: `apps/api/src/routes/source-documents.ts`
- Modify: `apps/api/src/routes/source-documents.test.ts`
- Modify: `apps/api/src/routes/evidence.ts`
- Modify: `apps/api/src/routes/evidence.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/app-context.ts`
- Modify: `apps/api/src/test-support/document-fixtures.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface EvidenceSourceDownload {
    sourceDocumentId: string;
    documentTitle: string;
    originalFileName: string | null;
    contentType: string | null;
    byteSize: number | null;
    downloadStatus: "available" | "unavailable";
    downloadUrl: string | null;
    expiresAt: string | null;
  }

  export interface SourceDocumentDownloadIssuer {
    issueMany(input: {
      orgId: string;
      employee: AuthenticatedEmployee;
      requestedSources: readonly {
        sourceDocumentId: string;
        documentTitle: string | null;
      }[];
      audit: RequestAuditContext;
      reason: "explicit_request" | "evidence_search_auto";
    }): Promise<{ sources: EvidenceSourceDownload[]; warnings: string[] }>;
  }
  ```

- [ ] **Step 1: write failing batch-issuance tests**

  Cover same-document dedupe, stable result order, all authorized documents receiving links, cross-org/clearance/archived documents receiving no link, one storage-signing failure not failing other links, 24-hour expiry, attachment filename preservation, and one audit row per successfully issued distinct document.

- [ ] **Step 2: add batch repository reads and audit writes**

  Add `findDownloadableSourceDocuments` accepting up to 50 distinct IDs and returning only same-org, non-archived, allowed-status documents within employee clearance. Add a batch audit method that records successful URL issuance with metadata `{ reason }`. Preserve 404/non-enumeration behavior for the explicit single-document endpoint.

- [ ] **Step 3: implement the shared issuer**

  Batch-load authorized records, call `statObject` and `createDownloadUrl` for each distinct document, and return a source entry for every requested source supplied by the already-authorized evidence page. Use the already-returned evidence title only as the unavailable entry's safe display label; never fill filename/content type/size from a record that failed the second authorization check. Use `Promise.allSettled`; an authorization race or signing failure yields `downloadStatus: "unavailable"`, null file metadata/URL/expiry, and `SOURCE_DOWNLOAD_URL_UNAVAILABLE` without failing healthy documents.

- [ ] **Step 4: make the explicit download endpoint use the shared issuer**

  Preserve the current endpoint path and response shape for successful single-document requests. Continue returning 404 for inaccessible/missing sources. This prevents separate authorization, expiry, and audit implementations from drifting.

- [ ] **Step 5: auto-enrich every non-empty evidence page**

  After `searchEvidence` completes relevance pruning, dedupe, and pagination, collect distinct `documentId` values from the visible page and unconditionally call `issueMany(... reason: "evidence_search_auto")`. Return:

  ```json
  {
    "results": [],
    "sources": [
      {
        "sourceDocumentId": "doc_...",
        "documentTitle": "肉夹馍SOP",
        "originalFileName": "肉夹馍SOP.docx",
        "contentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "byteSize": 843776,
        "downloadStatus": "available",
        "downloadUrl": "https://...",
        "expiresAt": "..."
      }
    ],
    "page": {},
    "retrieval": {},
    "warnings": []
  }
  ```

  Empty evidence results return `sources: []` and issue no links/audits. Sources contain only current-page documents.

- [ ] **Step 6: test the authorization race explicitly**

  Simulate retrieval returning a document, then archive or raise its confidentiality before issuance. The source entry must be unavailable, no URL/audit is created, and the response carries a safe warning. Do not return newly fetched title/filename metadata for a document that failed the second authorization check.

- [ ] **Step 7: run focused API/storage tests and commit**

  Run `npm test -- apps/api/src/source-document-downloads.test.ts apps/api/src/routes/source-documents.test.ts apps/api/src/routes/evidence.test.ts apps/api/src/evidence.test.ts`.

  Commit: `feat(evidence): return automatic source download links`

---

### Task 7 — Synchronize MCP contracts, launcher release, user guidance, and dual-homed skills

**Files:**

- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`
- Modify: `apps/mcp-launcher/package.json`
- Modify: `apps/mcp-launcher/src/index.test.ts`
- Modify: launcher alignment/package tests identified by `rg "0.5.0" apps/mcp-launcher packages scripts docs skills`
- Modify: `docs/implementation/api-contract.md`
- Modify: `docs/implementation/phase-3-retrieval-docs.md`
- Modify: `docs/implementation/official-user-install-and-login.md` only where the employee-facing example explains source links
- Modify: `skills/smedc-mcp/SKILL.md` and its validation fixtures
- Modify in standalone repository: corresponding `SKILL.md` and version pin

**Interfaces:**

- `search_document_evidence` result shape adds `sources[]` and expanded retrieval relevance metadata; its input schema and tool name remain unchanged.
- Launcher target version: `0.5.1`.

- [ ] **Step 1: write failing MCP contract assertions**

  Assert the search result shape advertises `results[]`, `sources[]`, `page`, `retrieval`, and `warnings`. Add an MCP HTTP pass-through test proving the launcher preserves a returned source URL and does not call `get_source_document_download_url` again.

- [ ] **Step 2: update the contract and bump launcher to 0.5.1**

  Update all package/runtime/version-alignment assertions in the same change. Do not add a new tool or a new search input option; automatic source links are server behavior.

- [ ] **Step 3: update API and retrieval documentation**

  Document V2 relevance defaults, BM25/IDF organization scope, `sources[]`, automatic issuance, 24-hour expiry, unavailable warnings, and the fact that the explicit download tool remains available for structured/quarantine flows or refreshing an expired link.

- [ ] **Step 4: update the repo-local and standalone SMEDC skills**

  The evidence-answer flow must instruct agents to display every available `sources[].downloadUrl` to the user whenever search results are used. It must not tell the agent to decide whether a link is important. Preserve authorization-safe error handling and avoid dataset-specific transformation guidance.

- [ ] **Step 5: validate and publish the launcher before pin synchronization**

  Run launcher/package tests, build and inspect the tarball, publish `smedc-mcp-launcher@0.5.1` through the existing staged release process, and independently verify a clean exact-version install plus `--version`. Do not update server recommended-version metadata or either skill pin until the public package is verified.

- [ ] **Step 6: synchronize server metadata and both skill pins**

  After publication, update the server recommendation, official acceptance pin, repo-local skill, installed canonical user skill if applicable, and standalone skill PR. Compare the repo-local and standalone skill bytes where their shared files are intended to match.

- [ ] **Step 7: commit in release-safe slices**

  Commit launcher/contract release: `feat(mcp): expose evidence source downloads`

  Commit post-publish pins/guidance: `chore(mcp): recommend launcher 0.5.1`

---

### Task 8 — Run one V2 comparison, final gates, and prepare the controlled release

**Files:**

- Modify: `docs/implementation/evidence-retrieval-v2-evaluation.md`
- Modify: `docs/implementation/progress.md`
- Modify after authorized staging work: `docs/implementation/staging-readiness.md`
- Test: focused suites from Tasks 1–7, repository-wide gates once, local integration, and one fixture-backed V2 run

- [ ] **Step 1: run the focused V2 regression once**

  In a disposable local environment using Qdrant 1.19.1 and the real configured embedding/rerank providers from `.env`, index the five fixtures into a V2 collection and run `npm run test:phase3:fixture-golden -- --run-label v2-bm25`. Confirm the `roujiamo-how-to` case returns the SOP and no unacceptable documents, no-answer can return zero, and every returned distinct document has one available source URL.

- [ ] **Step 2: record the comparison without tuning loops**

  Add one V1/V2 table to `docs/implementation/evidence-retrieval-v2-evaluation.md` containing commit/config versions, the primary metrics, the ordered documents/scores for the meat-SOP regression, no-answer behavior, and download-link coverage. If the implementation is functionally correct but marginal quality metrics are imperfect, record them and stop; do not repeatedly adjust thresholds before QA.

- [ ] **Step 3: run final repository gates once**

  Run:

  ```bash
  npm run format:check
  npm run lint
  npm run typecheck
  npm test
  npm run test:integration
  npm run test:mcp
  npm run test:phase3:golden
  npm run test:phase3:perf
  npm run build:release
  ```

  The fixture-backed real-provider comparison remains a recorded local/manual quality run, not a credential-bearing CI job.

- [ ] **Step 4: clean local test state and perform plan self-audit**

  Remove run-scoped `.data/` output, stop/remove repository-owned containers, volumes, and networks, remove clean inactive worktrees, run `git worktree prune`, and verify Docker/worktree inventories. Confirm the final diff contains no `.env`, credentials, extracted OOXML scratch files, or Word lock files.

- [ ] **Step 5: prepare PR handoff with required transparency**

  Report tests, environment changes, Qdrant minimum/version migration, launcher publication state, known limitations, QA handoff, and approximate inserted/deleted lines split across production code/config, runtime/deploy, tests/harnesses, documentation/reports, and lockfiles. Explicitly identify the evaluation report as a user-requested process artifact.

- [ ] **Step 6: after merge and explicit staging authorization, upgrade Qdrant safely**

  Read `server-runtime-prerequisites.md` and `staging-readiness.md`; snapshot the staging Qdrant volume; mirror and boot `v1.16.3`, then `v1.17.1`, then `v1.18.3`, validating health/collection access after each; finally mirror and select `v1.19.1`. Do not skip minor versions on the persistent volume and do not expose registry credentials.

- [ ] **Step 7: build and cut over the V2 staging collection**

  Create `smedc_evidence_staging_v2`, quiesce evidence upload/worker activity for the controlled reindex window, queue all active evidence documents for `phase3.retrieval.v2-bm25`, run the V2 worker until every target index is ready, run the fixture smoke once, then set `RETRIEVAL_CONFIG_VERSION=phase3.retrieval.v2-bm25` and `QDRANT_COLLECTION_EVIDENCE=smedc_evidence_staging_v2` through the canonical staging release. Keep the V1 collection and previous environment values for rollback; never roll back Prisma migrations.

- [ ] **Step 8: hand off to QA instead of running repeated optimization**

  Record release SHA, V2 collection name, readiness result, fixture smoke summary, and rollback values in `staging-readiness.md`. Stop after the agreed smoke; QA performs the broader manual acceptance and the product owner decides whether another retrieval-tuning round is needed.

  Commit documentation/handoff: `docs(evidence): record retrieval V2 evaluation and release`

---

## Completion Criteria

- The five approved DOCX fixtures and judged manifest are committed without temporary/system files or prohibited sensitive material.
- V2 lexical retrieval uses Qdrant native multilingual BM25 with organization-scoped IDF; the hashed term-frequency encoder is used only by V1 rollback compatibility.
- V2 rerank output is filtered by the versioned floor/gap policy before pagination and can legitimately return zero results.
- Every non-empty evidence page attempts automatic download issuance and returns exactly one `sources[]` entry per distinct visible source document; healthy sources include 24-hour URLs.
- The V1 baseline and one V2 run are recorded once, with no open-ended tuning loop.
- Unit, integration, MCP, existing golden/performance, and release-build gates pass; local test residue is removed.
- Launcher `0.5.1`, server recommendation, API docs, repo-local skill, and standalone skill are synchronized in the required publication order.
- Staging remains on V1 until an explicitly authorized, snapshot-backed Qdrant upgrade/reindex/cutover completes; V1 remains available for rollback afterward.
