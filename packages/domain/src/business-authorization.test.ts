import { describe, expect, it } from "vitest";
import {
  canReadResource,
  validateBusinessGrant,
  type AuthorizationSnapshot,
  type BusinessGrant,
  type ResourceReadRequirement
} from "./business-authorization.js";

const fixed = (...values: string[]) => ({ kind: "fixed" as const, values });
const all = { kind: "all" as const };
const grant = (overrides: Partial<BusinessGrant> = {}): BusinessGrant => ({
  id: "grant",
  orgId: "org",
  enterpriseKey: "enterprise",
  categoryIds: ["sales"],
  ownership: "store",
  stores: fixed("A"),
  dimensions: { project: fixed("X") },
  ...overrides
});
const snapshot = (grants = [grant()]): AuthorizationSnapshot => ({
  orgId: "org",
  employeeId: "employee",
  role: "admin",
  disabled: false,
  clearance: 2,
  mode: "enabled",
  authorizationVersion: "1",
  categories: [
    {
      id: "sales",
      kind: "fixed",
      confidentialityLevel: 2,
      ownerships: ["store"],
      requiredDimensionIds: ["project"]
    },
    {
      id: "vip",
      kind: "fixed",
      confidentialityLevel: 1,
      ownerships: ["group"],
      requiredDimensionIds: []
    },
    {
      id: "memo",
      kind: "evidence",
      confidentialityLevel: null,
      ownerships: ["group", "store"],
      requiredDimensionIds: ["project"]
    }
  ],
  grants
});
const resource = (overrides: Partial<ResourceReadRequirement> = {}): ResourceReadRequirement => ({
  orgId: "org",
  categoryId: "sales",
  valid: true,
  scopes: [
    {
      enterpriseKey: "enterprise",
      ownership: "store",
      storeName: "A",
      dimensions: { project: "X" }
    }
  ],
  ...overrides
});
const allowed = (s = snapshot(), r = resource()) => canReadResource(s, r).allowed;

describe("business authorization", () => {
  it("requires_one_complete_grant_per_scope_item", () => {
    const splitCategoryAndScope = snapshot([
      grant({ categoryIds: ["memo"] }),
      grant({ id: "other", stores: fixed("B") })
    ]);
    for (const entry of splitCategoryAndScope.grants)
      expect(validateBusinessGrant(entry, splitCategoryAndScope.categories)).toEqual([]);
    expect(allowed(splitCategoryAndScope)).toBe(false);
    const s = snapshot([
      grant(),
      grant({ id: "two", stores: fixed("B"), dimensions: { project: fixed("Y") } })
    ]);
    expect(
      allowed(
        s,
        resource({
          scopes: [
            ...resource().scopes,
            {
              enterpriseKey: "enterprise",
              ownership: "store",
              storeName: "B",
              dimensions: { project: "Y" }
            }
          ]
        })
      )
    ).toBe(true);
    expect(
      allowed(s, resource({ scopes: [{ ...resource().scopes[0]!, dimensions: { project: "Y" } }] }))
    ).toBe(false);
  });
  it("fails closed for account, organization, clearance, validity and missing configuration", () => {
    expect(allowed()).toBe(true);
    for (const s of [
      snapshot([]),
      { ...snapshot(), disabled: true },
      { ...snapshot(), clearance: 1 },
      { ...snapshot(), orgId: "other" },
      { ...snapshot(), mode: "preparing" as const },
      { ...snapshot(), categories: [] }
    ])
      expect(allowed(s)).toBe(false);
    for (const r of [
      resource({ valid: false }),
      resource({ orgId: "other" }),
      resource({ scopes: [] }),
      resource({ categoryId: "new" })
    ])
      expect(allowed(snapshot(), r)).toBe(false);
    const s = snapshot();
    s.categories[0]!.confidentialityLevel = null;
    expect(allowed(s)).toBe(false);
  });
  it("uses group membership without store requirements and explicit evidence clearance", () => {
    expect(
      allowed(
        snapshot([
          grant({ categoryIds: ["vip"], ownership: "group", stores: undefined, dimensions: {} })
        ]),
        resource({
          categoryId: "vip",
          scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }]
        })
      )
    ).toBe(true);
    const s = snapshot([grant({ categoryIds: ["memo"], ownership: "group", stores: undefined })]);
    const r = resource({
      categoryId: "memo",
      scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: { project: "X" } }]
    });
    expect(allowed(s, r)).toBe(false);
    expect(allowed(s, { ...r, fileConfidentialityLevel: 1 })).toBe(true);
    expect(allowed(s, { ...r, fileConfidentialityLevel: 3 })).toBe(false);
  });
  it("dynamic all includes future and retired values but never new categories, ownerships or dimensions", () => {
    const r = resource({
      scopes: [
        {
          enterpriseKey: "enterprise",
          ownership: "store",
          storeName: "Retired",
          dimensions: { project: "Future" }
        }
      ]
    });
    expect(allowed(snapshot(), r)).toBe(false);
    const s = snapshot([grant({ stores: all, dimensions: { project: all } })]);
    expect(allowed(s, r)).toBe(true);
    expect(allowed(s, resource({ categoryId: "new" }))).toBe(false);
    s.categories[0]!.requiredDimensionIds.push("new-dimension");
    expect(allowed(s, r)).toBe(false);
  });
  it("rejects empty stores, extra conditions, and distinguishes exact names and enterprises", () => {
    for (const name of ["", "a", "A ", "陆家嘴店", "陆家嘴一店"])
      expect(
        allowed(snapshot(), resource({ scopes: [{ ...resource().scopes[0]!, storeName: name }] }))
      ).toBe(false);
    expect(
      allowed(
        snapshot(),
        resource({ scopes: [{ ...resource().scopes[0]!, enterpriseKey: "Enterprise" }] })
      )
    ).toBe(false);
    expect(
      validateBusinessGrant(
        grant({ dimensions: { project: all, unexpected: all } }),
        snapshot().categories
      )
    ).not.toEqual([]);
    expect(validateBusinessGrant(grant(), snapshot().categories)).toEqual([]);
  });
});
