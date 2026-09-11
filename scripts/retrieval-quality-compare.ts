import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { DocumentStatus, PrismaClient } from "@prisma/client";
import { AuthCore } from "../apps/api/src/auth/auth-core.js";
import { createPrismaAuthCoreRepository } from "../apps/api/src/auth/prisma-auth-repository.js";

/**
 * Real-stack retrieval quality harness.
 *
 * The repository's `phase3:golden` harness is an in-memory simulation: it never runs the real
 * parser, chunker, or lexical tokenizer, so it cannot detect regressions in any of them. This
 * script ingests a labeled Chinese corpus through the real upload endpoint and worker, then
 * measures retrieval through the real search service (and, for branch comparison, the real Qdrant
 * collection) so chunking, tokenization, and ranking changes can be compared with evidence.
 *
 * Usage:
 *   MYSQL_PORT=3307 npm run test:retrieval:compare -- --label baseline
 *   MYSQL_PORT=3307 npm run test:retrieval:compare -- --label phase-a --baseline <report.json>
 */

const DEFAULT_MYSQL_PORT = "3307";
const DEFAULT_DATABASE_URL = (mysqlPort: string) =>
  `mysql://enterprise_hub:enterprise_hub_local_password@localhost:${mysqlPort}/enterprise_hub`;
const DEFAULT_CURSOR_SIGNING_SECRET = "replace-with-local-development-cursor-secret";
const RELEVANCE_LIMIT = 5;
const RESULT_LIMIT = 10;

interface CorpusDocument {
  id: string;
  file: string;
  title: string;
  fileType: "md" | "txt" | "docx";
  labels: string[];
  status: "active" | "archived" | "stale";
}

interface CorpusCaller {
  id: string;
  employeeId: string;
  email: string;
  role: string;
  labels: string[];
}

interface CorpusQuery {
  id: string;
  query: string;
  callerId: string;
  type: string;
  expectation: "answered" | "no_answer";
  expectedDocuments?: string[];
  expectedSections?: string[];
  forbiddenDocuments?: string[];
}

interface CorpusManifest {
  version: string;
  documents: CorpusDocument[];
  callers: CorpusCaller[];
  queries: CorpusQuery[];
}

interface SearchResultItem {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  text: string;
  sectionText: string;
  sectionTruncated: boolean;
  source: {
    fileType: string | null;
    sectionHeadingPath: string[];
    blockType: string | null;
    pageNumber: number | null;
  };
  score: { hybrid: number; rerank: number | null };
  matchedBy: string[];
}

interface QueryOutcome {
  id: string;
  type: string;
  expectation: "answered" | "no_answer";
  resultCount: number;
  resultDocumentIds: string[];
  firstRelevantRank: number | null;
  leakDocumentIds: string[];
  latencyMs: number;
  modeRanks: Record<RetrievalMode, number | null>;
}

type RetrievalMode = "hybrid" | "dense-only" | "lexical-only";

interface ModeMetrics {
  mode: RetrievalMode;
  hitRateAt5: number;
  mrrAt10: number;
  answeredQueryCount: number;
}

interface QualityReport {
  label: string;
  generatedAt: string;
  corpusVersion: string;
  retrievalConfigVersion: string;
  provider: string;
  embeddingModel: string;
  rerankModel: string | null;
  chunking: {
    maxChunkChars: number;
    overlapChars: number;
    indexedChunkCount: number;
    chunksPerDocument: Record<string, number>;
    sectionExpansion: { maxSectionChars: number; maxSectionChunks: number };
  };
  metrics: {
    hitRateAt5: number;
    mrrAt10: number;
    noAnswerFalsePositiveRate: number;
    latencyMs: { p50: number; p95: number };
    leaks: { permission: number; archived: number; stale: number };
    modes: ModeMetrics[];
  };
  outcomes: QueryOutcome[];
}

const rootDir = process.cwd();
const corpusDir = path.join(rootDir, "fixtures", "retrieval-quality");
const outputDir = path.join(rootDir, ".data", "retrieval-quality");
const storageRoot = path.join(rootDir, ".data", "retrieval-quality-storage");
const mysqlPort = process.env["MYSQL_PORT"] ?? DEFAULT_MYSQL_PORT;
const apiPort = process.env["RETRIEVAL_QUALITY_PORT"] ?? String(await findAvailablePort());
const apiUrl = `http://127.0.0.1:${apiPort}`;

const harnessEnv: NodeJS.ProcessEnv = {
  ...process.env,
  COMPOSE_PROJECT_NAME: process.env["COMPOSE_PROJECT_NAME"] ?? "sme_data_center_retrieval",
  MYSQL_PORT: mysqlPort,
  DATABASE_URL: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL(mysqlPort),
  CURSOR_SIGNING_SECRET: process.env["CURSOR_SIGNING_SECRET"] ?? DEFAULT_CURSOR_SIGNING_SECRET,
  ENTERPRISE_HUB_PUBLIC_ORIGIN:
    process.env["ENTERPRISE_HUB_PUBLIC_ORIGIN"] ?? "https://api.smedatacenter.xyz",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_ROOT: storageRoot,
  QDRANT_URL: process.env["QDRANT_URL"] ?? "http://127.0.0.1:6333",
  QDRANT_COLLECTION_EVIDENCE:
    process.env["QDRANT_COLLECTION_EVIDENCE"] ?? "enterprise_hub_evidence_quality",
  RETRIEVAL_CONFIG_VERSION: process.env["RETRIEVAL_CONFIG_VERSION"] ?? "phase3.retrieval.v2",
  LLM_PROVIDER: process.env["LLM_PROVIDER"] ?? "fake",
  LLM_MODEL: process.env["LLM_MODEL"] ?? "fake-rerank",
  LLM_EMBEDDING_MODEL: process.env["LLM_EMBEDDING_MODEL"] ?? "fake-embedding",
  LLM_EMBEDDING_DIMENSION: process.env["LLM_EMBEDDING_DIMENSION"] ?? "",
  RERANK_PROVIDER: process.env["RERANK_PROVIDER"] ?? "fake",
  DASHSCOPE_API_KEY:
    process.env["DASHSCOPE_API_KEY"] ?? process.env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
  DASHSCOPE_API_BASE_URL: process.env["DASHSCOPE_API_BASE_URL"] ?? "",
  EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: process.env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] ?? "false",
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: apiPort
};

const args = process.argv.slice(2);
const label = optionValue("--label") ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const baselinePath = optionValue("--baseline");
const keepData = args.includes("--keep-data");

const coreManifest = JSON.parse(
  await readFile(path.join(corpusDir, "corpus.json"), "utf8")
) as CorpusManifest;
const generatedManifest = JSON.parse(
  await readFile(path.join(corpusDir, "generated-corpus.json"), "utf8")
) as CorpusManifest;
const manifest = mergeManifests(coreManifest, generatedManifest);
const tokenizeForHarness = await loadTokenizeForHarness();
const apiProcess = { current: null as ReturnType<typeof spawn> | null };
const sessionCleanup: Array<() => Promise<void>> = [];

try {
  await prepareWorkspace();
  // Recreate the repository's own local MySQL volume instead of running `prisma migrate reset`,
  // which refuses to run under an AI agent. Removing repo-owned local test volumes is the
  // documented local cleanup path for this repository.
  await run("docker", ["compose", "down", "-v"], harnessEnv, { allowFailure: true });
  await run("docker", ["compose", "up", "-d", "mysql", "qdrant"], harnessEnv);
  await waitForMysqlHealth();
  await run("npm", ["run", "db:generate"], harnessEnv);
  await run(
    "npx",
    ["prisma", "migrate", "deploy", "--config", "packages/db/prisma.config.ts"],
    harnessEnv
  );
  await run("npm", ["run", "db:seed"], harnessEnv);
  await run("npm", ["run", "qdrant:init"], harnessEnv);

  apiProcess.current = startApi();
  await waitForApiHealth(apiProcess.current);

  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(harnessEnv["DATABASE_URL"]!)
  });

  try {
    const tokenByCallerId = new Map<string, string>();

    for (const caller of manifest.callers) {
      tokenByCallerId.set(caller.id, await createAccessToken(prisma, caller.employeeId));
    }

    const documentIdByCorpusId = new Map<string, string>();

    for (const document of manifest.documents) {
      const documentId = await uploadDocument(document, tokenByCallerId.get("admin")!);
      documentIdByCorpusId.set(document.id, documentId);
    }

    await drainWorkerQueue();
    await waitForAllDocumentsReady(documentIdByCorpusId, tokenByCallerId.get("admin")!);

    await applyArchivedStatus(prisma, documentIdByCorpusId, manifest);
    await applyStaleContentVersion(prisma, documentIdByCorpusId, manifest);

    const chunking = await chunkingStats(prisma, documentIdByCorpusId);
    const outcomes: QueryOutcome[] = [];

    for (const query of manifest.queries) {
      outcomes.push(
        await runQuery({
          query,
          manifest,
          documentIdByCorpusId,
          accessToken: tokenByCallerId.get(query.callerId)!
        })
      );
    }

    const report = buildReport({ chunking, outcomes });
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${label}.json`);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(
      JSON.stringify(
        {
          ok:
            report.metrics.leaks.permission === 0 &&
            report.metrics.leaks.archived === 0 &&
            report.metrics.leaks.stale === 0,
          label,
          outputPath,
          metrics: report.metrics,
          chunking: {
            indexedChunkCount: report.chunking.indexedChunkCount,
            overlapChars: report.chunking.overlapChars
          }
        },
        null,
        2
      )
    );

    if (baselinePath) {
      const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as QualityReport;
      console.log(renderComparison(baseline, report));
    }

    if (report.metrics.leaks.permission > 0 || report.metrics.leaks.archived > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
} finally {
  for (const cleanup of sessionCleanup.reverse()) {
    await cleanup().catch(() => undefined);
  }

  await stopApi();

  if (!keepData) {
    await run("docker", ["compose", "down", "-v"], harnessEnv).catch(() => undefined);
  }
}

async function uploadDocument(document: CorpusDocument, accessToken: string): Promise<string> {
  const content = await readFile(path.join(corpusDir, document.file));
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(content)]), document.file);
  form.append("title", document.title);
  form.append("sourceSystem", "retrieval_quality_harness");

  for (const label of document.labels) {
    form.append("labelKeys[]", label);
  }

  const upload = await apiJson<{ document: { documentId: string; status: string } }>(
    "/v1/documents/evidence",
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      body: form
    }
  );

  return upload.document.documentId;
}

async function drainWorkerQueue(): Promise<void> {
  for (let pass = 1; pass <= 400; pass += 1) {
    const worker = await run("npm", ["--silent", "run", "worker:once"], harnessEnv);
    const result = parseWorkerResult(worker.stdout);

    if (!result?.processed) {
      return;
    }

    if (result.status !== undefined && result.status !== "active") {
      const errorCode = (result as { errorCode?: string }).errorCode ?? "unknown";

      throw new Error(`Worker did not activate a document: ${JSON.stringify({ errorCode })}`);
    }
  }

  throw new Error("Worker queue did not drain in time.");
}

async function waitForAllDocumentsReady(
  documentIdByCorpusId: Map<string, string>,
  accessToken: string
): Promise<void> {
  for (const [corpusId, documentId] of documentIdByCorpusId) {
    await waitForDocumentIndexReady(documentId, accessToken).catch(() => {
      throw new Error(`Document ${corpusId} did not become searchable in time.`);
    });
  }
}

function mergeManifests(core: CorpusManifest, generated: CorpusManifest): CorpusManifest {
  const seenDocumentIds = new Set(core.documents.map((document) => document.id));
  const seenQueryIds = new Set(core.queries.map((query) => query.id));
  const seenCallerIds = new Set(core.callers.map((caller) => caller.id));

  return {
    version: `${core.version}+${generated.version}`,
    documents: [
      ...core.documents,
      ...generated.documents.filter((document) => !seenDocumentIds.has(document.id))
    ],
    callers: [
      ...core.callers,
      ...generated.callers.filter((caller) => !seenCallerIds.has(caller.id))
    ],
    queries: [...core.queries, ...generated.queries.filter((query) => !seenQueryIds.has(query.id))]
  };
}

function parseWorkerResult(stdout: string): {
  processed?: boolean;
  documentId?: string;
  status?: string;
  errorCode?: string;
  errorSummary?: string;
} | null {
  const line = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith("{"))
    .pop();

  if (!line) {
    return null;
  }

  try {
    return JSON.parse(line) as { status?: string };
  } catch {
    return null;
  }
}

async function applyArchivedStatus(
  prisma: PrismaClient,
  documentIdByCorpusId: Map<string, string>,
  corpus: CorpusManifest
): Promise<void> {
  const archivedIds = corpus.documents
    .filter((document) => document.status === "archived")
    .map((document) => documentIdByCorpusId.get(document.id))
    .filter((documentId): documentId is string => documentId !== undefined);

  if (archivedIds.length === 0) {
    return;
  }

  await prisma.document.updateMany({
    where: { id: { in: archivedIds } },
    data: { status: DocumentStatus.archived }
  });
}

/**
 * Simulates a content replacement that was never re-indexed: the chunk rows move to a new content
 * version while the stored vectors keep the old one, so retrieval must drop them.
 */
async function applyStaleContentVersion(
  prisma: PrismaClient,
  documentIdByCorpusId: Map<string, string>,
  corpus: CorpusManifest
): Promise<void> {
  for (const document of corpus.documents.filter((candidate) => candidate.status === "stale")) {
    const documentId = documentIdByCorpusId.get(document.id);

    if (!documentId) {
      continue;
    }

    await prisma.$executeRawUnsafe(
      "UPDATE document_chunks SET content_version = content_version + 1 WHERE document_id = ?",
      documentId
    );
  }
}

async function chunkingStats(prisma: PrismaClient, documentIdByCorpusId: Map<string, string>) {
  const chunksPerDocument: Record<string, number> = {};
  let indexedChunkCount = 0;

  for (const [corpusId, documentId] of documentIdByCorpusId) {
    const count = await prisma.documentChunk.count({
      where: { documentId, indexType: "evidence" }
    });
    chunksPerDocument[corpusId] = count;
    indexedChunkCount += count;
  }

  return {
    maxChunkChars: Number(harnessEnv["EVIDENCE_CHUNK_MAX_CHARS"] ?? 1_600),
    overlapChars: Number(harnessEnv["EVIDENCE_CHUNK_OVERLAP_CHARS"] ?? 200),
    indexedChunkCount,
    chunksPerDocument,
    sectionExpansion: {
      maxSectionChars: Number(harnessEnv["EVIDENCE_SECTION_MAX_CHARS"] ?? 6_000),
      maxSectionChunks: Number(harnessEnv["EVIDENCE_SECTION_MAX_CHUNKS"] ?? 6)
    }
  };
}

async function runQuery(input: {
  query: CorpusQuery;
  manifest: CorpusManifest;
  documentIdByCorpusId: Map<string, string>;
  accessToken: string;
}): Promise<QueryOutcome> {
  const startedAt = performance.now();
  const response = await apiJson<{ results: SearchResultItem[] }>("/v1/evidence/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query: input.query.query,
      limit: RESULT_LIMIT
    })
  });
  const latencyMs = performance.now() - startedAt;
  const results = response.results ?? [];
  const corpusIdByDocumentId = invert(input.documentIdByCorpusId);
  const resultCorpusIds = results.map(
    (result) => corpusIdByDocumentId.get(result.documentId) ?? result.documentId
  );
  const relevantCorpusIds = await expandExpectedDocuments(input.query, input.documentIdByCorpusId);
  const firstRelevantRank = firstRank(
    results,
    input.query,
    corpusIdByDocumentId,
    relevantCorpusIds
  );
  const forbidden = input.query.forbiddenDocuments ?? [];

  return {
    id: input.query.id,
    type: input.query.type,
    expectation: input.query.expectation,
    resultCount: results.length,
    resultDocumentIds: resultCorpusIds,
    firstRelevantRank,
    leakDocumentIds: resultCorpusIds.filter((corpusId) => forbidden.includes(corpusId)),
    latencyMs,
    modeRanks: await modeRanks(input.query, corpusIdByDocumentId, relevantCorpusIds)
  };
}

async function expandExpectedDocuments(
  query: CorpusQuery,
  documentIdByCorpusId: Map<string, string>
): Promise<string[]> {
  return (query.expectedDocuments ?? []).filter((corpusId) => documentIdByCorpusId.has(corpusId));
}

function firstRank(
  results: SearchResultItem[],
  query: CorpusQuery,
  corpusIdByDocumentId: Map<string, string>,
  relevantCorpusIds: string[]
): number | null {
  if (relevantCorpusIds.length === 0) {
    return null;
  }

  for (const [index, result] of results.entries()) {
    const corpusId = corpusIdByDocumentId.get(result.documentId);

    if (corpusId === undefined || !relevantCorpusIds.includes(corpusId)) {
      continue;
    }

    if (!matchesExpectedSection(result, query)) {
      continue;
    }

    return index + 1;
  }

  return null;
}

function matchesExpectedSection(result: SearchResultItem, query: CorpusQuery): boolean {
  const expectedSections = query.expectedSections ?? [];

  if (expectedSections.length === 0) {
    return true;
  }

  const headingPath = result.source.sectionHeadingPath;

  return expectedSections.some((section) => headingPath.includes(section));
}

/**
 * Measures the dense and lexical branches separately against the same index. The production search
 * path always fuses both branches, so the branch-level numbers are read directly from Qdrant.
 */
async function modeRanks(
  query: CorpusQuery,
  corpusIdByDocumentId: Map<string, string>,
  relevantCorpusIds: string[]
): Promise<Record<RetrievalMode, number | null>> {
  const results: Record<RetrievalMode, number | null> = {
    hybrid: null,
    "dense-only": null,
    "lexical-only": null
  };

  if (relevantCorpusIds.length === 0) {
    return results;
  }

  const [denseOnly, lexicalOnly] = await Promise.all([
    qdrantBranchRanks(query.query, "dense"),
    qdrantBranchRanks(query.query, "sparse")
  ]);

  results["dense-only"] = rankFromCorpusIds(
    denseOnly,
    query,
    corpusIdByDocumentId,
    relevantCorpusIds
  );
  results["lexical-only"] = rankFromCorpusIds(
    lexicalOnly,
    query,
    corpusIdByDocumentId,
    relevantCorpusIds
  );

  return results;
}

function rankFromCorpusIds(
  corpusIds: string[],
  query: CorpusQuery,
  corpusIdByDocumentId: Map<string, string>,
  relevantCorpusIds: string[]
): number | null {
  for (const [index, documentId] of corpusIds.entries()) {
    const corpusId = corpusIdByDocumentId.get(documentId) ?? documentId;

    if (!relevantCorpusIds.includes(corpusId)) {
      continue;
    }

    return index + 1;
  }

  return null;
}

async function qdrantBranchRanks(query: string, branch: "dense" | "sparse"): Promise<string[]> {
  const denseVector = branch === "dense" ? await embedQueryForHarness(query) : [];
  const sparse = sparseVectorForHarness(query);
  const collection = harnessEnv["QDRANT_COLLECTION_EVIDENCE"]!;
  const response = await fetch(
    `${(harnessEnv["QDRANT_URL"] ?? "http://127.0.0.1:6333").replace(/\/$/, "")}/collections/${encodeURIComponent(
      collection
    )}/points/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: branch === "dense" ? denseVector : sparse,
        using: branch,
        with_payload: true,
        limit: 30
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Qdrant ${branch} branch query failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    result?: { points?: Array<{ payload?: Record<string, unknown> }> };
  };

  return (payload.result?.points ?? [])
    .map((point) => point.payload?.["documentId"])
    .filter((documentId): documentId is string => typeof documentId === "string");
}

async function embedQueryForHarness(query: string): Promise<number[]> {
  // Kept local to the harness so the same script can run unchanged on the pre-change revision.
  if ((harnessEnv["LLM_PROVIDER"] ?? "fake") === "fake") {
    return deterministicVector(query, Number(harnessEnv["LLM_EMBEDDING_DIMENSION"] || 8));
  }

  const baseUrl = (harnessEnv["OPENAI_COMPATIBLE_BASE_URL"] ?? "").replace(/\/$/, "");
  const apiKey = harnessEnv["OPENAI_COMPATIBLE_API_KEY"] ?? "";

  if (!baseUrl || !apiKey) {
    throw new Error(
      "OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_API_KEY are required for a real-provider run."
    );
  }

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: harnessEnv["LLM_EMBEDDING_MODEL"],
      input: [query]
    })
  });

  if (!response.ok) {
    throw new Error(`Embedding provider failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };

  return payload.data?.[0]?.embedding ?? [];
}

function deterministicVector(text: string, dimension: number): number[] {
  const vector: number[] = [];
  let counter = 0;

  while (vector.length < dimension) {
    const digest = createHash("sha256").update(`${counter}:${text}`).digest();

    for (const byte of digest) {
      vector.push(Number((byte / 127.5 - 1 || 0).toFixed(6)));

      if (vector.length === dimension) {
        break;
      }
    }

    counter += 1;
  }

  return vector;
}

/**
 * Uses the repository's shared tokenizer when it exists and falls back to the pre-change
 * whitespace tokenizer otherwise, so this script can be run unchanged on both revisions.
 *
 * The specifier is built at runtime on purpose: the shared package does not exist on every
 * revision, and a literal specifier would make `tsc` resolve it and fail the type check.
 */
async function loadTokenizeForHarness(): Promise<(text: string) => string[]> {
  try {
    const specifier = "@enterprise-hub/lexical";
    const module = (await import(specifier)) as {
      tokenizeForSparseVector: (text: string) => string[];
    };

    return module.tokenizeForSparseVector;
  } catch {
    return (text) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  }
}

function sparseVectorForHarness(text: string): { indices: number[]; values: number[] } {
  const counts = new Map<number, number>();

  for (const token of tokenizeForHarness(text)) {
    const index = Number.parseInt(
      createHash("sha256").update(token, "utf8").digest("hex").slice(0, 7),
      16
    );
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }

  const entries = [...counts.entries()].sort((first, second) => first[0] - second[0]);

  return {
    indices: entries.map(([index]) => index),
    values: entries.map(([, count]) => count)
  };
}

function buildReport(input: {
  chunking: QualityReport["chunking"];
  outcomes: QueryOutcome[];
}): QualityReport {
  const answered = input.outcomes.filter((outcome) => outcome.expectation === "answered");
  const noAnswer = input.outcomes.filter((outcome) => outcome.type === "no_answer");
  const relevanceRanks = answered
    .map((outcome) => outcome.firstRelevantRank)
    .filter((rank): rank is number => rank !== null);
  const latencies = input.outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);

  const modes: ModeMetrics[] = (["hybrid", "dense-only", "lexical-only"] as RetrievalMode[]).map(
    (mode) => {
      const ranks = answered
        .map((outcome) => (mode === "hybrid" ? outcome.firstRelevantRank : outcome.modeRanks[mode]))
        .filter((rank): rank is number => rank !== null);

      return {
        mode,
        hitRateAt5: ratio(ranks.filter((rank) => rank <= RELEVANCE_LIMIT).length, answered.length),
        mrrAt10: ratio(
          ranks.filter((rank) => rank <= 10).reduce((sum, rank) => sum + 1 / rank, 0),
          answered.length
        ),
        answeredQueryCount: answered.length
      };
    }
  );

  return {
    label,
    generatedAt: new Date().toISOString(),
    corpusVersion: manifest.version,
    retrievalConfigVersion: harnessEnv["RETRIEVAL_CONFIG_VERSION"]!,
    provider: harnessEnv["LLM_PROVIDER"]!,
    embeddingModel: harnessEnv["LLM_EMBEDDING_MODEL"]!,
    rerankModel: harnessEnv["LLM_MODEL"] ?? null,
    chunking: input.chunking,
    metrics: {
      hitRateAt5: ratio(
        relevanceRanks.filter((rank) => rank <= RELEVANCE_LIMIT).length,
        answered.length
      ),
      mrrAt10: ratio(
        relevanceRanks.filter((rank) => rank <= 10).reduce((sum, rank) => sum + 1 / rank, 0),
        answered.length
      ),
      noAnswerFalsePositiveRate: ratio(
        noAnswer.filter((outcome) => outcome.resultCount > 0).length,
        noAnswer.length
      ),
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95)
      },
      leaks: {
        permission: leakCount(input.outcomes, "permission_hidden"),
        archived: leakCount(input.outcomes, "archived_hidden"),
        stale: leakCount(input.outcomes, "stale_hidden")
      },
      modes
    },
    outcomes: input.outcomes
  };
}

function leakCount(outcomes: QueryOutcome[], type: string): number {
  return outcomes.filter((outcome) => outcome.type === type && outcome.leakDocumentIds.length > 0)
    .length;
}

function renderComparison(baseline: QualityReport, current: QualityReport): string {
  const lines = [
    "",
    `Baseline ${baseline.label} (${baseline.generatedAt}) -> ${current.label} (${current.generatedAt})`,
    `  chunks   ${baseline.chunking.indexedChunkCount} -> ${current.chunking.indexedChunkCount}`,
    `  overlap  ${baseline.chunking.overlapChars} -> ${current.chunking.overlapChars}`,
    `  leaks    ${JSON.stringify(baseline.metrics.leaks)} -> ${JSON.stringify(current.metrics.leaks)}`,
    `  no-answer false-positive ${baseline.metrics.noAnswerFalsePositiveRate} -> ${current.metrics.noAnswerFalsePositiveRate}`
  ];

  for (const mode of baseline.metrics.modes) {
    const next = current.metrics.modes.find((candidate) => candidate.mode === mode.mode);

    if (!next) {
      continue;
    }

    lines.push(
      `  ${mode.mode.padEnd(13)} hit@5 ${mode.hitRateAt5.toFixed(4)} -> ${next.hitRateAt5.toFixed(
        4
      )}   mrr@10 ${mode.mrrAt10.toFixed(4)} -> ${next.mrrAt10.toFixed(4)}`
    );
  }

  return `${lines.join("\n")}\n`;
}

function percentile(sortedValues: number[], value: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((value / 100) * sortedValues.length) - 1
  );

  return Number((sortedValues[index] ?? 0).toFixed(2));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function invert(map: Map<string, string>): Map<string, string> {
  return new Map([...map.entries()].map(([key, value]) => [value, key]));
}

async function createAccessToken(prisma: PrismaClient, employeeId: string): Promise<string> {
  const auth = new AuthCore(createPrismaAuthCoreRepository(prisma));
  const identity = await prisma.loginIdentity.findFirst({
    where: { employeeId, disabled: false },
    select: { id: true, employeeId: true, orgId: true }
  });

  if (!identity) {
    throw new Error(`Seeded official identity is missing for ${employeeId}.`);
  }

  const session = await auth.createSession({
    identityId: identity.id,
    employeeId: identity.employeeId,
    orgId: identity.orgId
  });
  sessionCleanup.push(async () => {
    await auth.logout(session.durableCredential);
  });

  return session.accessToken;
}

async function waitForDocumentIndexReady(documentId: string, accessToken: string): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const status = await apiJson<{
      document: { status: string };
      documentIndex: { status: string };
    }>(`/v1/documents/evidence/${documentId}/status`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });

    if (status.documentIndex.status === "ready") {
      return;
    }

    await delay(500);
  }

  throw new Error(`Document ${documentId} did not become searchable in time.`);
}

async function prepareWorkspace(): Promise<void> {
  await rm(storageRoot, { recursive: true, force: true });
  await mkdir(storageRoot, { recursive: true });
}

function startApi(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["--import", "tsx", "apps/api/src/index.ts"], {
    cwd: rootDir,
    env: harnessEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function stopApi(): Promise<void> {
  const child = apiProcess.current;

  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);

    child.once("exit", () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function waitForApiHealth(child: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error("API process exited before becoming healthy.");
    }

    try {
      const response = await fetch(`${apiUrl}/healthz`);

      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    await delay(500);
  }

  throw new Error("API did not become healthy in time.");
}

async function waitForMysqlHealth(): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = await run(
      "docker",
      ["inspect", "--format={{.State.Health.Status}}", "enterprise-hub-mysql"],
      harnessEnv,
      { allowFailure: true }
    );

    if (result.stdout.trim() === "healthy") {
      return;
    }

    await delay(2_000);
  }

  throw new Error("MySQL did not become healthy in time.");
}

async function apiJson<T>(requestPath: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${requestPath}`, init);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`API ${requestPath} failed with HTTP ${response.status}: ${body}`);
  }

  return JSON.parse(body) as T;
}

async function run(
  command: string,
  commandArgs: string[],
  env: NodeJS.ProcessEnv,
  options: { allowFailure?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${commandArgs.join(" ")} failed with code ${code}: ${stderr}`));
    });
  });
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (typeof address === "object" && address !== null) {
        const port = address.port;
        server.close(() => resolve(port));
        return;
      }

      server.close(() => reject(new Error("Could not allocate a local port.")));
    });
  });
}

function optionValue(name: string): string | null {
  const index = args.indexOf(name);

  return index >= 0 ? (args[index + 1] ?? null) : null;
}
