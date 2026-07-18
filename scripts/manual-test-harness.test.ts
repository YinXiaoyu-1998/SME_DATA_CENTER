import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeManualTestTarget,
  buildManualTestRuntime,
  manualTestProcessEnv,
  parseManualTestArgs,
  publicManualTestManifest,
  spawnLoggedChild,
  type ManualTestRuntime
} from "./manual-test-harness.js";

const cwd = "/workspace/SME_DATA_CENTER";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe("manual test runtime", () => {
  it("builds an isolated fake-provider runtime from local defaults", () => {
    const runtime = buildManualTestRuntime({
      cwd,
      profile: "fake",
      env: {},
      runId: "20260718-060000"
    });

    expect(runtime).toMatchObject({
      runId: "20260718-060000",
      profile: "fake",
      mysqlPort: "3307",
      apiUrl: "http://127.0.0.1:3000",
      databaseUrl:
        "mysql://enterprise_hub:enterprise_hub_local_password@127.0.0.1:3307/enterprise_hub",
      qdrantUrl: "http://127.0.0.1:6333",
      qdrantCollection: "enterprise_hub_evidence_manual_20260718_060000",
      llmProvider: "fake",
      rerankProvider: "fake"
    });
    expect(runtime.runRoot).toBe(path.join(cwd, ".data", "manual-tests", "20260718-060000"));
    expect(runtime.storageRoot).toBe(path.join(runtime.runRoot, "storage"));
  });

  it("keeps the generated local database URL on the requested MySQL port", () => {
    const runtime = buildManualTestRuntime({
      cwd,
      profile: "fake",
      env: { MYSQL_PORT: "3317" },
      runId: "port-run"
    });

    expect(runtime.mysqlPort).toBe("3317");
    expect(runtime.databaseUrl).toContain("@127.0.0.1:3317/enterprise_hub");
  });

  it("preserves explicit real-provider settings only for the real profile", () => {
    const runtime = buildManualTestRuntime({
      cwd,
      profile: "real",
      env: {
        LLM_PROVIDER: "openai-compatible",
        RERANK_PROVIDER: "dashscope",
        LLM_MODEL: "qwen3-rerank",
        LLM_EMBEDDING_MODEL: "text-embedding-v4",
        LLM_EMBEDDING_DIMENSION: "1024",
        OPENAI_COMPATIBLE_API_KEY: "local-secret",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider.example.test/v1",
        DASHSCOPE_API_KEY: "local-dashscope-secret",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "true"
      },
      runId: "real-run"
    });

    expect(runtime).toMatchObject({
      profile: "real",
      llmProvider: "openai-compatible",
      rerankProvider: "dashscope",
      embeddingDimension: "1024",
      egressAcknowledged: "true"
    });
  });

  it("rejects a real profile without explicit provider egress acknowledgement", () => {
    expect(() =>
      buildManualTestRuntime({
        cwd,
        profile: "real",
        env: {
          LLM_PROVIDER: "openai-compatible",
          LLM_EMBEDDING_MODEL: "text-embedding-v4",
          OPENAI_COMPATIBLE_API_KEY: "local-secret",
          OPENAI_COMPATIBLE_BASE_URL: "https://provider.example.test/v1"
        },
        runId: "real-run"
      })
    ).toThrow("EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true");
  });

  it("builds one explicit environment for API, worker, migrations, and readiness", () => {
    const runtime = safeRuntime();

    expect(manualTestProcessEnv(runtime, { PATH: "/usr/bin" })).toMatchObject({
      PATH: "/usr/bin",
      DATABASE_URL: runtime.databaseUrl,
      MYSQL_PORT: runtime.mysqlPort,
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_ROOT: runtime.storageRoot,
      HOST: "127.0.0.1",
      PORT: "3000",
      QDRANT_URL: runtime.qdrantUrl,
      QDRANT_COLLECTION_EVIDENCE: runtime.qdrantCollection,
      LLM_PROVIDER: "fake",
      RERANK_PROVIDER: "fake"
    });
  });

  it("never writes provider secrets into the public run manifest", () => {
    const runtime = buildManualTestRuntime({
      cwd,
      profile: "real",
      env: {
        LLM_PROVIDER: "openai-compatible",
        RERANK_PROVIDER: "dashscope",
        LLM_MODEL: "qwen3-rerank",
        LLM_EMBEDDING_MODEL: "text-embedding-v4",
        OPENAI_COMPATIBLE_API_KEY: "must-not-be-written",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider.example.test/v1",
        DASHSCOPE_API_KEY: "also-must-not-be-written",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "true"
      },
      runId: "real-run"
    });

    const serialized = JSON.stringify(publicManualTestManifest(runtime));
    expect(serialized).not.toContain("must-not-be-written");
    expect(serialized).not.toContain("also-must-not-be-written");
    expect(serialized).toContain('"profile":"real"');
  });
});

describe("manual test target safety", () => {
  it("accepts the dedicated localhost runtime", () => {
    expect(() => assertSafeManualTestTarget(safeRuntime())).not.toThrow();
  });

  it.each([
    ["remote MySQL", { databaseUrl: "mysql://user:pass@db.example.com/enterprise_hub" }],
    ["unexpected database", { databaseUrl: "mysql://user:pass@127.0.0.1:3307/customer_data" }],
    ["remote Qdrant", { qdrantUrl: "https://qdrant.example.com" }],
    ["shared collection", { qdrantCollection: "enterprise_hub_evidence_local" }],
    ["external storage", { storageRoot: "/tmp/manual-test-storage" }]
  ])("rejects %s", (_label, override) => {
    expect(() => assertSafeManualTestTarget({ ...safeRuntime(), ...override })).toThrow();
  });
});

describe("manual test command parsing", () => {
  it("defaults prepare to the deterministic fake profile", () => {
    expect(parseManualTestArgs(["prepare"])).toEqual({
      command: "prepare",
      profile: "fake",
      runId: undefined
    });
  });

  it("accepts an explicit real profile and run id", () => {
    expect(parseManualTestArgs(["prepare", "--profile=real", "--run-id=run-42"])).toEqual({
      command: "prepare",
      profile: "real",
      runId: "run-42"
    });
  });

  it.each([["unknown"], ["prepare", "--profile=production"], ["prepare", "--wat"]])(
    "rejects unsupported arguments: %s",
    (...argv) => {
      expect(() => parseManualTestArgs(argv)).toThrow();
    }
  );
});

describe("manual test child logging", () => {
  it("captures stdout and stderr without requiring a pre-opened stdio file descriptor", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-manual-child-"));
    temporaryDirectories.push(directory);
    const logPath = path.join(directory, "child.log");
    const logged = spawnLoggedChild({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ready\\n'); process.stderr.write('warning\\n')"],
      cwd: directory,
      env: process.env,
      logPath
    });

    await once(logged.child, "close");
    await logged.closeLog();

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("ready\n");
    expect(log).toContain("warning\n");
  });
});

function safeRuntime(): ManualTestRuntime {
  return buildManualTestRuntime({
    cwd,
    profile: "fake",
    env: {},
    runId: "safe-run"
  });
}
