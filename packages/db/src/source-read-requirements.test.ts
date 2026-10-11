import { describe, expect, it, vi } from "vitest";
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
