import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPdfLocalTargets,
  providerEnvironment,
  scoreColdCase
} from "./pdf-local-acceptance.js";

const root = path.resolve(".codex-build/pdf/local-unit");
const env = {
  DATABASE_URL: "mysql://synthetic:synthetic@127.0.0.1:14307/pdf_local_unit",
  QDRANT_URL: "http://127.0.0.1:17337",
  QDRANT_COLLECTION_EVIDENCE: "pdf_local_unit",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_ROOT: path.join(root, "storage"),
  SMEDC_PDF_SERVICE_URL: "http://127.0.0.1:18088"
};
describe("local PDF acceptance isolation", () => {
  it("accepts only exact run-owned loopback data targets", () => {
    expect(() => assertPdfLocalTargets(env, "unit", root)).not.toThrow();
    for (const change of [
      { DATABASE_URL: "mysql://synthetic:synthetic@db.example:14307/pdf_local_unit" },
      { DATABASE_URL: "mysql://synthetic:synthetic@127.0.0.1:14307/smedc" },
      { QDRANT_URL: "http://remote.example:17337" },
      { QDRANT_COLLECTION_EVIDENCE: "smedc_evidence_local" },
      { STORAGE_DRIVER: "oss" },
      { LOCAL_STORAGE_ROOT: "/tmp/other" },
      { LOCAL_STORAGE_ROOT: path.join(root, "storage", "..", "outside") },
      { SMEDC_PDF_SERVICE_URL: "https://remote.example" }
    ])
      expect(() => assertPdfLocalTargets({ ...env, ...change }, "unit", root)).toThrow();
  });
  it("loads provider configuration without importing data services or unknown secrets", () => {
    expect(
      providerEnvironment({
        LLM_PROVIDER: "openai-compatible",
        OPENAI_COMPATIBLE_API_KEY: "synthetic",
        DATABASE_URL: "remote",
        STORAGE_DRIVER: "oss",
        UNKNOWN_SECRET: "hidden"
      })
    ).toEqual({ LLM_PROVIDER: "openai-compatible", OPENAI_COMPATIBLE_API_KEY: "synthetic" });
  });
  it("requires page-scoped anchors and same table-row relationships", () => {
    const c = { question: "cold", page: 3, anchors: ["标准"], rowPairs: [["黄瓜", "60"]] };
    expect(
      scoreColdCase(c, [
        {
          text: "标准 黄瓜 | 60",
          source: { pageNumbers: [3], pdfTable: { tableId: "t", rowStart: 0, rowEnd: 1 } }
        }
      ]).pass
    ).toBe(true);
    expect(scoreColdCase(c, [{ text: "标准 黄瓜 | 60", source: { pageNumbers: [4] } }]).pass).toBe(
      false
    );
    expect(
      scoreColdCase(c, [
        {
          text: "标准 黄瓜 | 5\n辣椒 | 60",
          source: { pageNumbers: [3], pdfTable: { tableId: "t" } }
        }
      ]).pass
    ).toBe(false);
  });
  it("scores a page heading and a line-wrapped cell within one labeled table row", () => {
    const c = {
      question: "cold",
      page: 3,
      anchors: ["第二章行为规范类"],
      rowPairs: [["出言不逊", "100-500"]]
    };
    const source = {
      pageNumbers: [3],
      sectionHeadingPath: ["第二章行为规范类"],
      pdfTable: { tableId: "t" }
    };
    expect(
      scoreColdCase(c, [
        {
          text: "表头: 列1 | 列2\n行 1: 列1: 出言不逊 | 列2: 成长金 100-500\r\n元\n行 2: 列1: 其他",
          source
        }
      ]).pass
    ).toBe(true);
    expect(
      scoreColdCase(c, [
        { text: "行 1: 列1: 出言不逊 | 列2: 20元\n行 2: 列1: 其他 | 列2: 100-500元", source }
      ]).pass
    ).toBe(false);
  });
});
