import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateStructuredHeaders } from "@enterprise-hub/domain";

const root = process.cwd();
const fixtureRoot = path.join(root, "fixtures", "manual-acceptance");

describe("manual acceptance scenario manifest", () => {
  it("keeps independent upload, conflicting-store, cold-search, and structured tasks in order", async () => {
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

    expect(manifest.version).toBe("2026-07-18.v2");
    expect(manifest.tasks.map((task) => task.id)).toEqual([
      "upload-baoli",
      "isolation-suzhou",
      "search-baoli",
      "structured-baoli"
    ]);
    expect(manifest.tasks.every((task) => task.freshContext)).toBe(true);
    expect(manifest.tasks.flatMap((task) => task.turns.map((turn) => turn.id))).toHaveLength(10);
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
      "$enterprise-hub-mcp",
      "enterprise hub mcp",
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

    const coldSearch = manifest.tasks
      .find((task) => task.id === "search-baoli")
      ?.turns.find((turn) => turn.id === "roujiamo-query");
    expect(coldSearch?.prompt).toBe(
      "用 baoli.manager@example.com 登录一下。我们的肉夹馍怎么做？要不要放青椒？"
    );

    const structuredQuery = manifest.tasks
      .find((task) => task.id === "structured-baoli")
      ?.turns.find((turn) => turn.id === "structured-query");
    expect(structuredQuery?.prompt).toBe(
      "这份表一共有多少条记录？销售额加起来是多少？销售额最高的两个菜是什么？"
    );
  });

  it("points the active skill at the official staging flow instead of the deleted local flow", async () => {
    const skill = await readFile(
      path.join(root, "skills", "enterprise-hub-manual-test", "SKILL.md"),
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
    expect(guide).not.toContain("--org-id org_demo");
    expect(guide).not.toContain("staging:access-tunnel");
    expect(guide).not.toContain("dates changed to `2030-01-01`");
  });

  it("requires async structured-upload polling in the employee skill and official acceptance guide", async () => {
    const [skill, guide] = await Promise.all([
      readFile(path.join(root, "skills", "enterprise-hub-mcp", "SKILL.md"), "utf8"),
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
    expect(guide).toContain("`rejected` terminal state");
  });

  it("makes the official acceptance runner poll accepted structured imports to terminal status", async () => {
    const runner = await readFile(
      path.join(root, "scripts", "official-manual-acceptance.ts"),
      "utf8"
    );

    expect(runner).toContain("pollStructuredImportStatus");
    expect(runner).toContain('"get_import_status"');
    expect(runner).toContain("Expected structured import to apply after polling");
    expect(runner).toContain("Expected invalid structured import to be rejected after polling");
    expect(runner).not.toContain("Expected structured import applied; got");
    expect(runner).not.toContain(
      "Invalid structured import did not return a validation-style failure."
    );
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
