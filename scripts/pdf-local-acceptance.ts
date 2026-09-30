import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { parseRuntimeReadinessConfig, parsePdfEvidenceResult } from "@smedc/domain";
import { createStorageAdapter } from "@smedc/storage";
import { buildApiServer } from "../apps/api/src/server.js";
import { createPrismaEmployeeRepository } from "../apps/api/src/employees.js";
import { createMultipartPayload } from "../apps/api/src/test-support/api-server-fixtures.js";
import { createEvidenceIndexerFromEnv } from "../apps/worker/src/evidence-index.js";
import {
  createPrismaProcessingWorkerRepository,
  runWorkerOnce
} from "../apps/worker/src/worker.js";
import { bootstrapQdrantEvidenceCollection } from "./readiness.js";
import { createPdfAcceptanceManifest } from "./pdf-acceptance-support.js";
import {
  setupPdfAcceptanceRun,
  registerPdfDocument,
  createPdfQdrantResources,
  cleanupPrismaPdfAcceptanceRun,
  writePdfManifest
} from "./pdf-acceptance-controller.js";

const PROVIDER_KEYS = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_EMBEDDING_MODEL",
  "LLM_EMBEDDING_DIMENSION",
  "RERANK_PROVIDER",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_API_BASE_URL",
  "EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED",
  "RETRIEVAL_CONFIG_VERSION"
] as const;
export function providerEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    PROVIDER_KEYS.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]]))
  );
}
export function assertPdfLocalTargets(env: NodeJS.ProcessEnv, runId: string, directory: string) {
  if (
    !/^[a-z0-9_]{1,24}$/.test(runId) ||
    directory !== path.resolve(".codex-build/pdf", `local-${runId}`)
  )
    throw new Error("PDF qualification requires its exact ignored run directory.");
  const db = new URL(env["DATABASE_URL"] ?? "");
  const q = new URL(env["QDRANT_URL"] ?? "");
  const parser = new URL(env["SMEDC_PDF_SERVICE_URL"] ?? "");
  if (
    db.protocol !== "mysql:" ||
    db.hostname !== "127.0.0.1" ||
    db.port !== "14307" ||
    db.pathname !== `/pdf_local_${runId}` ||
    db.search ||
    db.hash ||
    q.origin !== "http://127.0.0.1:17337" ||
    q.pathname !== "/" ||
    q.search ||
    q.hash ||
    q.username ||
    q.password ||
    parser.origin !== "http://127.0.0.1:18088" ||
    parser.pathname !== "/" ||
    parser.search ||
    parser.hash ||
    parser.username ||
    parser.password ||
    env["QDRANT_COLLECTION_EVIDENCE"] !== `pdf_local_${runId}` ||
    env["STORAGE_DRIVER"] !== "local" ||
    env["LOCAL_STORAGE_ROOT"] !== path.join(directory, "storage")
  )
    throw new Error("PDF qualification refuses remote or non-run-owned data targets.");
}
interface ColdCase {
  question: string;
  page: number;
  anchors: string[];
  rowPairs?: string[][];
  method?: string;
}
interface ColdResult {
  text: string;
  source: {
    pageNumber?: number | null;
    pageNumbers?: number[];
    sectionHeadingPath?: string[];
    sourceLocations?: Array<{ pageNumber?: number; method?: string }>;
    pdfTable?: unknown;
  };
}
const compact = (s: string) => s.normalize("NFKC").replace(/\s+/gu, "");
const tableRows = (text: string) =>
  text.match(/(?:^|\n)行\s*\d+:[\s\S]*?(?=\n行\s*\d+:|$)/gu) ?? text.split("\n");
export function scoreColdCase(c: ColdCase, results: ColdResult[]) {
  const page = results.filter((r) =>
    (r.source.pageNumbers ?? [r.source.pageNumber]).includes(c.page)
  );
  const text = compact(
    page.map((r) => [r.text, ...(r.source.sectionHeadingPath ?? [])].join("\n")).join("\n")
  );
  const missingAnchors = c.anchors.filter((a) => !text.includes(compact(a)));
  const missingRows = (c.rowPairs ?? []).filter(
    (pair) =>
      !page.some(
        (r) =>
          r.source.pdfTable &&
          tableRows(r.text).some((row) =>
            pair.every((item) => compact(row).includes(compact(item)))
          )
      )
  );
  const method =
    !c.method ||
    page.some((r) =>
      r.source.sourceLocations?.some((s) => s.pageNumber === c.page && s.method === c.method)
    );
  return {
    pass: page.length > 0 && missingAnchors.length === 0 && missingRows.length === 0 && method,
    missingAnchors,
    missingRows,
    method,
    pageResults: page.length
  };
}
const execute = promisify(execFile);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PARSER_EXEC_CLIENT = `
import os,sys,urllib.request,urllib.error
path,method=sys.argv[1:3]
body=sys.stdin.buffer.read()
request=urllib.request.Request('http://127.0.0.1:8080'+path,data=body if method=='POST' else None,method=method,headers={'Authorization':'Bearer '+os.environ['SMEDC_PDF_SERVICE_TOKEN'],**({'Content-Type':'application/pdf'} if method=='POST' else {})})
try:
 response=urllib.request.urlopen(request,timeout=3700)
except urllib.error.HTTPError as error:
 response=error
content=response.read(16777217)
sys.stdout.buffer.write(response.status.to_bytes(2,'big')+content)
`;

export async function runPdfLocalAcceptance(args: string[]) {
  const options = new Map<string, string>();
  for (const arg of args.filter((a) => a !== "--")) {
    const match =
      /^(--samples|--cases|--provider-env|--run-id|--parser-image|--sample-indices)=(.+)$/u.exec(
        arg
      );
    if (!match || options.has(match[1]!))
      throw new Error("Invalid local PDF qualification option.");
    options.set(match[1]!, match[2]!);
  }
  const runId = options.get("--run-id") ?? `r${Date.now()}`;
  const directory = path.resolve(".codex-build/pdf", `local-${runId}`);
  const samples = options.get("--samples") ?? "";
  const casesFile = options.get("--cases") ?? "";
  const providerFile = options.get("--provider-env") ?? path.resolve(".env");
  for (const input of [samples, casesFile, providerFile])
    if (!path.isAbsolute(input)) throw new Error("Inputs must use absolute paths.");
  const cases = JSON.parse(await readFile(casesFile, "utf8")) as {
    samples: Array<{
      originalFileName: string;
      originalSha256: string;
      pageCount: number;
      cases: ColdCase[];
    }>;
  };
  assert.deepEqual(
    cases.samples.map((s) => s.pageCount),
    [4, 104, 19]
  );
  assert.equal(cases.samples.flatMap((s) => s.cases).length, 12);
  const sampleIndices = options.get("--sample-indices") === "0,2" ? [0, 2] : [0, 1, 2];
  if (
    options.has("--sample-indices") &&
    !["0,2", "0,1,2"].includes(options.get("--sample-indices")!)
  )
    throw new Error("Local PDF qualification requires an explicit supported sample selection.");
  const selectedSamples = sampleIndices.map((index) => ({ index, sample: cases.samples[index]! }));
  const bytes = await Promise.all(
    selectedSamples.map(async ({ sample }) => {
      if (path.basename(sample.originalFileName) !== sample.originalFileName)
        throw new Error("Invalid sample filename.");
      const file = await realpath(path.join(samples, sample.originalFileName));
      if (path.dirname(file) !== (await realpath(samples)))
        throw new Error("PDF sample escapes source directory.");
      const buffer = await readFile(file);
      assert.equal(sha(buffer), sample.originalSha256);
      return buffer;
    })
  );
  const providers = providerEnvironment(parseDotenv(await readFile(providerFile)));
  if (
    providers["LLM_PROVIDER"] !== "openai-compatible" ||
    !providers["OPENAI_COMPATIBLE_API_KEY"] ||
    !providers["RERANK_PROVIDER"] ||
    providers["RERANK_PROVIDER"] === "fake" ||
    providers["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] !== "true"
  )
    throw new Error("Final qualification requires real configured embedding and rerank providers.");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    ...providers,
    DATABASE_URL: `mysql://pdf_local:pdf_local_password@127.0.0.1:14307/pdf_local_${runId}`,
    QDRANT_URL: "http://127.0.0.1:17337",
    QDRANT_COLLECTION_EVIDENCE: `pdf_local_${runId}`,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: path.join(directory, "storage"),
    SMEDC_PDF_SERVICE_URL: "http://127.0.0.1:18088",
    SMEDC_PDF_SERVICE_TOKEN: randomBytes(32).toString("hex"),
    SMEDC_PDF_UPLOAD_ENABLED: "true",
    WORKER_JOB_SCOPE: "pdf",
    CURSOR_SIGNING_SECRET: randomBytes(32).toString("hex")
  };
  assertPdfLocalTargets(env, runId, directory);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  assert.equal(await realpath(path.dirname(directory)), path.dirname(directory));
  await mkdir(directory, { mode: 0o700 }); // Refuse reusing any existing run.
  const composeFile = path.join(directory, "compose.json");
  const project = `smedc-pdf-local-${runId.replaceAll("_", "-")}`;
  const parserImage = options.get("--parser-image") ?? "smedc-pdf-task8:local";
  if (!/^[a-z0-9][a-z0-9._/:-]+$/u.test(parserImage)) throw new Error("Invalid parser image.");
  await writeFile(
    composeFile,
    JSON.stringify({
      services: {
        mysql: {
          image: "mysql:8.4",
          environment: {
            MYSQL_DATABASE: `pdf_local_${runId}`,
            MYSQL_USER: "pdf_local",
            MYSQL_PASSWORD: "pdf_local_password",
            MYSQL_ROOT_PASSWORD: "pdf_local_root_password"
          },
          ports: ["127.0.0.1:14307:3306"],
          volumes: ["mysql:/var/lib/mysql"],
          healthcheck: {
            test: [
              "CMD",
              "mysqladmin",
              "ping",
              "-h",
              "127.0.0.1",
              "-updf_local",
              "-ppdf_local_password"
            ],
            interval: "2s",
            timeout: "3s",
            retries: 60
          },
          mem_limit: "512m"
        },
        qdrant: {
          image: "qdrant/qdrant:v1.19.1",
          ports: ["127.0.0.1:17337:6333"],
          volumes: ["qdrant:/qdrant/storage"],
          mem_limit: "512m"
        },
        parser: {
          image: parserImage,
          environment: { SMEDC_PDF_SERVICE_TOKEN: "${SMEDC_PDF_SERVICE_TOKEN}" },
          networks: ["offline"],
          read_only: true,
          tmpfs: ["/tmp:rw,noexec,nosuid,size=134217728,uid=10001,gid=10001,mode=0700"],
          mem_limit: "5g",
          memswap_limit: "5g",
          cpus: 4,
          pids_limit: 128,
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"]
        }
      },
      volumes: { mysql: {}, qdrant: {} },
      networks: { offline: { internal: true } }
    }),
    { mode: 0o600 }
  );
  const compose = async (...a: string[]) =>
    execute("docker", ["compose", "--project-name", project, "--file", composeFile, ...a], {
      env,
      maxBuffer: 4 * 1024 * 1024
    });
  const parserFetch: typeof fetch = async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (
      target.origin !== env["SMEDC_PDF_SERVICE_URL"] ||
      target.search ||
      target.hash ||
      !["/v1/ready", "/v1/parse"].includes(target.pathname)
    )
      return fetch(url, init);
    const method = init?.method ?? "GET";
    if (
      (target.pathname === "/v1/ready" && method !== "GET") ||
      (target.pathname === "/v1/parse" && method !== "POST")
    )
      throw new Error("Unexpected PDF parser request shape.");
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        "docker",
        [
          "compose",
          "--project-name",
          project,
          "--file",
          composeFile,
          "exec",
          "-T",
          "parser",
          "python",
          "-c",
          PARSER_EXEC_CLIENT,
          target.pathname,
          method
        ],
        { env, stdio: ["pipe", "pipe", "pipe"] }
      );
      const chunks: Buffer[] = [];
      let size = 0;
      const abort = () => child.kill("SIGTERM");
      init?.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 17 * 1024 * 1024) child.kill("SIGTERM");
        else chunks.push(chunk);
      });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("error", reject);
      child.on("close", (code) => {
        init?.signal?.removeEventListener("abort", abort);
        if (code !== 0 || size > 17 * 1024 * 1024)
          reject(new Error("Offline PDF parser transport failed."));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(body);
      if (init?.signal?.aborted) abort();
    });
    if (output.length < 2) throw new Error("Offline PDF parser response was incomplete.");
    const content = output.subarray(2);
    return new Response(new Uint8Array(content), {
      status: output.readUInt16BE(0),
      headers: { "content-type": "application/json", "content-length": String(content.length) }
    });
  };
  const report: Record<string, unknown> = {
    runId,
    project,
    targets: {
      database: `127.0.0.1:14307/pdf_local_${runId}`,
      qdrant: "127.0.0.1:17337",
      collection: env["QDRANT_COLLECTION_EVIDENCE"],
      storage: env["LOCAL_STORAGE_ROOT"]
    },
    parserImage,
    sampleIndices,
    expectedSelectedPages: selectedSamples.reduce((sum, { sample }) => sum + sample.pageCount, 0),
    expectedSelectedColdCases: selectedSamples.reduce(
      (sum, { sample }) => sum + sample.cases.length,
      0
    ),
    omittedSamples: cases.samples
      .map((sample, index) => ({ index, pageCount: sample.pageCount }))
      .filter(({ index }) => !sampleIndices.includes(index)),
    authenticationScope: "injected run-owned opaque tokens; production authorization/repositories",
    rollbackScope:
      "injected local admission verifier; protected Linux runtime-state separately qualified",
    parserTransport:
      "Default API admission readiness fetch and default worker HttpPdfParserClient with its scoped Undici dispatcher reach a test-only host-loopback HTTP proxy. The proxy forwards authenticated /v1/ready and /v1/parse through Docker exec to the real parser, which has no published port or external network. Production services use their private bridge endpoint.",
    results: []
  };
  const persist = () =>
    writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2), {
      mode: 0o600
    });
  let prisma: PrismaClient | undefined;
  let app: ReturnType<typeof buildApiServer> | undefined;
  let parserProxy: Server | undefined;
  let worker: ReturnType<typeof createPrismaProcessingWorkerRepository> | undefined;
  let started = false;
  let settledAndCleaned = false;
  const parserTimings: number[] = [];
  const originalEnvironment = { ...process.env };
  let inFlight: Promise<unknown> | undefined;
  try {
    // Refuse a pre-existing project before compose could adopt/delete anything.
    const existing = await execute("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`
    ]);
    assert.equal(existing.stdout.trim(), "");
    const knownNames = new Set([`${project}_mysql`, `${project}_qdrant`]);
    const allVolumes = await execute("docker", ["volume", "ls", "-q"]);
    assert(!allVolumes.stdout.split("\n").some((name) => knownNames.has(name)));
    const allNetworks = await execute("docker", ["network", "ls", "--format", "{{.Name}}"]);
    assert(
      !allNetworks.stdout
        .split("\n")
        .some((name) => [`${project}_default`, `${project}_offline`].includes(name))
    );
    const volumes = await execute("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`
    ]);
    assert.equal(volumes.stdout.trim(), "");
    started = true;
    await compose("up", "-d", "--wait", "--wait-timeout", "180");
    const inventory = (await compose("ps", "--format", "json")).stdout.trim();
    report["containers"] = inventory.startsWith("[")
      ? JSON.parse(inventory)
      : inventory.split("\n").map((line) => JSON.parse(line));
    let parserReady: { parserFingerprint?: string } | undefined;
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const response = await parserFetch(`${env["SMEDC_PDF_SERVICE_URL"]}/v1/ready`, {
          headers: { authorization: `Bearer ${env["SMEDC_PDF_SERVICE_TOKEN"]}` },
          signal: AbortSignal.timeout(5000)
        });
        if (response.ok) {
          parserReady = (await response.json()) as { parserFingerprint?: string };
          break;
        }
        if (response.status === 503)
          throw new Error("Parser rejected its offline model or runtime configuration.");
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Parser rejected")) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.match(parserReady?.parserFingerprint ?? "", /^[a-f0-9]{64}$/u);
    report["parserFingerprint"] = parserReady!.parserFingerprint;
    parserProxy = createServer(async (request, response) => {
      const allowed =
        (request.url === "/v1/ready" && request.method === "GET") ||
        (request.url === "/v1/parse" && request.method === "POST");
      if (!allowed) {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${env["SMEDC_PDF_SERVICE_TOKEN"]}`) {
        response.writeHead(401).end();
        return;
      }
      const controller = new AbortController();
      request.on("aborted", () => controller.abort());
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const piece of request) {
          const chunk = Buffer.from(piece);
          size += chunk.length;
          if (size > 50 * 1024 * 1024) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const parserStart = performance.now();
        const forwarded = await parserFetch(`${env["SMEDC_PDF_SERVICE_URL"]}${request.url}`, {
          method: request.method,
          ...(body.length ? { body: new Uint8Array(body) } : {}),
          signal: controller.signal
        });
        if (request.url === "/v1/parse")
          parserTimings.push((performance.now() - parserStart) / 1000);
        const content = Buffer.from(await forwarded.arrayBuffer());
        response.writeHead(forwarded.status, {
          "content-type": "application/json",
          "content-length": content.length
        });
        response.end(content);
      } catch {
        if (!response.headersSent)
          response
            .writeHead(502, { "content-type": "application/json" })
            .end('{"code":"PDF_SERVICE_UNAVAILABLE"}');
      }
    });
    await new Promise<void>((resolve, reject) => {
      parserProxy!.once("error", reject);
      parserProxy!.listen(18088, "127.0.0.1", () => {
        parserProxy!.off("error", reject);
        resolve();
      });
    });
    await execute("npm", ["run", "db:migrate:deploy"], { env, maxBuffer: 4 * 1024 * 1024 });
    // All lazy repositories use process.env; replace it with the fresh allowlisted environment.
    process.env = env;
    prisma = new PrismaClient({ adapter: createDatabaseAdapter(env["DATABASE_URL"]!) });
    await bootstrapQdrantEvidenceCollection(parseRuntimeReadinessConfig(env).qdrant);
    const manifest = createPdfAcceptanceManifest(runId);
    const save = () => writePdfManifest(path.join(directory, "manifest.json"), manifest);
    await setupPdfAcceptanceRun(prisma, manifest, save);
    const employees = createPrismaEmployeeRepository(env["DATABASE_URL"]);
    const tokens = new Map(
      await Promise.all(
        manifest.employeeIds.map(
          async (id) => [randomBytes(32).toString("hex"), (await employees.findById(id))!] as const
        )
      )
    );
    const accounts = [...tokens].map(([token, employee]) => ({ token, employee }));
    const admin = accounts.find((a) => a.employee.role === "admin")!;
    const reader = accounts.find(
      (a) => a.employee.orgId === manifest.orgIds[0] && a.employee.role === "employee"
    )!;
    const other = accounts.find((a) => a.employee.orgId === manifest.orgIds[1])!;
    const storage = createStorageAdapter(env);
    app = buildApiServer({
      runtimeEnv: env,
      storageAdapter: storage,
      employeeRepository: employees,
      authenticateAccessToken: async (token) => tokens.get(token) ?? null,
      pdfRollbackFloorVerifier: async () => true,
      logger: false
    });
    const request = async (token: string, method: "GET" | "POST", url: string, payload?: object) =>
      app!.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload ? { payload } : {})
      });
    const upload = async (content: Buffer, name: string, confidentiality = 0) => {
      const multipart = createMultipartPayload([
        {
          name: "file",
          fileName: name,
          contentType: name.endsWith(".pdf") ? "application/pdf" : "text/plain",
          value: content
        },
        { name: "title", value: name },
        { name: "sourceSystem", value: `pdf_acceptance_${runId}` },
        { name: "confidentialityLevel", value: String(confidentiality) }
      ]);
      const response = await app!.inject({
        method: "POST",
        url: "/v1/documents/evidence",
        headers: { authorization: `Bearer ${admin.token}`, "content-type": multipart.contentType },
        payload: multipart.body
      });
      assert.equal(response.statusCode, 202, response.body);
      return response.json().document.documentId as string;
    };
    worker = createPrismaProcessingWorkerRepository(env["DATABASE_URL"], {
      evidenceRetrievalConfigVersion: parseRuntimeReadinessConfig(env).qdrant.retrievalConfigVersion
    });
    const indexer = createEvidenceIndexerFromEnv({
      env,
      storage,
      pdfArtifacts: worker.pdfArtifacts
    });
    const external = createPdfQdrantResources({
      storage,
      url: env["QDRANT_URL"]!,
      collection: env["QDRANT_COLLECTION_EVIDENCE"]!
    });
    const documents: string[] = [];
    for (const [position, { index: i, sample }] of selectedSamples.entries()) {
      const id = await upload(bytes[position]!, sample.originalFileName);
      documents.push(id);
      await registerPdfDocument(prisma, manifest, id, external, save);
      const began = performance.now();
      const processing = runWorkerOnce({
        repository: worker,
        storage,
        evidenceIndexer: indexer,
        jobScope: "pdf",
        workerId: `pdf-local-${runId}`,
        maxAttempts: 1
      });
      inFlight = processing;
      let ordinary: Record<string, unknown> | undefined;
      if (sample.pageCount === 104) {
        // Confirm the PDF lease is running before importing through the ordinary consumer.
        for (let poll = 0; poll < 60; poll++) {
          if (
            await prisma.processingRun.findFirst({ where: { documentId: id, status: "running" } })
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const ordinaryId = await upload(
          Buffer.from("synthetic ordinary import remains available"),
          "ordinary.txt"
        );
        const ordinaryStart = performance.now();
        const generalIndexer = createEvidenceIndexerFromEnv({
          env: { ...env, WORKER_JOB_SCOPE: "general" },
          storage
        });
        const result = await runWorkerOnce({
          repository: worker,
          storage,
          evidenceIndexer: generalIndexer,
          jobScope: "general",
          workerId: `general-local-${runId}`,
          maxAttempts: 1
        });
        const pdfRun: { status: string } = await prisma.processingRun.findFirstOrThrow({
          where: { documentId: id }
        });
        assert.equal(pdfRun.status, "running");
        assert.equal(
          (await prisma.document.findUniqueOrThrow({ where: { id: ordinaryId } })).status,
          "active"
        );
        ordinary = {
          documentId: ordinaryId,
          seconds: (performance.now() - ordinaryStart) / 1000,
          result,
          pdfStatus: pdfRun.status
        };
        // Exact known-success ordinary resources are not accepted by the PDF-only controller.
        const chunks = await prisma.documentChunk.findMany({ where: { documentId: ordinaryId } });
        await external.deletePoints(
          chunks.flatMap((c) => (c.qdrantPointId ? [c.qdrantPointId] : [])),
          external.collection
        );
        const doc = await prisma.document.findUniqueOrThrow({ where: { id: ordinaryId } });
        await storage.deleteObject(doc.storageObjectKey);
        await prisma.document.delete({ where: { id: ordinaryId } });
      }
      const result = await processing;
      inFlight = undefined;
      const duration = (performance.now() - began) / 1000;
      const status = await request(admin.token, "GET", `/v1/documents/evidence/${id}/status`);
      assert.equal(status.statusCode, 200, status.body);
      assert.equal(result.processed, true);
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id } })).status, "active");
      assert.equal(status.json().document.status, "active");
      assert.equal(status.json().documentIndex.status, "ready");
      await registerPdfDocument(prisma, manifest, id, external, save);
      const index = await prisma.documentIndex.findFirstOrThrow({
        where: { documentId: id, status: "ready" }
      });
      const parsed = parsePdfEvidenceResult(
        JSON.parse(
          (await readFile(path.join(env["LOCAL_STORAGE_ROOT"]!, index.parsedObjectKey!))).toString()
        )
      );
      assert.equal(parsed.pageCount, sample.pageCount);
      assert.equal(parsed.sourceChecksumSha256, sample.originalSha256);
      assert.equal(parsed.parserFingerprint, report["parserFingerprint"]);
      assert(parsed.pages.every((p) => p.outcome !== "failed"));
      const evidence: Record<string, unknown> = {
        documentId: id,
        sourceChecksum: sample.originalSha256,
        pageCount: parsed.pageCount,
        parserFingerprint: parsed.parserFingerprint,
        seconds: duration,
        parserSeconds: parserTimings.at(-1),
        workerResult: result,
        status: status.json(),
        ordinary
      };
      (report["results"] as unknown[]).push(evidence);
      // Keep extracts private for same-sample staging comparison; no answers inform search.
      await writeFile(path.join(directory, `sample-${i}-parsed.json`), JSON.stringify(parsed), {
        mode: 0o600
      });
      const metrics = await compose(
        "exec",
        "-T",
        "parser",
        "python",
        "-c",
        "import json,pathlib,platform;p=pathlib.Path('/sys/fs/cgroup');print(json.dumps({'architecture':platform.machine(),'memoryPeakBytes':int((p/'memory.peak').read_text()),'memoryLimitBytes':int((p/'memory.max').read_text()),'cpuMax':(p/'cpu.max').read_text().strip(),'jobsRemaining':len(list(pathlib.Path('/tmp/jobs').iterdir()))}))"
      );
      evidence["linux"] = JSON.parse(metrics.stdout);
      assert.equal((evidence["linux"] as { jobsRemaining: number }).jobsRemaining, 0);
      const cold = [];
      for (const c of sample.cases) {
        const response = await request(reader.token, "POST", "/v1/evidence/search", {
          query: c.question,
          limit: 20
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json();
        const found = (body.results as Array<ColdResult & { documentId: string }>).filter(
          (r) => r.documentId === id
        );
        const score = scoreColdCase(c, found);
        const download = body.sources.find(
          (s: { sourceDocumentId: string }) => s.sourceDocumentId === id
        );
        const originalAvailable =
          download?.downloadStatus === "available" &&
          typeof download.downloadUrl === "string" &&
          download.downloadUrl.startsWith("file://") &&
          sha(await readFile(fileURLToPath(download.downloadUrl))) === sample.originalSha256;
        cold.push({ question: c.question, score, originalAvailable, response: body });
      }
      evidence["cold"] = cold;
      const cross = await request(other.token, "POST", "/v1/evidence/search", {
        query: sample.cases[0]!.question,
        limit: 20
      });
      assert.equal(cross.statusCode, 200);
      assert.equal(cross.json().results.length, 0);
      assert.equal(cross.json().sources.length, 0);
      assert.equal(
        (await request(other.token, "GET", `/v1/documents/evidence/${id}/status`)).statusCode,
        404
      );
      assert.equal(
        (await request(other.token, "POST", `/v1/source-documents/${id}/download-url`)).statusCode,
        404
      );
      await persist();
      process.stdout.write(
        JSON.stringify({
          sample: i,
          pages: parsed.pageCount,
          seconds: Math.round(duration),
          coldPassed: cold.filter((c) => c.score.pass).length,
          coldTotal: cold.length
        }) + "\n"
      );
    }
    // Existing indexed points carry c0; deliberately stale payload tests DB revalidation.
    const protectedId = documents[0]!;
    await prisma.document.update({ where: { id: protectedId }, data: { confidentialityLevel: 3 } });
    const lowered = { ...reader.employee, clearance: 0 };
    tokens.set(reader.token, lowered);
    const denied = await request(reader.token, "POST", "/v1/evidence/search", {
      query: cases.samples[0]!.cases[0]!.question,
      filters: { documentIds: [protectedId] },
      limit: 20
    });
    assert.equal(denied.statusCode, 200);
    assert.equal(denied.json().results.length, 0);
    assert.equal(denied.json().sources.length, 0);
    assert.equal(
      (await request(admin.token, "GET", `/v1/documents/evidence/${protectedId}/status`))
        .statusCode,
      404
    );
    assert.equal(
      (await request(admin.token, "POST", `/v1/source-documents/${protectedId}/download-url`))
        .statusCode,
      404
    );
    await prisma.document.update({ where: { id: protectedId }, data: { confidentialityLevel: 0 } });
    report["authorization"] = {
      crossOrganization: "passed",
      clearanceWithStaleQdrantPayload: "passed",
      unauthorizedStatus: "passed"
    };
    for (const id of documents) await registerPdfDocument(prisma, manifest, id, external, save);
    report["cleanup"] = await cleanupPrismaPdfAcceptanceRun(prisma, manifest, external, save);
    settledAndCleaned = true;
    report["pass"] = (
      report["results"] as Array<{
        cold: Array<{ score: { pass: boolean }; originalAvailable: boolean }>;
      }>
    ).every((s) => s.cold.every((c) => c.score.pass && c.originalAvailable));
    await persist();
    if (!report["pass"])
      throw new Error("Frozen cold retrieval cases failed; inspect private report.");
  } catch (error) {
    report["pass"] = false;
    report["error"] = error instanceof Error ? error.message : "Qualification failed";
    await persist();
    throw new Error(`Local PDF qualification failed; private recovery evidence: ${directory}`);
  } finally {
    await inFlight?.catch(() => {});
    await app?.close();
    await worker?.disconnect?.();
    await prisma?.$disconnect();
    if (parserProxy?.listening) {
      parserProxy.closeAllConnections();
      await new Promise<void>((resolve) => parserProxy!.close(() => resolve()));
    }
    process.env = originalEnvironment;
    if (started && settledAndCleaned) {
      await compose("down", "--volumes", "--remove-orphans");
      await rm(path.join(directory, "storage"), { recursive: true, force: true });
      report["resourceCleanup"] = "owned Compose containers/volumes/networks/storage removed";
      await persist();
    } else if (started) {
      report["resourceCleanup"] = "recovery required; isolated containers/volumes/storage retained";
      await persist();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPdfLocalAcceptance(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Local qualification failed.");
    process.exitCode = 1;
  });
}
