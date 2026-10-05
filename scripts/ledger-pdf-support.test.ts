import { describe, expect, it, vi } from "vitest";
import { createLedgerArchiveService } from "../packages/ledger-archive/src/service.js";
import type {
  LedgerArchiveRepository,
  LedgerRequestResult
} from "../packages/ledger-archive/src/repository.js";
import { assertLedgerCliDatabase, parseLedgerCliArgs, runLedgerCli } from "./ledger-pdf-support.js";

const key = (storeName: string, purchaseDate = "2026-10-01") => ({
  orgId: "org-a",
  storeName,
  purchaseDate
});
function repository() {
  const writes: unknown[] = [];
  const repo: LedgerArchiveRepository = {
    listPartitionKeys: vi.fn().mockResolvedValue({ keys: [key("A")], nextCursor: null }),
    findIdempotentRequest: vi.fn().mockResolvedValue(null),
    reserveRefresh: async (input) => {
      writes.push(input);
      return { requestId: `request-${writes.length}`, status: "queued" };
    },
    beginInternalRefresh: async (input) => {
      writes.push(input);
      return { requestId: "child", status: "queued", cursor: null, complete: false };
    },
    appendInternalRefreshPage: async (input) => {
      writes.push(input);
      return {
        requestId: "child",
        status: "queued",
        cursor: input.nextCursor,
        complete: input.nextCursor === null
      };
    },
    getRequestStatus: vi.fn().mockResolvedValue({
      kind: "refresh",
      counts: { failed: 1 },
      items: [
        { status: "succeeded", key: key("A") },
        { status: "failed", key: key("B") }
      ],
      nextCursor: null
    }),
    listFailedPartitionKeys: vi.fn().mockResolvedValue([key("B")])
  };
  return { repo, writes };
}
const argv = ["refresh", "--org-id", "org-a", "--store", "A", "--date", "2026-10-01"];

describe("developer ledger CLI", () => {
  it("merges repeated stores and dates without changing exact store names", () => {
    expect(
      parseLedgerCliArgs([
        ...argv,
        "--store",
        " A ",
        "--store",
        "A",
        "--date",
        "2026-10-02",
        "--date",
        "2026-10-01"
      ])
    ).toMatchObject({
      kind: "refresh",
      execute: false,
      selection: { storeNames: [" A ", "A"], dates: ["2026-10-01", "2026-10-02"] }
    });
  });
  it.each([
    ["refresh", "--store", "A", "--date", "2026-10-01"],
    ["refresh", "--org-id", "org-a", "--date", "2026-10-01"],
    ["refresh", "--org-id", "org-a", "--store", "A"],
    [...argv, "--all-stores"],
    [...argv, "--all-dates"],
    [...argv, "--start-date", "2026-10-01", "--end-date", "2026-10-02"],
    [
      "refresh",
      "--org-id",
      "org-a",
      "--all-stores",
      "--start-date",
      "2026-02-30",
      "--end-date",
      "2026-03-01"
    ],
    [...argv, "--execute"],
    [...argv, "--wait"],
    [...argv, "--unknown"]
  ])("refuses incomplete, conflicting or unsafe arguments %j", (...args) => {
    expect(() => parseLedgerCliArgs(args)).toThrow();
  });
  it("allows arbitrary history ranges and requires explicit remote admission", () => {
    expect(
      parseLedgerCliArgs([
        "refresh",
        "--org-id",
        "org-a",
        "--all-stores",
        "--start-date",
        "2020-01-01",
        "--end-date",
        "2026-10-01"
      ])
    ).toMatchObject({
      selection: { storeNames: null, startDate: "2020-01-01", endDate: "2026-10-01" }
    });
    expect(() => assertLedgerCliDatabase("mysql://user:private@remote.example/db", false)).toThrow(
      "--allow-remote"
    );
    expect(assertLedgerCliDatabase("mysql://user:private@127.0.0.1/db", false)).toEqual({
      host: "127.0.0.1",
      database: "db",
      remote: false
    });
    expect(assertLedgerCliDatabase("mysql://user:private@remote.example/db", true).remote).toBe(
      true
    );
  });
  it("defaults to dry-run and never writes tasks", async () => {
    const { repo, writes } = repository();
    const output: unknown[] = [];
    expect(
      await runLedgerCli(parseLedgerCliArgs(argv), {
        archive: createLedgerArchiveService(repo),
        now: () => new Date("2026-10-04T00:00:00Z"),
        output: (value) => output.push(value)
      })
    ).toBe(0);
    expect(writes).toEqual([]);
    expect(output.at(-1)).toMatchObject({
      mode: "dry-run",
      storeCount: 1,
      partitionCount: 1,
      estimatedTaskCount: 1
    });
  });
  it("iterates all pages including index-only old partitions in dry-run", async () => {
    const { repo, writes } = repository();
    repo.listPartitionKeys = vi
      .fn()
      .mockResolvedValueOnce({ keys: [key("A")], nextCursor: "second" })
      .mockResolvedValueOnce({ keys: [key("B", "2020-01-01")], nextCursor: null });
    const output: unknown[] = [];
    await runLedgerCli(
      parseLedgerCliArgs(["refresh", "--org-id", "org-a", "--all-stores", "--all-dates"]),
      {
        archive: createLedgerArchiveService(repo),
        now: () => new Date(),
        output: (value) => output.push(value)
      }
    );
    expect(output.at(-1)).toMatchObject({ storeCount: 2, partitionCount: 2 });
    expect(writes).toEqual([]);
    expect(repo.listPartitionKeys).toHaveBeenLastCalledWith({ orgId: "org-a", cursor: "second" });
  });
  it("full dry-run inspects every selected partition and reports failures without writing", async () => {
    const { repo, writes } = repository();
    repo.listPartitionKeys = vi.fn().mockResolvedValue({
      keys: [key("Healthy"), key("Missing"), key("Changed"), key("Forbidden")],
      nextCursor: null
    });
    const output: unknown[] = [];
    const visited: string[] = [];
    const code = await runLedgerCli(
      parseLedgerCliArgs(["refresh", "--org-id", "org-a", "--all-stores", "--all-dates"]),
      {
        archive: createLedgerArchiveService(repo),
        now: () => new Date(),
        output: (value) => output.push(value),
        inspectPartition: async (partition) => {
          visited.push(partition.storeName);
          if (partition.storeName === "Forbidden") throw new Error("private provider details");
          return partition.storeName !== "Healthy";
        }
      }
    );
    expect(visited).toEqual(["Healthy", "Missing", "Changed", "Forbidden"]);
    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(output.at(-1)).toMatchObject({
      partitionCount: 4,
      healthyCount: 1,
      abnormalCount: 2,
      failedCount: 1
    });
    expect(output).toContainEqual(
      expect.objectContaining({
        storeName: "Missing",
        needsRepair: true
      })
    );
    expect(JSON.stringify(output)).not.toContain("private provider details");
  });
  it("retry executes only failed partitions and preserves the parent request", async () => {
    const { repo, writes } = repository();
    await runLedgerCli(
      parseLedgerCliArgs([
        "retry-failed",
        "--org-id",
        "org-a",
        "--request-id",
        "parent",
        "--execute",
        "--request-key",
        "retry",
        "--operator",
        "developer"
      ]),
      { archive: createLedgerArchiveService(repo), now: () => new Date(), output: () => {} }
    );
    expect(writes[0]).toMatchObject({
      retryOfRequestId: "parent",
      actor: { kind: "operator", label: "developer" }
    });
    expect(writes[1]).toMatchObject({ keys: [key("B")], requestId: "child" });
  });
  it("SIGINT during enumeration stops after a committed page and keeps the request resumable", async () => {
    const { repo, writes } = repository();
    const controller = new AbortController();
    repo.listPartitionKeys = vi.fn().mockResolvedValue({ keys: [key("A")], nextCursor: "second" });
    const append = repo.appendInternalRefreshPage!;
    repo.appendInternalRefreshPage = async (input) => {
      const state = await append(input);
      controller.abort();
      return state;
    };
    const output: unknown[] = [];
    expect(
      await runLedgerCli(
        parseLedgerCliArgs([...argv, "--execute", "--request-key", "resume", "--operator", "ops"]),
        {
          archive: createLedgerArchiveService(repo),
          now: () => new Date(),
          output: (value) => output.push(value),
          signal: controller.signal
        }
      )
    ).toBe(130);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ requestId: "child", nextCursor: "second" });
    expect(output.at(-1)).toMatchObject({
      requestId: "child",
      interrupted: true,
      jobsContinue: true
    });
  });
  it("prints the durable request before an enumeration failure for same-key recovery", async () => {
    const { repo } = repository();
    repo.appendInternalRefreshPage = async () => {
      throw new Error("synthetic page failure");
    };
    const output: unknown[] = [];
    await expect(
      runLedgerCli(
        parseLedgerCliArgs([...argv, "--execute", "--request-key", "resume", "--operator", "ops"]),
        {
          archive: createLedgerArchiveService(repo),
          now: () => new Date(),
          output: (value) => output.push(value)
        }
      )
    ).rejects.toThrow("synthetic page failure");
    expect(output[0]).toMatchObject({ requestId: "child", enumeration: "pending" });
  });
  it("wait interruption returns 130 while already submitted jobs remain queued", async () => {
    const { repo, writes } = repository();
    repo.getRequestStatus = vi.fn().mockResolvedValue({
      requestId: "child",
      kind: "refresh",
      status: "running",
      items: [],
      nextCursor: null
    });
    const controller = new AbortController();
    const output: unknown[] = [];
    expect(
      await runLedgerCli(
        parseLedgerCliArgs([
          ...argv,
          "--execute",
          "--request-key",
          "key",
          "--operator",
          "ops",
          "--wait"
        ]),
        {
          archive: createLedgerArchiveService(repo),
          now: () => new Date(),
          output: (value) => output.push(value),
          signal: controller.signal,
          poll: async () => {
            controller.abort();
          }
        }
      )
    ).toBe(130);
    expect(writes[1]).toMatchObject({ keys: [key("A")] });
    expect(output.at(-1)).toMatchObject({ interrupted: true, jobsContinue: true });
  });
  it("status is independently callable and reports terminal failure as nonzero", async () => {
    const { repo } = repository();
    const result: LedgerRequestResult = {
      orgId: "org-a",
      requestId: "failed",
      actor: { kind: "operator", label: "developer" },
      retryOfRequestId: null,
      kind: "refresh",
      status: "partial_failed",
      items: [],
      counts: { queued: 0, running: 0, succeeded: 1, empty: 0, failed: 1, superseded: 0 },
      nextCursor: null
    };
    repo.getRequestStatus = vi.fn().mockResolvedValue(result);
    const output: unknown[] = [];
    expect(
      await runLedgerCli(
        parseLedgerCliArgs(["status", "--org-id", "org-a", "--request-id", "failed"]),
        {
          archive: createLedgerArchiveService(repo),
          now: () => new Date(),
          output: (value) => output.push(value)
        }
      )
    ).toBe(1);
    expect(output.at(-1)).toMatchObject({ status: "partial_failed" });
  });
});
