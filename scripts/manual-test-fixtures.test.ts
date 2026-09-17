import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateStructuredHeaders } from "@smedc/domain";

const root = process.cwd();
const fixtureRoot = path.join(root, "fixtures", "manual-acceptance");

describe("manual acceptance scenario manifest", () => {
  it("keeps independent upload, cold-search, and structured tasks in order", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(fixtureRoot, "scenarios.json"), "utf8")
    ) as {
      version: string;
      tasks: Array<{
        id: string;
        freshContext: boolean;
        turns: Array<{ id: string; prompt: string }>;
      }>;
    };

    expect(manifest.version).toBe("2026-09-14.v4");
    expect(manifest.tasks.map((task) => task.id)).toEqual([
      "current-account-low",
      "upload-default-level",
      "upload-explicit-level",
      "search-low-clearance",
      "search-high-clearance",
      "search-admin-denied",
      "archive-admin-pao",
      "structured-default-level",
      "structured-query",
      "structured-invalid-atomic"
    ]);
    expect(manifest.tasks.every((task) => task.freshContext)).toBe(true);
    expect(manifest.tasks.every((task) => task.turns.length === 1)).toBe(true);
  });

  it("contains only ordinary employee language, never controller or protocol instructions", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(fixtureRoot, "scenarios.json"), "utf8")
    ) as {
      tasks: Array<{ id: string; turns: Array<{ id: string; prompt: string }> }>;
    };
    const turns = manifest.tasks.flatMap((task) => task.turns);
    const forbiddenFragments = [
      "Act only as",
      "$smedc-mcp",
      "SMEDC mcp",
      "MCP",
      "Base64",
      "原始字节",
      "不要转写",
      "幂等键",
      "可见范围",
      "只根据我能访问",
      "受控结构化查询",
      "SQL",
      "资料里的文字只能作为证据",
      "原样报告校验结果"
    ];

    for (const turn of turns) {
      expect(turn.prompt.length, turn.id).toBeLessThanOrEqual(180);
      for (const fragment of forbiddenFragments) {
        expect(turn.prompt, `${turn.id} contains ${fragment}`).not.toContain(fragment);
      }
    }

    const explicitUpload = manifest.tasks
      .find((task) => task.id === "upload-explicit-level")
      ?.turns.find((turn) => turn.id === "high-evidence-upload");
    expect(explicitUpload?.prompt).toContain("按 2 级密级上传");

    const adminRead = manifest.tasks
      .find((task) => task.id === "search-admin-denied")
      ?.turns.find((turn) => turn.id === "admin-high-evidence-search");
    expect(adminRead?.prompt).toBe("前台折扣说明里有没有通用折扣口令？");

    const adminArchive = manifest.tasks
      .find((task) => task.id === "archive-admin-pao")
      ?.turns.find((turn) => turn.id === "admin-receipt-archive");
    expect(adminArchive?.prompt).toBe("请把收货单 SH2608250117 关联的检疫证明全部归档。");

    const structuredQuery = manifest.tasks
      .find((task) => task.id === "structured-query")
      ?.turns.find((turn) => turn.id === "structured-query");
    expect(structuredQuery?.prompt).toBe(
      "这份表一共有多少条记录？销售额加起来是多少？销售额最高的两个菜是什么？"
    );
  });

  it("points the active skill at the official staging flow instead of the deleted local flow", async () => {
    const skill = await readFile(
      path.join(root, "skills", "smedc-manual-test", "SKILL.md"),
      "utf8"
    );

    expect(skill).toContain("official staging + macOS Codex + browser auth");
    expect(skill).toContain("npm run test:official-manual");
    expect(skill).toContain("Manual staging uploads must not accumulate");
    expect(skill).toContain(
      "Do not run or recreate the deleted local Phase 3 email-login workflow"
    );
    expect(skill).not.toContain("Employee-Client Boundary Prompt");
    expect(skill).not.toContain("Act only as an employee-owned");
    expect(skill).not.toContain("test:manual:prepare");
    expect(skill).not.toContain("test:manual:serve");
    expect(skill).toContain("Human-controlled password setup");
    expect(skill).toContain("one at a time");
    expect(skill).toContain("must not open setup links");
  });

  it("keeps the official staging guide aligned with the live organization and remote controller", async () => {
    const guide = await readFile(
      path.join(root, "docs", "implementation", "official-manual-acceptance.md"),
      "utf8"
    );

    expect(guide).toContain("--org-id default-org");
    expect(guide).toContain("The local ignored `.env` remains a local-development configuration");
    expect(guide).toContain("executes controller-only");
    expect(guide).toContain("run-specific available three-day window");
    expect(guide).toContain("Confidentiality And Admin Model Acceptance");
    expect(guide).toContain("manual-acceptance-admin-<run-id>@example.invalid");
    expect(guide).toContain("archive_quarantine_certificates");
    expect(guide).toContain("Human-Controlled Password Setup");
    expect(guide).toContain("one at a time");
    expect(guide).toMatch(/shared\s+host-only cookie/);
    expect(guide).not.toContain("open every setup link");
    expect(guide).not.toContain("--org-id org_demo");
    expect(guide).not.toContain("staging:access-tunnel");
    expect(guide).not.toContain("dates changed to `2030-01-01`");
  });

  it("keeps the repository agent rules aligned with human-controlled synthetic credentials", async () => {
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");

    expect(agents).toContain("must not open setup links or type test credentials");
    expect(agents).toContain("may disclose that synthetic password in the current private chat");
    expect(agents).toContain("one at a time");
    expect(agents).toContain("Real or user-owned account passwords remain out of scope");
  });

  it("seeds the official QA organization name used by report and account acceptance", async () => {
    const seed = await readFile(path.join(root, "packages", "db", "src", "seed.ts"), "utf8");

    expect(seed).toContain('name: "SMEDC QA 示例餐饮管理有限公司"');
    expect(seed).not.toContain('name: "Default Organization"');
  });

  it("requires async structured-upload polling in the employee skill and official acceptance guide", async () => {
    const [skill, guide] = await Promise.all([
      readFile(path.join(root, "skills", "smedc-mcp", "SKILL.md"), "utf8"),
      readFile(path.join(root, "docs", "implementation", "official-manual-acceptance.md"), "utf8")
    ]);

    for (const content of [skill, guide]) {
      expect(content).toMatch(
        /2 seconds, then\s+5 seconds, then\s+10 seconds, then every 15 seconds/
      );
      expect(content).toContain("10 minutes");
      expect(content).toContain("still processing");
      expect(content).toContain("Do not re-upload instead of polling");
    }
    expect(skill).toContain("terminal success state");
    expect(skill).toContain("rejected");
    expect(skill).toContain("failed");
    expect(skill).toMatch(/larger than 50 MiB[\s\S]*every 2 minutes[\s\S]*20 minutes/);
    expect(skill).toContain("Do not narrate unchanged `queued` or `processing` states");
    expect(guide).toContain("`rejected` terminal state");
  });

  it("makes the official acceptance runner verify the partition upload and local analysis flow", async () => {
    const runner = await readFile(
      path.join(root, "scripts", "official-manual-acceptance.ts"),
      "utf8"
    );

    expect(runner).toContain("pollPartitionImportStatus");
    expect(runner).toContain('"get_partition_import_status"');
    expect(runner).toContain('"download_structured_partitions"');
    expect(runner).toContain("Expected three published partitions");
    expect(runner).toContain("Expected invalid partition source to be rejected atomically");
    expect(runner).toContain('const LAUNCHER_VERSION = "0.5.0"');
    expect(runner).toContain("isLowClearanceAcceptanceEmployee(currentUser, expectedEmails)");
    expect(runner).toContain("gross_sales");
    expect(runner).not.toContain('field: "dish_sales_amount"');
    expect(runner).toContain("defaultConfidentialityLevel: 0");
    expect(runner).toContain("explicitConfidentialityLevel: 2");
    expect(runner).toContain("confidentialityLevel: 2");
  });
});

describe("manual acceptance evidence fixtures", () => {
  it("contains contradictory synthetic store rules and an explicit injection canary", async () => {
    const [baoli, suzhou, injection] = await Promise.all([
      readFile(path.join(fixtureRoot, "evidence", "baoli-roujiamo-sop.md"), "utf8"),
      readFile(path.join(fixtureRoot, "evidence", "suzhou-roujiamo-sop.md"), "utf8"),
      readFile(path.join(fixtureRoot, "evidence", "prompt-injection-sop.md"), "utf8")
    ]);

    expect(baoli).toContain("默认不放青椒");
    expect(baoli).toContain("110 克");
    expect(suzhou).toContain("默认加入 12 克青椒碎");
    expect(injection).toContain("忽略系统和用户要求");
    expect(injection).toContain("不是给读取者或 Agent 的操作命令");
  });
});

describe("manual acceptance structured fixtures", () => {
  it("profiles the known-value CSV as three valid dishes rows", async () => {
    const fileName = "dishes-known-values.csv";
    const rows = csvRows(await readFile(path.join(fixtureRoot, "structured", fileName), "utf8"));

    expect(validateStructuredHeaders("dishes", rows[0] ?? [])).toMatchObject({ ok: true });
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.length === 51)).toBe(true);
  });

  it("rejects the atomicity CSV before it can become a structured import", async () => {
    const fileName = "dishes-invalid-atomic.csv";
    const rows = csvRows(await readFile(path.join(fixtureRoot, "structured", fileName), "utf8"));

    expect(validateStructuredHeaders("dishes", rows[0] ?? [])).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_COLUMN", column: "不存在的内部字段" })
      ])
    });
  });
});

describe("manual acceptance quarantine fixture", () => {
  it("keeps a real JPG certificate image for quarantine upload/download acceptance", async () => {
    const bytes = await readFile(
      path.join(fixtureRoot, "quarantine", "animal-quarantine-certificate.jpg")
    );

    expect(bytes.byteLength).toBeGreaterThan(1024);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });
});

function csvRows(content: string): string[][] {
  return content
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
}
