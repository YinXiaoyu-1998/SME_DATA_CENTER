import { readFile } from "node:fs/promises";
import { parse as parseCsv } from "csv-parse/sync";
import { COST_CARD_UPLOAD_SCHEMA, PHASE3_RUNTIME_LIMIT_DEFAULTS } from "@smedc/domain";
import { describe, expect, it } from "vitest";
import {
  assertCleanupCountsAreZero,
  readCostCardAcceptanceCsv,
  assertStagingRuntimeDatabaseTarget,
  createStructuredWindow,
  deleteStorageObjects,
  isLowClearanceAcceptanceEmployee,
  isAcceptanceAccount,
  isReusedAcceptanceAccount,
  validateAcceptanceScope,
  acceptanceAccountEmails,
  pollStructuredImportStatus,
  rewriteKnownValuesFixture
} from "./official-manual-acceptance-support.js";
import {
  buildRemoteControllerCommand,
  buildStagingSshArgs
} from "./official-manual-remote-controller.js";

describe("official manual acceptance staging database target", () => {
  it("accepts only the private staging RDS target inside the remote runtime", () => {
    expect(() =>
      assertStagingRuntimeDatabaseTarget(
        "mysql://smedc_app:secret@rm-2ze2m5q387ydb9724.rwlb.cn-beijing.rds.aliyuncs.com:3306/smedc"
      )
    ).not.toThrow();

    expect(() =>
      assertStagingRuntimeDatabaseTarget("mysql://smedc_app:secret@127.0.0.1:3307/smedc")
    ).toThrow("must run inside staging");
  });
});

describe("official manual acceptance current account", () => {
  const expectedEmails = new Set(["manual-full-flow-low-run@example.invalid"]);

  it("allows only the explicitly selected existing admin without changing its clearance", () => {
    const user = {
      displayName: "Existing QA",
      email: "qa@example.invalid",
      role: "admin",
      clearance: 3
    };
    expect(isReusedAcceptanceAccount({ user }, user.email)).toBe(true);
    expect(isReusedAcceptanceAccount({ user }, "another@example.invalid")).toBe(false);
    expect(isReusedAcceptanceAccount({ user: { ...user, role: "employee" } }, user.email)).toBe(
      false
    );
  });

  it("binds each role and clearance to its own run identity, including all cleanup owners", () => {
    const accounts = [
      {
        account: "employee-low" as const,
        email: "manual-full-flow-low-run@example.invalid",
        role: "employee",
        clearance: 0
      },
      {
        account: "employee-high" as const,
        email: "manual-full-flow-high-run@example.invalid",
        role: "employee",
        clearance: 3
      },
      {
        account: "admin" as const,
        email: "manual-acceptance-admin-run@example.invalid",
        role: "admin",
        clearance: 0
      }
    ];
    for (const expected of accounts) {
      const result = { user: { ...expected, displayName: "Synthetic acceptance" } };
      expect(isAcceptanceAccount(result, "run", expected.account)).toBe(true);
      expect(acceptanceAccountEmails("run")).toContain(expected.email);
      expect(isAcceptanceAccount(result, "another-run", expected.account)).toBe(false);
      expect(
        isAcceptanceAccount({ user: { ...result.user, clearance: 2 } }, "run", expected.account)
      ).toBe(false);
      expect(
        isAcceptanceAccount(
          { user: { ...result.user, role: expected.role === "admin" ? "employee" : "admin" } },
          "run",
          expected.account
        )
      ).toBe(false);
    }
    expect(
      isAcceptanceAccount(
        { user: { ...accounts[0]!, displayName: "Synthetic", email: accounts[1]!.email } },
        "run",
        "employee-low"
      )
    ).toBe(false);
  });

  it("accepts the nested current-user result for the low-clearance employee", () => {
    expect(
      isLowClearanceAcceptanceEmployee(
        {
          user: {
            email: "manual-full-flow-low-run@example.invalid",
            displayName: "Manual low employee",
            role: "employee",
            clearance: 0
          }
        },
        expectedEmails
      )
    ).toBe(true);
  });

  it("rejects an admin or an employee with the wrong clearance", () => {
    expect(
      isLowClearanceAcceptanceEmployee(
        {
          user: {
            email: "manual-full-flow-low-run@example.invalid",
            displayName: "Manual low employee",
            role: "admin",
            clearance: 0
          }
        },
        expectedEmails
      )
    ).toBe(false);
    expect(
      isLowClearanceAcceptanceEmployee(
        {
          user: {
            email: "manual-full-flow-low-run@example.invalid",
            displayName: "Manual low employee",
            role: "employee",
            clearance: 1
          }
        },
        expectedEmails
      )
    ).toBe(false);
  });
});

describe("official manual acceptance remote controller", () => {
  it("passes explicit cleanup IDs without granting cleanup of an existing uploader's other data", () => {
    const scope = {
      reuseSession: "qa@example.invalid",
      documentIds: ["doc_run"],
      partitionJobIds: ["pjob_run"]
    };
    expect(buildRemoteControllerCommand("cleanup", "safe-run", scope)).toEqual(
      expect.arrayContaining([
        "--reuse-session=qa@example.invalid",
        "--document-id=doc_run",
        "--partition-job-id=pjob_run"
      ])
    );
    expect(() => validateAcceptanceScope({ ...scope, documentIds: ["doc_run;echo"] })).toThrow();
    expect(() => validateAcceptanceScope({ ...scope, reuseSession: undefined })).toThrow();
  });
  it("uses strict SSH host verification and the staging container runtime", () => {
    const sshArgs = buildStagingSshArgs();
    const command = buildRemoteControllerCommand("cleanup", "safe-run");

    expect(sshArgs).toContain("StrictHostKeyChecking=yes");
    expect(sshArgs.some((arg) => arg.startsWith("UserKnownHostsFile="))).toBe(true);
    expect(command).toEqual([
      "docker",
      "compose",
      "--profile",
      "release",
      "--env-file",
      "/opt/smedc/runtime.env",
      "-f",
      "/opt/smedc/docker-compose.yml",
      "run",
      "-T",
      "--rm",
      "release-ops",
      "node",
      "dist/release/official-manual-acceptance.js",
      "controller-cleanup",
      "--run-id=safe-run"
    ]);
  });
});

describe("official manual acceptance structured windows", () => {
  it("derives a stable run-specific three-day window and can probe another candidate", () => {
    const first = createStructuredWindow("run-one", 0);
    const repeated = createStructuredWindow("run-one", 0);
    const alternate = createStructuredWindow("run-one", 1);

    expect(first).toEqual(repeated);
    expect(first).not.toEqual(alternate);
    expect(first.startDate).not.toBe("2030-01-01");
    expect(first.dates).toHaveLength(3);
    expect(first.endDate).toBe(first.dates[2]);
  });

  it("rewrites the known-value fixture into the selected window", () => {
    const source = [
      "2026-07-01,2026/07,2026第27周",
      "2026-07-02,2026/07,2026第27周",
      "2026-07-03,2026/07,2026第27周"
    ].join("\n");
    const window = createStructuredWindow("fixture-run", 0);
    const rewritten = rewriteKnownValuesFixture(source, window);

    expect(rewritten).toContain(window.dates[0]!);
    expect(rewritten).toContain(window.dates[1]!);
    expect(rewritten).toContain(window.dates[2]!);
    expect(rewritten).not.toContain("2030-01");
    expect(rewritten).not.toContain("2026-07");
  });
});

describe("official manual acceptance structured import polling", () => {
  it("uses the documented polling cadence until the import is applied", async () => {
    const delays: number[] = [];
    const statuses = ["pending", "validating", "applied"];

    const result = await pollStructuredImportStatus({
      importBatchId: "imp_manual",
      getStatus: async () => ({
        importBatch: {
          importBatchId: "imp_manual",
          status: statuses.shift() ?? "applied"
        }
      }),
      sleep: async (delayMs) => {
        delays.push(delayMs);
      }
    });

    expect(result.importBatch.status).toBe("applied");
    expect(delays).toEqual([2_000, 5_000, 10_000]);
  });

  it("stops after ten minutes and tells the employee the import is still processing", async () => {
    let now = 0;
    const delays: number[] = [];

    await expect(
      pollStructuredImportStatus({
        importBatchId: "imp_stuck",
        getStatus: async () => ({
          importBatch: { importBatchId: "imp_stuck", status: "pending" }
        }),
        now: () => now,
        sleep: async (delayMs) => {
          delays.push(delayMs);
          now += delayMs;
        }
      })
    ).rejects.toThrow("still processing after 10 minutes");

    expect(delays.slice(0, 4)).toEqual([2_000, 5_000, 10_000, 15_000]);
    expect(delays.reduce((total, delayMs) => total + delayMs, 0)).toBe(600_000);
  });
});

describe("official manual acceptance cleanup", () => {
  it("propagates object deletion failures instead of reporting a false cleanup", async () => {
    const storage = {
      deleteObject: async (key: string) => {
        if (key === "broken") throw new Error("OSS unavailable");
      }
    };

    await expect(deleteStorageObjects(storage, ["ok", "broken"])).rejects.toThrow(
      "OSS unavailable"
    );
  });

  it("rejects any non-zero post-cleanup residue", () => {
    expect(() =>
      assertCleanupCountsAreZero({
        documents: 0,
        importBatches: 0,
        structuredPartitions: 0,
        partitionImportJobs: 0,
        costCards: 0,
        costCardResources: 0,
        costCardSourceResources: 0,
        costCardResourceScopes: 0,
        storageGarbage: 0,
        vipRows: 0,
        dishCatalogRows: 0,
        deliveryLedgerRows: 3,
        supplierCatalogRows: 0,
        quarantineCertificates: 0,
        windowClaims: 1,
        qdrantPoints: 0,
        storageObjects: 0
      })
    ).toThrow("deliveryLedgerRows=3");
  });
});

describe("cost-card changed-workflow local CSV oracle", () => {
  const headers = [
    ...COST_CARD_UPLOAD_SCHEMA.map((field) => field.sourceColumn),
    "source_sheet_index",
    "source_sheet_name",
    "source_row_number"
  ];
  const values: Record<string, string> = {
    菜品SPU编码: "0001",
    菜品SKU编码: "0012",
    售卖价: "36.123456",
    物品编码: "0007",
    净料量: "0.000001",
    source_sheet_index: "0",
    source_sheet_name: "合成页",
    source_row_number: "2"
  };
  const row = headers.map((header) => values[header] ?? "");
  const csv = `${headers.join(",")}\n${row.join(",")}\n`;
  it("retains all 38 fields, exact decimals, leading-zero codes and source locations", () => {
    const rows = readCostCardAcceptanceCsv(csv, { spuId: "0001", skuId: "0012" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      菜品SPU编码: "0001",
      菜品SKU编码: "0012",
      售卖价: "36.123456",
      物品编码: "0007",
      净料量: "0.000001",
      source_sheet_name: "合成页",
      source_row_number: "2"
    });
  });
  it("rejects a source upload template and mixed card identities", () => {
    expect(() =>
      readCostCardAcceptanceCsv("菜品SPU编码,菜品SKU编码\n0001,0012\n", {
        spuId: "0001",
        skuId: "0012"
      })
    ).toThrow("38-column");
    expect(() => readCostCardAcceptanceCsv(csv, { spuId: "0002", skuId: "0012" })).toThrow(
      "identity"
    );
  });
  it("keeps the candidate fixture small, complete and separate from current published scenarios", async () => {
    const source = await readFile(
      "fixtures/manual-acceptance/structured/cost-cards-known-values.csv",
      "utf8"
    );
    const records = parseCsv(source, { columns: true, skip_empty_lines: true }) as Record<
      string,
      string
    >[];
    expect(Object.keys(records[0]!)).toEqual(
      COST_CARD_UPLOAD_SCHEMA.map((field) => field.sourceColumn)
    );
    expect(records).toHaveLength(6);
    expect(new Set(records.map((r) => `${r["菜品SPU编码"]}:${r["菜品SKU编码"]}`)).size).toBe(3);
    expect(new Set(records.map((r) => r["菜品名称"])).size).toBe(1);
    expect(records.filter((r) => r["净料量"] === "0")).toHaveLength(3);
    const { parseCostCardFile, groupCostCardRows } =
      await import("../packages/structured-ingestion/src/cost-cards.js");
    const raw = await parseCostCardFile({
      dataset: "cost_cards",
      fileName: "cost-cards-known-values.csv",
      fileType: "csv",
      content: Buffer.from(source),
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
    });
    expect(raw.validationErrors).toEqual([]);
    const grouped = groupCostCardRows(raw.rows, { enterpriseKey: "synthetic-enterprise" });
    expect(grouped.validationErrors).toEqual([]);
    expect(grouped.inputCardCount).toBe(3);
    expect(grouped.inputItemRowCount).toBe(6);
    const scenarios = JSON.parse(
      await readFile("fixtures/manual-acceptance/scenarios.json", "utf8")
    );
    expect(scenarios.candidateCostCards.releaseGate).toContain("Published launcher 0.10.0");
    expect(scenarios.candidateCostCards.tasks.map((task: { id: string }) => task.id)).toContain(
      "cost-card-after-original-archive"
    );
  });
});
