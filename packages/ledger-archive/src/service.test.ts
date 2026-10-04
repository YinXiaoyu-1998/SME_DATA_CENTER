import { describe, expect, it, vi } from "vitest";
import { createLedgerArchiveService, reduceLedgerRequestStatus } from "./service.js";
import type { LedgerArchiveRepository } from "./repository.js";

it("treats empty as complete and superseded as an unfulfilled generation", () => {
  expect(reduceLedgerRequestStatus(["empty", "succeeded"])).toBe("succeeded");
  expect(reduceLedgerRequestStatus(["superseded"])).toBe("failed");
  expect(reduceLedgerRequestStatus(["succeeded", "superseded"])).toBe("partial_failed");
  expect(reduceLedgerRequestStatus(["failed", "queued"])).toBe("running");
});

describe("ledger archive service", () => {
  it("fingerprints canonical scope and the actor, independent of current facts", async () => {
    const reserveRefresh = vi.fn().mockResolvedValue({ requestId: "request-a", status: "queued" });
    const repository = {
      listPartitionKeys: vi.fn().mockResolvedValue({ keys: [], nextCursor: null }),
      reserveRefresh,
      findIdempotentRequest: vi.fn().mockResolvedValue(null),
      getRequestStatus: vi.fn(),
      listFailedPartitionKeys: vi.fn()
    } satisfies LedgerArchiveRepository;
    const service = createLedgerArchiveService(repository);
    const common = {
      orgId: "org-a",
      actor: { kind: "operator" as const, label: "ops" },
      idempotencyKey: "same-key"
    };
    await service.requestRefresh({
      ...common,
      scope: { storeNames: ["B", "A"], dates: ["2024-02-29", "2024-02-29"] }
    });
    await service.requestRefresh({
      ...common,
      scope: { storeNames: ["A", "B"], startDate: "2024-02-29", endDate: "2024-02-29" }
    });
    expect(reserveRefresh.mock.calls[0]?.[0].requestFingerprint).toBe(
      reserveRefresh.mock.calls[1]?.[0].requestFingerprint
    );
    await service.requestRefresh({
      ...common,
      actor: { kind: "employee", employeeId: "other" },
      scope: { storeNames: ["A", "B"], dates: ["2024-02-29"] }
    });
    expect(reserveRefresh.mock.calls[2]?.[0].requestFingerprint).not.toBe(
      reserveRefresh.mock.calls[0]?.[0].requestFingerprint
    );
    reserveRefresh.mockClear();
    expect(
      await service.previewRefresh({
        orgId: "org-a",
        scope: { storeNames: ["A"], dates: ["2024-02-29"] }
      })
    ).toMatchObject({ partitionCount: 0, estimatedTaskCount: 0 });
    expect(reserveRefresh).not.toHaveBeenCalled();
  });
});

it("refuses more than 5,000 actual partitions without enqueueing", async () => {
  const repository = {
    listPartitionKeys: vi.fn().mockResolvedValue({
      keys: Array.from({ length: 5_001 }, (_, index) => ({
        orgId: "org-a",
        storeName: `store-${index}`,
        purchaseDate: "2026-10-01"
      })),
      nextCursor: null
    }),
    reserveRefresh: vi.fn(),
    findIdempotentRequest: vi.fn().mockResolvedValue(null),
    getRequestStatus: vi.fn(),
    listFailedPartitionKeys: vi.fn()
  } satisfies LedgerArchiveRepository;
  await expect(
    createLedgerArchiveService(repository).requestRefresh({
      orgId: "org-a",
      actor: { kind: "operator", label: "ops" },
      idempotencyKey: "limit",
      scope: { storeNames: ["A"], dates: ["2026-10-01"] }
    })
  ).rejects.toThrow("LEDGER_SCOPE_LIMIT_EXCEEDED");
  expect(repository.reserveRefresh).not.toHaveBeenCalled();
});

it("keeps single-partition idempotency independent of key property order", async () => {
  const reserveRefresh = vi.fn().mockResolvedValue({ requestId: "request-a", status: "queued" });
  const repository = {
    listPartitionKeys: vi.fn(),
    reserveRefresh,
    findIdempotentRequest: vi.fn(),
    getRequestStatus: vi.fn(),
    listFailedPartitionKeys: vi.fn()
  } satisfies LedgerArchiveRepository;
  const service = createLedgerArchiveService(repository);
  const common = {
    actor: { kind: "operator" as const, label: "ops" },
    idempotencyKey: "same",
    onlyIfNeeded: false
  };
  await service.requestPartitionRefresh({
    ...common,
    key: { orgId: "org-a", storeName: "A", purchaseDate: "2026-10-01" }
  });
  await service.requestPartitionRefresh({
    ...common,
    key: { purchaseDate: "2026-10-01", storeName: "A", orgId: "org-a" }
  });
  expect(reserveRefresh.mock.calls[1]?.[0].requestFingerprint).toBe(
    reserveRefresh.mock.calls[0]?.[0].requestFingerprint
  );
});

it("rejects unrepresentable exact paths in preview and refresh before reservation", async () => {
  const reserveRefresh = vi.fn().mockResolvedValue({ requestId: "request-a", status: "queued" });
  const repository = {
    objectKeyPrefix: "中".repeat(180),
    listPartitionKeys: vi.fn().mockResolvedValue({ keys: [], nextCursor: null }),
    reserveRefresh,
    findIdempotentRequest: vi.fn().mockResolvedValue(null),
    getRequestStatus: vi.fn(),
    listFailedPartitionKeys: vi.fn()
  } satisfies LedgerArchiveRepository;
  const service = createLedgerArchiveService(repository);
  const scope = { storeNames: ["a".repeat(512)], dates: ["2026-10-01"] };
  await expect(service.previewRefresh({ orgId: "org-a", scope })).rejects.toThrow(
    "LEDGER_OBJECT_KEY_TOO_LONG"
  );
  await expect(
    service.requestRefresh({
      orgId: "org-a",
      scope,
      actor: { kind: "operator", label: "ops" },
      idempotencyKey: "long-prefix"
    })
  ).rejects.toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
  await expect(
    service.requestPartitionRefresh({
      key: { orgId: "org-a", storeName: "中".repeat(512), purchaseDate: "2026-10-01" },
      actor: { kind: "operator", label: "ops" },
      idempotencyKey: "long-name",
      onlyIfNeeded: false
    })
  ).rejects.toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
  expect(reserveRefresh).not.toHaveBeenCalled();
});
