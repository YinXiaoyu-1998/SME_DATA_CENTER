import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_READ_ADAPTERS,
  inspectCutoverInventory,
  type CutoverInventory
} from "./business-authorization-cutover.js";
const fixed = [
  "business",
  "dishes",
  "vip",
  "dish_catalog",
  "supplier_catalog",
  "delivery_ledger",
  "quarantine_certificate",
  "ledger_pdf",
  "store_reviews",
  "cost_cards",
  "in_store_orders",
  "takeaway_orders"
];
function inventory(): CutoverInventory {
  return {
    categories: fixed.map((key) => ({
      id: key,
      key,
      kind: "fixed",
      confidentialityLevel: 2,
      ownerships: ["group"],
      requiredDimensionIds: []
    })),
    resources: [],
    documents: [],
    partitions: [],
    storeReviewEnterpriseKeys: [],
    storeReviews: [],
    costCards: [],
    pdfs: [],
    accounts: [{ id: "new", grants: [] }],
    stores: [],
    dimensions: []
  };
}
describe("tenant authorization preparation", () => {
  it("recognizes independent cost-card resources and their group identity/lifecycle", () => {
    const data = inventory();
    data.costCards = [{ id: "card", enterpriseKey: "enterprise", archived: false }];
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).missing).toContainEqual({
      code: "COST_CARD_ATTRIBUTES_REQUIRED",
      targetId: "card"
    });
    data.resources.push({
      id: "resource",
      kind: "cost_card",
      resourceKey: "cost-card:card",
      documentId: null,
      sourceDocumentId: null,
      requirement: {
        orgId: "tenant",
        categoryId: "cost_cards",
        valid: true,
        scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }]
      }
    });
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).ready).toBe(true);
    data.costCards[0]!.archived = true;
    data.resources[0]!.requirement.valid = false;
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).ready).toBe(true);
    data.resources[0]!.kind = "structured";
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).missing).toContainEqual({
      code: "COST_CARD_ATTRIBUTES_REQUIRED",
      targetId: "card"
    });
  });
  it("is read-only, does not invent grants or category clearance and requires every compiled read adapter", () => {
    const data = inventory();
    const original = structuredClone(data);
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS)).toMatchObject({
      ready: true,
      accountsWithoutGrants: ["new"]
    });
    expect(data).toEqual(original);
    data.categories[0]!.confidentialityLevel = null;
    const result = inspectCutoverInventory(data, []);
    expect(result.ready).toBe(false);
    expect(result.missing).toContainEqual({
      code: "FIXED_CATEGORY_CLEARANCE_REQUIRED",
      targetId: "business"
    });
    expect(result.missing.filter((i) => i.code === "READ_ADAPTER_NOT_READY")).toHaveLength(
      AUTHORIZATION_READ_ADAPTERS.length
    );
  });
  it("activates with an unset internal ledger level but still requires the PDF level and internal category identity", () => {
    const data = inventory();
    const ledger = data.categories.find((category) => category.key === "delivery_ledger")!;
    ledger.confidentialityLevel = null;
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).ready).toBe(true);
    expect(ledger.confidentialityLevel).toBeNull();

    const pdf = data.categories.find((category) => category.key === "ledger_pdf")!;
    pdf.confidentialityLevel = null;
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).missing).toContainEqual({
      code: "FIXED_CATEGORY_CLEARANCE_REQUIRED",
      targetId: "ledger_pdf"
    });
    pdf.confidentialityLevel = 2;
    data.categories = data.categories.filter((category) => category.key !== "delivery_ledger");
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS)).toMatchObject({
      ready: false,
      missing: [{ code: "INTERNAL_CATEGORY_REQUIRED", targetId: "delivery_ledger" }]
    });
  });
  it("inspects a tenant-sized inventory within the activation transaction budget", () => {
    const data = inventory();
    data.categories.find((category) => category.key === "business")!.ownerships = ["store"];
    data.stores = [{ enterpriseKey: "enterprise", name: "A " }];
    for (let i = 0; i < 14000; i++) {
      data.partitions.push(`p${i}`);
      data.resources.push({
        id: `r${i}`,
        kind: "structured",
        resourceKey: `partition:p${i}`,
        documentId: null,
        sourceDocumentId: null,
        requirement: {
          orgId: "tenant",
          categoryId: "business",
          valid: true,
          scopes: [
            { enterpriseKey: "enterprise", ownership: "store", storeName: "A ", dimensions: {} }
          ]
        }
      });
    }
    for (let i = 0; i < 5000; i++) {
      data.documents.push({ id: `d${i}`, kind: "structured", dataset: "business" });
      data.resources.push({
        id: `s${i}`,
        kind: "source_fragment",
        resourceKey: `source:${i}`,
        documentId: null,
        sourceDocumentId: `d${i}`,
        requirement: {
          orgId: "tenant",
          categoryId: "business",
          valid: true,
          scopes: [
            { enterpriseKey: "enterprise", ownership: "store", storeName: "A ", dimensions: {} }
          ]
        }
      });
    }
    const started = performance.now();
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).ready).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
    // Exact store names still matter after indexing.
    data.stores[0]!.name = "A";
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).missing).toContainEqual({
      code: "EXACT_STORE_REFERENCE_REQUIRED",
      targetId: "r0"
    });
  }, 60000);
  it("reports old documents, missing original lineage, partitions and PDFs instead of inferring attributes", () => {
    const data = inventory();
    data.documents = [
      { id: "memo", kind: "evidence", dataset: null },
      { id: "original", kind: "structured", dataset: "vip" }
    ];
    data.partitions = ["partition"];
    data.pdfs = ["pdf"];
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).missing).toEqual(
      expect.arrayContaining([
        { code: "DOCUMENT_ATTRIBUTES_REQUIRED", targetId: "memo" },
        { code: "SOURCE_LINEAGE_REQUIRED", targetId: "original" },
        { code: "PARTITION_ATTRIBUTES_REQUIRED", targetId: "partition" },
        { code: "PDF_ATTRIBUTES_REQUIRED", targetId: "pdf" }
      ])
    );
  });
  it("requires complete new dimensions on both resources and grants with exact store references", () => {
    const data = inventory();
    data.categories[0]!.ownerships = ["store"];
    data.categories[0]!.requiredDimensionIds = ["project"];
    data.dimensions = [{ id: "project", valueIds: ["X"] }];
    data.stores = [{ enterpriseKey: "enterprise", name: "Store A" }];
    data.resources = [
      {
        id: "resource",
        kind: "structured",
        resourceKey: "partition:p",
        documentId: null,
        sourceDocumentId: null,
        requirement: {
          orgId: "tenant",
          categoryId: "business",
          valid: true,
          scopes: [
            {
              enterpriseKey: "enterprise",
              ownership: "store",
              storeName: "store a",
              dimensions: {}
            }
          ]
        }
      }
    ];
    data.accounts[0]!.grants = [
      {
        id: "g",
        orgId: "tenant",
        enterpriseKey: "enterprise",
        categoryIds: ["business"],
        ownership: "store",
        stores: { kind: "all" },
        dimensions: {}
      }
    ];
    const result = inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS);
    expect(result.ready).toBe(false);
    expect(result.missing).toContainEqual({
      code: "RESOURCE_ATTRIBUTES_REQUIRED",
      targetId: "resource"
    });
    expect(result.missing).toContainEqual({
      code: "EXACT_STORE_REFERENCE_REQUIRED",
      targetId: "resource"
    });
    expect(result.missing).toContainEqual({
      code: "GRANT_CONFIGURATION_REQUIRED",
      targetId: "new/g"
    });
  });
  it("rejects a photo attributed to an unrelated category even when its scope is complete", () => {
    const data = inventory();
    data.categories[0]!.ownerships = ["store"];
    data.stores = [{ enterpriseKey: "enterprise", name: "A" }];
    data.documents = [{ id: "photo", kind: "quarantine_certificate", dataset: null }];
    data.resources = [
      {
        id: "r",
        kind: "quarantine_certificate",
        documentId: "photo",
        sourceDocumentId: null,
        resourceKey: "photo",
        requirement: {
          orgId: "tenant",
          categoryId: "business",
          valid: true,
          scopes: [
            { enterpriseKey: "enterprise", ownership: "store", storeName: "A", dimensions: {} }
          ]
        }
      }
    ];
    expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).ready).toBe(false);
  });
});

it("checks review resources against exact single-store enterprise identity", () => {
  const data = inventory();
  data.categories.find((c) => c.key === "store_reviews")!.ownerships = ["store"];
  data.stores = [{ enterpriseKey: "enterprise", name: "A" }];
  data.storeReviewEnterpriseKeys = ["enterprise"];
  data.storeReviews = [{ id: "review", enterpriseKey: "enterprise", storeName: "A" }];
  expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).missing).toContainEqual({
    code: "STORE_REVIEW_ATTRIBUTES_REQUIRED",
    targetId: "review"
  });
  data.resources.push({
    id: "review",
    kind: "store_review",
    resourceKey: "store-review:review",
    documentId: null,
    sourceDocumentId: null,
    requirement: {
      orgId: "tenant",
      categoryId: "store_reviews",
      valid: true,
      scopes: [{ enterpriseKey: "enterprise", ownership: "store", storeName: "A", dimensions: {} }]
    }
  });
  expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).ready).toBe(true);
  data.storeReviews[0]!.enterpriseKey = "other";
  expect(inspectCutoverInventory(data, AUTHORIZATION_READ_ADAPTERS).missing).toContainEqual({
    code: "STORE_REVIEW_ATTRIBUTES_REQUIRED",
    targetId: "review"
  });
});
