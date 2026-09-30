import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateStructuredHeaders } from "@smedc/domain";

const root = process.cwd();
const fixtureRoot = path.join(root, "fixtures", "manual-acceptance");

describe("manual acceptance scenario manifest", () => {
  it("has independent tasks, unique IDs, and valid account references", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(fixtureRoot, "scenarios.json"), "utf8")
    ) as {
      accounts: Record<string, { role: string; clearance: number }>;
      tasks: Array<{
        id: string;
        account: string;
        freshContext: boolean;
        turns: Array<{ id: string; prompt: string }>;
      }>;
    };

    // These accounts exercise role and clearance independently of prompt wording.
    expect(manifest.accounts).toEqual({
      "employee-low": { role: "employee", clearance: 0 },
      "employee-high": { role: "employee", clearance: 3 },
      admin: { role: "admin", clearance: 0 }
    });
    expect(manifest.tasks.length).toBeGreaterThan(0);
    expect(new Set(manifest.tasks.map((task) => task.id)).size).toBe(manifest.tasks.length);
    for (const task of manifest.tasks) {
      expect(task.id.trim()).not.toBe("");
      expect(manifest.accounts[task.account], task.id).toBeDefined();
      expect(task.freshContext, task.id).toBe(true);
      expect(task.turns, task.id).toHaveLength(1);
      for (const turn of task.turns) {
        expect(turn.id.trim(), task.id).not.toBe("");
        expect(turn.prompt.trim(), turn.id).not.toBe("");
      }
    }
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
