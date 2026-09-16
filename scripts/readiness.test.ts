import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapQdrantEvidenceCollection,
  checkRuntimeReadiness,
  parseRuntimeReadinessConfig,
  qdrantEvidenceCollectionSchema
} from "./readiness.js";

interface RecordedCollection {
  vectors?: unknown;
  sparse_vectors?: unknown;
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("Phase 3 runtime readiness", () => {
  it("defaults local and CI model provider mode to fake without external egress", () => {
    const config = parseRuntimeReadinessConfig({});

    expect(config.modelProvider.provider).toBe("fake");
    expect(config.modelProvider.egressAcknowledged).toBe(false);
    expect(config.qdrant.collectionName).toBe("smedc_evidence_local");
    expect(config.qdrant.url).toBe("http://127.0.0.1:6333");
  });

  it("creates the evidence collection with expected dense and sparse vector config", async () => {
    const collections = new Map<string, RecordedCollection>();
    const { url } = await startFakeQdrant(collections);
    const config = parseRuntimeReadinessConfig({
      QDRANT_URL: url,
      LLM_PROVIDER: "openai-compatible",
      LLM_EMBEDDING_DIMENSION: "1024"
    });

    await bootstrapQdrantEvidenceCollection(config.qdrant);

    expect(collections.get(config.qdrant.collectionName)).toEqual(
      qdrantEvidenceCollectionSchema(1024)
    );
  });

  it("fails readiness clearly when Qdrant is unavailable", async () => {
    const report = await checkRuntimeReadiness({
      env: { QDRANT_URL: "http://127.0.0.1:1", QDRANT_TIMEOUT_MS: "50" },
      checks: {
        mysql: async () => undefined,
        storage: async () => undefined,
        workerLease: async () => undefined
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "qdrant",
        ok: false,
        message: expect.stringContaining("Qdrant is unavailable")
      })
    );
  });

  it("passes local readiness when Qdrant has the expected evidence collection", async () => {
    const collections = new Map<string, RecordedCollection>();
    const { url } = await startFakeQdrant(collections);
    const config = parseRuntimeReadinessConfig({ QDRANT_URL: url });
    collections.set(config.qdrant.collectionName, qdrantEvidenceCollectionSchema());

    const report = await checkRuntimeReadiness({
      env: { QDRANT_URL: url },
      checks: {
        mysql: async () => undefined,
        storage: async () => undefined,
        workerLease: async () => undefined
      }
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => [check.name, check.ok])).toEqual([
      ["mysql", true],
      ["qdrant", true],
      ["storage", true],
      ["workerLease", true],
      ["modelProvider", true]
    ]);
  });

  it("times out dependency checks instead of hanging readiness forever", async () => {
    const collections = new Map<string, RecordedCollection>();
    const { url } = await startFakeQdrant(collections);
    const config = parseRuntimeReadinessConfig({ QDRANT_URL: url });
    collections.set(config.qdrant.collectionName, qdrantEvidenceCollectionSchema());

    const report = await checkRuntimeReadiness({
      env: { QDRANT_URL: url },
      checkTimeoutMs: 10,
      checks: {
        mysql: async () => new Promise(() => undefined),
        storage: async () => undefined,
        workerLease: async () => undefined
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "mysql",
        ok: false,
        message: expect.stringContaining("timed out")
      })
    );
  });

  it("fails readiness before any real model egress when a real provider is unacknowledged", async () => {
    const collections = new Map<string, RecordedCollection>();
    const { url } = await startFakeQdrant(collections);
    const config = parseRuntimeReadinessConfig({ QDRANT_URL: url });
    collections.set(config.qdrant.collectionName, qdrantEvidenceCollectionSchema());

    const report = await checkRuntimeReadiness({
      env: {
        QDRANT_URL: url,
        LLM_PROVIDER: "openai-compatible",
        RERANK_PROVIDER: "dashscope",
        LLM_MODEL: "rerank-v1",
        LLM_EMBEDDING_MODEL: "embed-v1",
        LLM_EMBEDDING_DIMENSION: "1024",
        OPENAI_COMPATIBLE_API_KEY: "test-secret",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider.example.test/v1",
        DASHSCOPE_API_BASE_URL: "https://dashscope.example.test/api/v1",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "false"
      },
      checks: {
        mysql: async () => undefined,
        storage: async () => undefined,
        workerLease: async () => undefined
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "modelProvider",
        ok: false,
        message: expect.stringContaining("EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true")
      })
    );
  });

  it("treats blank optional provider values as unset", () => {
    const config = parseRuntimeReadinessConfig({
      LLM_PROVIDER: "openai-compatible",
      RERANK_PROVIDER: "",
      DASHSCOPE_API_BASE_URL: "",
      LLM_EMBEDDING_DIMENSION: "1024"
    });

    expect(config.modelProvider.rerankProvider).toBe("openai-compatible");
    expect(config.modelProvider.dashscopeApiBaseUrl).toBe("https://dashscope.aliyuncs.com/api/v1");
    expect(config.modelProvider.embeddingDimension).toBe(1024);
    expect(config.qdrant.denseVectorSize).toBe(1024);
  });

  it("fails readiness when fake embeddings use real DashScope rerank without egress acknowledgement", async () => {
    const collections = new Map<string, RecordedCollection>();
    const { url } = await startFakeQdrant(collections);
    const config = parseRuntimeReadinessConfig({ QDRANT_URL: url });
    collections.set(config.qdrant.collectionName, qdrantEvidenceCollectionSchema());

    const report = await checkRuntimeReadiness({
      env: {
        QDRANT_URL: url,
        LLM_PROVIDER: "fake",
        RERANK_PROVIDER: "dashscope",
        LLM_MODEL: "qwen3-rerank",
        OPENAI_COMPATIBLE_API_KEY: "test-secret",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "false"
      },
      checks: {
        mysql: async () => undefined,
        storage: async () => undefined,
        workerLease: async () => undefined
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "modelProvider",
        ok: false,
        message: expect.stringContaining("EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true")
      })
    );
  });

  it("fails readiness when real rerank uses the fake default model", async () => {
    const collections = new Map<string, RecordedCollection>();
    const { url } = await startFakeQdrant(collections);
    const config = parseRuntimeReadinessConfig({ QDRANT_URL: url });
    collections.set(config.qdrant.collectionName, qdrantEvidenceCollectionSchema());

    const report = await checkRuntimeReadiness({
      env: {
        QDRANT_URL: url,
        LLM_PROVIDER: "fake",
        RERANK_PROVIDER: "dashscope",
        OPENAI_COMPATIBLE_API_KEY: "test-secret",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "true"
      },
      checks: {
        mysql: async () => undefined,
        storage: async () => undefined,
        workerLease: async () => undefined
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "modelProvider",
        ok: false,
        message: expect.stringContaining("configured real rerank model")
      })
    );
  });
});

async function startFakeQdrant(collections: Map<string, RecordedCollection>) {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const collectionMatch = requestUrl.pathname.match(/^\/collections\/([^/]+)$/);

    if (!collectionMatch) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "not_found" }));
      return;
    }

    const rawCollectionName = collectionMatch[1];

    if (!rawCollectionName) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "bad_request" }));
      return;
    }

    const collectionName = decodeURIComponent(rawCollectionName);

    if (request.method === "GET") {
      const collection = collections.get(collectionName);

      if (!collection) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "not_found" }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          result: {
            status: "green",
            config: {
              params: collection
            }
          }
        })
      );
      return;
    }

    if (request.method === "PUT") {
      const body = await readBody(request);
      collections.set(collectionName, JSON.parse(body) as RecordedCollection);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: true }));
      return;
    }

    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "method_not_allowed" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Unable to start fake Qdrant server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`
  };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}
