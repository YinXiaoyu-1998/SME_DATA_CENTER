import { describe, expect, it, vi } from "vitest";
import { requireCurrentDirectoryEligibility } from "./business-authorization.js";
import {
  getSourceReadRequirements,
  deriveStructuredSourceScopes,
  requirePublicationAttributes
} from "./source-read-requirements.js";

const rows = (...stores: string[]) => stores.map((store_name) => ({ payload: { store_name } }));
describe("authoritative successful source scopes", () => {
  it("retains only successful parsed A scope while ignored worksheets contribute no invented scope", () => {
    const parsed = { rows: rows("A", "A"), ignoredSheets: [{ name: "B notes" }] };
    expect(
      deriveStructuredSourceScopes({
        dataset: "business",
        enterpriseKey: "enterprise",
        rows: parsed.rows
      })
    ).toEqual([
      { enterpriseKey: "enterprise", ownership: "store", storeName: "A", dimensions: {} }
    ]);
  });
  it("deduplicates complete A/B scopes without reducing them to a current or visible subset", () => {
    expect(
      deriveStructuredSourceScopes({
        dataset: "dishes",
        enterpriseKey: "enterprise",
        rows: rows("A", "B", "A")
      }).map((scope) => scope.storeName)
    ).toEqual(["A", "B"]);
  });
  it("keeps membership and both catalogs group-owned despite row store fields", () => {
    for (const dataset of ["vip", "dish_catalog", "supplier_catalog"] as const)
      expect(
        deriveStructuredSourceScopes({ dataset, enterpriseKey: "enterprise", rows: rows("A", "B") })
      ).toEqual([{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }]);
  });
  it("rejects empty store names and zero parsed rows, preserves exact case and trailing spaces", () => {
    expect(() =>
      deriveStructuredSourceScopes({
        dataset: "business",
        enterpriseKey: "enterprise",
        rows: rows("")
      })
    ).toThrow("RESOURCE_ATTRIBUTES_NOT_READY");
    expect(() =>
      deriveStructuredSourceScopes({ dataset: "vip", enterpriseKey: "enterprise", rows: [] })
    ).toThrow("SOURCE_HAS_NO_PARSED_ROWS");
    expect(
      deriveStructuredSourceScopes({
        dataset: "business",
        enterpriseKey: "enterprise",
        rows: rows("Store", "store", "Store ")
      }).map((scope) => scope.storeName)
    ).toEqual(["Store", "store", "Store "]);
    expect(() =>
      deriveStructuredSourceScopes({
        dataset: "delivery_ledger",
        enterpriseKey: "enterprise",
        rows: rows("A", "B")
      })
    ).toThrow("RESOURCE_SINGLE_STORE_REQUIRED");
  });
  it("requires complete current configured attributes in enabled mode, with explicit legacy separation", () => {
    const scopes = [{ enterpriseKey: "enterprise", ownership: "group" as const, dimensions: {} }];
    expect(() => requirePublicationAttributes("enabled", null, scopes)).toThrow(
      "RESOURCE_CATEGORY_NOT_CONFIGURED"
    );
    expect(() =>
      requirePublicationAttributes(
        "enabled",
        {
          id: "vip",
          kind: "fixed",
          confidentialityLevel: null,
          ownerships: ["group"],
          requiredDimensionIds: []
        },
        scopes
      )
    ).toThrow("RESOURCE_CATEGORY_NOT_CONFIGURED");
    expect(() =>
      requirePublicationAttributes(
        "enabled",
        {
          id: "vip",
          kind: "fixed",
          confidentialityLevel: 1,
          ownerships: ["group"],
          requiredDimensionIds: ["project"]
        },
        scopes
      )
    ).toThrow("RESOURCE_ATTRIBUTES_NOT_READY");
    expect(() => requirePublicationAttributes("legacy", null, scopes)).not.toThrow();
    expect(() => requirePublicationAttributes("suspended", null, scopes)).toThrow(
      "AUTHORIZATION_SUSPENDED"
    );
    expect(() => requirePublicationAttributes("legacy", null, scopes, undefined, true)).toThrow(
      "RESOURCE_CATEGORY_NOT_CONFIGURED"
    );
    expect(() => requirePublicationAttributes("suspended", null, scopes, undefined, true)).toThrow(
      "AUTHORIZATION_SUSPENDED"
    );
  });
});

it("reads complete source requirements in one client transaction without opening nested transactions", async () => {
  const tx = {
    $transaction: vi.fn(() => {
      throw new Error("nested transaction");
    }),
    document: { findFirst: vi.fn(async () => ({ status: "active", archivedAt: null })) },
    businessResource: {
      findMany: vi.fn(async () => [
        {
          orgId: "org",
          fileConfidentialityLevel: null,
          categoryId: "business",
          valid: true,
          scopes: [
            { enterpriseKey: "enterprise", ownership: "store", storeName: "A", dimensions: [] },
            { enterpriseKey: "enterprise", ownership: "store", storeName: "B", dimensions: [] }
          ]
        }
      ])
    }
  };
  const client = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(tx))
  };
  const requirements = await getSourceReadRequirements(
    client as unknown as import("@prisma/client").PrismaClient,
    "original",
    "org"
  );
  expect(requirements[0]?.scopes.map((scope) => scope.storeName)).toEqual(["A", "B"]);
  expect(client.$transaction).toHaveBeenCalledTimes(1);
  expect(tx.$transaction).not.toHaveBeenCalled();
});

describe("current directory eligibility", () => {
  function fixture() {
    const directory = {
      category: false,
      store: false,
      dimension: false,
      value: false,
      adminActive: true
    };
    const tx = {
      businessCategory: { findUnique: vi.fn(async () => ({ retired: directory.category })) },
      businessStore: { findUnique: vi.fn(async () => ({ retired: directory.store })) },
      businessDimension: { findUnique: vi.fn(async () => ({ retired: directory.dimension })) },
      businessDimensionValue: { findUnique: vi.fn(async () => ({ retired: directory.value })) },
      employee: { findFirst: vi.fn(async () => ({ id: "admin" })) },
      auditLog: { create: vi.fn(async () => ({})) },
      $queryRaw: vi.fn(async (query: { strings: readonly string[] }) => {
        const sql = query.strings.join("");
        if (sql.includes("FROM employees")) return directory.adminActive ? [{ id: "admin" }] : [];
        if (sql.includes("FROM business_category_dimensions")) return [];
        const kind = sql.includes("FROM business_categories")
          ? "category"
          : sql.includes("FROM business_stores")
            ? "store"
            : sql.includes("FROM business_dimension_values")
              ? "value"
              : "dimension";
        return [{ retired: directory[kind] }];
      })
    };
    const input = {
      orgId: "org",
      categoryId: "business",
      targetId: "source",
      scopes: [
        {
          enterpriseKey: "enterprise",
          ownership: "store" as const,
          storeName: "Exact A ",
          dimensions: { project: "X" }
        }
      ]
    };
    return { directory, tx, input };
  }
  it("rejects ordinary selection of retired categories, exact stores, dimensions and values", async () => {
    for (const kind of ["category", "store", "dimension", "value"] as const) {
      const { directory, tx, input } = fixture();
      directory[kind] = true;
      await expect(requireCurrentDirectoryEligibility(tx as never, input)).rejects.toThrow(
        "RESOURCE_DIRECTORY_RETIRED"
      );
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    }
  });
  it("admits an explicit current-admin reason, records it, and rejects blank reason or future business dates", async () => {
    const { directory, tx, input } = fixture();
    directory.store = true;
    const historicalSupplement = {
      actorEmployeeId: "admin",
      reason: "Repair the historical August receipt"
    };
    await requireCurrentDirectoryEligibility(tx as never, {
      ...input,
      historicalSupplement,
      businessDates: ["20260819"]
    });
    expect(
      tx.$queryRaw.mock.calls.some(([query]) => query.strings.join("").includes("FROM employees"))
    ).toBe(true);
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorEmployeeId: "admin",
          metadata: expect.objectContaining({ historicalSupplement, businessDates: ["2026-08-19"] })
        })
      })
    );
    await expect(
      requireCurrentDirectoryEligibility(tx as never, {
        ...input,
        historicalSupplement: { ...historicalSupplement, reason: " " }
      })
    ).rejects.toThrow("RESOURCE_HISTORICAL_REASON_REQUIRED");
    await expect(
      requireCurrentDirectoryEligibility(tx as never, {
        ...input,
        historicalSupplement,
        businessDates: ["9999-01-01"]
      })
    ).rejects.toThrow("RESOURCE_HISTORICAL_DATE_INVALID");
    directory.adminActive = false;
    await expect(
      requireCurrentDirectoryEligibility(tx as never, { ...input, historicalSupplement })
    ).rejects.toThrow("AUTHORIZATION_ADMIN_REQUIRED");
    expect(directory.store).toBe(true);
  });
});
