import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  evaluateEvidenceFixtureCases,
  loadEvidenceFixtureManifest,
  type EvidenceCaseObservation,
  type EvidenceFixtureDocument
} from "./evidence-fixture-golden-support.js";

interface EvidenceUploadResponse {
  document: { documentId: string; status: string };
}

interface EvidenceStatusResponse {
  document: { documentId: string; status: string };
  documentIndex: { status: string; retrievalConfigVersion?: string };
}

interface EvidenceSearchResponse {
  results: Array<{
    chunkId: string;
    documentId: string;
    score?: { hybrid?: number; rerank?: number | null };
  }>;
  retrieval: Record<string, unknown> & { retrievalConfigVersion: string };
  warnings?: string[];
  sources?: Array<{
    sourceDocumentId?: string;
    documentId?: string;
    downloadUrl?: string | null;
  }>;
}

interface Arguments {
  runLabel: string;
  outputPath: string;
  manifestPath: string;
  allowRemote: boolean;
}

const DEFAULT_MANIFEST = path.join(process.cwd(), "fixtures/evidence/maijia/golden.json");
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export async function runEvidenceFixtureGolden(input: {
  arguments: Arguments;
  apiBaseUrl: string;
  accessToken: string;
  gitSha?: string;
}) {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  assertAllowedTarget(apiBaseUrl, input.arguments.allowRemote);
  const manifest = await loadEvidenceFixtureManifest(input.arguments.manifestPath);
  const gitSha = input.gitSha ?? currentGitSha();
  const headers = { authorization: `Bearer ${input.accessToken}` };
  const documentIdToFixture = new Map<string, string>();
  const uploads: Array<{ fixtureId: string; documentId: string }> = [];

  for (const fixture of manifest.documents) {
    const upload = await uploadFixture({
      apiBaseUrl,
      headers,
      fixture,
      manifestDirectory: path.dirname(path.resolve(input.arguments.manifestPath)),
      runLabel: input.arguments.runLabel
    });
    uploads.push({ fixtureId: fixture.fixtureId, documentId: upload.document.documentId });
    documentIdToFixture.set(upload.document.documentId, fixture.fixtureId);
  }

  for (const upload of uploads) {
    await waitForIndexed(apiBaseUrl, headers, upload.documentId);
  }

  const observations: EvidenceCaseObservation[] = [];
  for (const fixtureCase of manifest.cases) {
    const search = await apiJson<EvidenceSearchResponse>(apiBaseUrl, "/v1/evidence/search", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        query: fixtureCase.query,
        filters: { documentIds: uploads.map((upload) => upload.documentId) },
        limit: 50
      })
    });
    const downloadByDocumentId = new Map(
      (search.sources ?? [])
        .map((source) => [source.sourceDocumentId ?? source.documentId, source.downloadUrl ?? null])
        .filter((entry): entry is [string, string | null] => typeof entry[0] === "string")
    );

    observations.push({
      caseId: fixtureCase.caseId,
      runLabel: input.arguments.runLabel,
      gitSha,
      retrieval: { ...search.retrieval, warnings: search.warnings ?? [] },
      results: search.results.map((result) => {
        const fixtureId = documentIdToFixture.get(result.documentId);
        if (!fixtureId) {
          throw new Error(
            `Search case ${fixtureCase.caseId} returned document outside the uploaded fixture scope.`
          );
        }
        return {
          documentId: result.documentId,
          fixtureId,
          chunkId: result.chunkId,
          hybridScore: typeof result.score?.hybrid === "number" ? result.score.hybrid : null,
          rerankScore: typeof result.score?.rerank === "number" ? result.score.rerank : null,
          downloadUrl: downloadByDocumentId.get(result.documentId) ?? null
        };
      })
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    manifestPath: path.relative(process.cwd(), input.arguments.manifestPath),
    uploads,
    observations,
    summary: evaluateEvidenceFixtureCases(manifest, observations)
  };
  await mkdir(path.dirname(input.arguments.outputPath), { recursive: true });
  await writeFile(input.arguments.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function uploadFixture(input: {
  apiBaseUrl: URL;
  headers: Record<string, string>;
  fixture: EvidenceFixtureDocument;
  manifestDirectory: string;
  runLabel: string;
}): Promise<EvidenceUploadResponse> {
  const fixturePath = path.resolve(input.manifestDirectory, input.fixture.path);
  const content = await readFile(fixturePath);
  const form = new FormData();
  form.append("file", new Blob([content]), path.basename(fixturePath));
  form.append("title", input.fixture.title);
  form.append("sourceSystem", `fixture_golden:${input.runLabel}`.slice(0, 255));
  form.append("confidentialityLevel", String(input.fixture.confidentialityLevel));

  return apiJson(input.apiBaseUrl, "/v1/documents/evidence", {
    method: "POST",
    headers: input.headers,
    body: form
  });
}

async function waitForIndexed(
  apiBaseUrl: URL,
  headers: Record<string, string>,
  documentId: string
) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const response = await apiJson<EvidenceStatusResponse>(
      apiBaseUrl,
      `/v1/documents/evidence/${encodeURIComponent(documentId)}/status`,
      { headers }
    );
    lastStatus = `${response.document.status}/${response.documentIndex.status}`;
    if (response.document.status === "active" && response.documentIndex.status === "ready") {
      return;
    }
    if (response.document.status === "failed" || response.documentIndex.status === "failed") {
      throw new Error(`Fixture ${documentId} failed indexing; last=${lastStatus}.`);
    }
    await delay(2_000);
  }

  throw new Error(`Fixture ${documentId} was not indexed within 10 minutes; last=${lastStatus}.`);
}

async function apiJson<T>(apiBaseUrl: URL, pathname: string, init: RequestInit): Promise<T> {
  const response = await fetch(new URL(pathname, apiBaseUrl), init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${pathname}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  let allowRemote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-remote") {
      allowRemote = true;
      continue;
    }
    if (argument === "--run-label" || argument === "--output" || argument === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}.`);
  }

  const runLabel = values.get("--run-label");
  const outputPath = values.get("--output");
  if (!runLabel || !outputPath) {
    throw new Error(
      "Usage: --run-label <label> --output <path> [--manifest <path>] [--allow-remote]"
    );
  }

  return {
    runLabel,
    outputPath: path.resolve(outputPath),
    manifestPath: path.resolve(values.get("--manifest") ?? DEFAULT_MANIFEST),
    allowRemote
  };
}

function normalizeApiBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SMEDC_BASE_URL must use http or https.");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function assertAllowedTarget(url: URL, allowRemote: boolean) {
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (!loopback && !allowRemote) {
    throw new Error(
      `Refusing non-loopback SMEDC_BASE_URL ${url.origin}; pass --allow-remote explicitly. Remote runs never perform cleanup.`
    );
  }
}

function currentGitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const apiBaseUrl = process.env["SMEDC_BASE_URL"];
  const accessToken = process.env["SMEDC_ACCESS_TOKEN"];
  if (!apiBaseUrl || !accessToken) {
    throw new Error("SMEDC_BASE_URL and SMEDC_ACCESS_TOKEN are required.");
  }
  const report = await runEvidenceFixtureGolden({
    arguments: arguments_,
    apiBaseUrl,
    accessToken
  });
  console.log(
    JSON.stringify(
      {
        outputPath: arguments_.outputPath,
        runLabel: report.summary.runLabel,
        gitSha: report.summary.gitSha,
        retrieval: report.summary.retrieval,
        metrics: report.summary.metrics
      },
      null,
      2
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
