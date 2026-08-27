import { describe, expect, it } from "vitest";
import {
  assertCleanupCountsAreZero,
  assertStagingRuntimeDatabaseTarget,
  createStructuredWindow,
  deleteStorageObjects,
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
        "mysql://enterprise_hub_app:secret@rm-2ze2m5q387ydb9724.rwlb.cn-beijing.rds.aliyuncs.com:3306/enterprise_hub"
      )
    ).not.toThrow();

    expect(() =>
      assertStagingRuntimeDatabaseTarget(
        "mysql://enterprise_hub_app:secret@127.0.0.1:3307/enterprise_hub"
      )
    ).toThrow("must run inside staging");
  });
});

describe("official manual acceptance remote controller", () => {
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
      "/opt/enterprise-hub/runtime.env",
      "-f",
      "/opt/enterprise-hub/docker-compose.yml",
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
        dishRows: 3,
        businessRows: 0,
        windowClaims: 1,
        qdrantPoints: 0,
        storageObjects: 0
      })
    ).toThrow("dishRows=3");
  });
});
