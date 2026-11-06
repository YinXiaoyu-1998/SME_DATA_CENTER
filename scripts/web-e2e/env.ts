/**
 * 浏览器端到端用的本地运行环境。
 *
 * 与 scripts/test-integration.ts 保持同一套本地依赖（MySQL + Qdrant + fake provider），
 * 但网页端额外需要两个东西：一个静态站点服务器，以及必须与它一致的 SMEDC_WEB_ORIGIN。
 */
import path from "node:path";

export const WEB_E2E_PORT = Number(process.env["WEB_E2E_PORT"] ?? 5300);
export const API_PORT = Number(process.env["WEB_E2E_API_PORT"] ?? 3010);
export const WEB_ORIGIN = `http://localhost:${WEB_E2E_PORT}`;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

const root = process.cwd();
const dataRoot = path.join(root, ".data", "web-e2e");

export function webE2eEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    CURSOR_SIGNING_SECRET: process.env["CURSOR_SIGNING_SECRET"] ?? "web-e2e-cursor-secret",
    // 浏览器面只认 web origin；issuer 仍是 api origin，机器客户端不受影响。
    SMEDC_API_ORIGIN: "https://api.smedatacenter.xyz",
    SMEDC_WEB_ORIGIN: WEB_ORIGIN,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: path.join(dataRoot, "storage"),
    QDRANT_URL: process.env["QDRANT_URL"] ?? "http://127.0.0.1:6333",
    QDRANT_COLLECTION_EVIDENCE: "smedc_evidence_web_e2e",
    RETRIEVAL_CONFIG_VERSION: "phase3.retrieval.v1",
    LLM_PROVIDER: "fake",
    LLM_MODEL: "fake-rerank",
    LLM_EMBEDDING_MODEL: "fake-embedding",
    LLM_EMBEDDING_DIMENSION: "",
    RERANK_PROVIDER: "fake",
    DASHSCOPE_API_KEY: "",
    DASHSCOPE_API_BASE_URL: "",
    EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "false",
    PARTITION_IMPORT_WORK_DIR: path.join(dataRoot, "partition-work"),
    PARTITION_IMPORT_MIN_FREE_BYTES: "1",
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(API_PORT)
  };
}
