import { describe, expect, it } from "vitest";
import { parseLedgerScope } from "./scope.js";

describe("ledger scope", () => {
  it("validates real calendar days, including leap years", () => {
    expect(() => parseLedgerScope({ storeNames: ["A"], dates: ["2026-02-29"] })).toThrow(
      "LEDGER_SCOPE_INVALID"
    );
    expect(parseLedgerScope({ storeNames: ["A"], dates: ["2024-02-29"] })).toEqual({
      storeNames: ["A"],
      dates: ["2024-02-29"]
    });
  });
});

it("deduplicates discrete days without normalizing store identity", () => {
  expect(
    parseLedgerScope({
      storeNames: ["A", " A ", "A"],
      dates: ["2026-10-02", "2026-10-01", "2026-10-02"]
    })
  ).toEqual({ storeNames: [" A ", "A"], dates: ["2026-10-01", "2026-10-02"] });
});
it("rejects oversized scopes, reversed ranges and mixed date selectors", () => {
  expect(() =>
    parseLedgerScope({
      storeNames: Array.from({ length: 51 }, (_, i) => `store-${i}`),
      dates: ["2026-10-01"]
    })
  ).toThrow("LEDGER_SCOPE_LIMIT_EXCEEDED");
  expect(() =>
    parseLedgerScope({ storeNames: ["A"], startDate: "2025-01-01", endDate: "2026-01-02" })
  ).toThrow("LEDGER_SCOPE_LIMIT_EXCEEDED");
  expect(() =>
    parseLedgerScope({
      storeNames: ["A"],
      dates: Array.from({ length: 367 }, (_, i) =>
        new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10)
      )
    })
  ).toThrow("LEDGER_SCOPE_LIMIT_EXCEEDED");
  expect(() =>
    parseLedgerScope({ storeNames: ["A"], startDate: "2026-10-02", endDate: "2026-10-01" })
  ).toThrow("LEDGER_SCOPE_INVALID");
  expect(() =>
    parseLedgerScope({
      storeNames: ["A"],
      dates: ["2026-10-01"],
      startDate: "2026-10-01",
      endDate: "2026-10-01"
    })
  ).toThrow("LEDGER_SCOPE_INVALID");
});
