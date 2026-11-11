import { describe, expect, it } from "vitest";
import type { AuthorizationSnapshot } from "@smedc/domain";
import { compileStructuredReadScope } from "./business-authorization-sql.js";

function snapshot(overrides: Partial<AuthorizationSnapshot> = {}): AuthorizationSnapshot {
  return {
    orgId: "org_1",
    userAccountId: "user_1",
    role: "employee",
    disabled: false,
    clearance: 3,
    mode: "enabled",
    authorizationVersion: "1",
    categories: [
      {
        id: "catalog",
        key: "dish_catalog",
        kind: "fixed",
        confidentialityLevel: 2,
        ownerships: ["group"],
        requiredDimensionIds: []
      }
    ],
    grants: [
      {
        id: "grant_1",
        orgId: "org_1",
        enterpriseKey: "enterprise-a",
        categoryIds: ["catalog"],
        ownership: "group",
        dimensions: {}
      }
    ],
    ...overrides
  };
}

describe("catalog structured read authorization", () => {
  it("anchors catalog rows to the per-enterprise structured resource and reuses scope/grant predicates", () => {
    const compiled = compileStructuredReadScope(snapshot(), "catalog", "dish_catalog");

    expect(compiled.sql).toContain("ar.kind = 'structured'");
    expect(compiled.sql).toContain("ar.org_id = r.org_id");
    expect(compiled.sql).toContain("CONCAT('dish-catalog:', r.enterprise_key)");
    expect(compiled.sql).toContain("ar.valid = 1");
    expect(compiled.sql).toContain("business_resource_scopes");
    expect(compiled.sql).toContain("s.ownership = 'group'");
    expect(compiled.sql).not.toMatch(/\bv\./);
    expect(compiled.params[0]).toBe("dish_catalog");
  });

  it.each([
    ["disabled account", { disabled: true }],
    ["not enabled", { mode: "legacy" as const }],
    ["suspended", { mode: "suspended" as const }],
    ["missing category clearance", { categories: [] }],
    ["grant for another category", { grants: [] }]
  ])("fails closed for %s", (_label, overrides) => {
    const compiled = compileStructuredReadScope(
      snapshot(overrides as Partial<AuthorizationSnapshot>),
      "catalog",
      "dish_catalog"
    );

    // The catalog correlation stays registered, but the reused scope predicate is unsatisfiable.
    expect(compiled.sql).toContain("(0 = 1)");
    expect(compiled.sql).toContain("ar.kind = 'structured'");
    expect(compiled.sql).toContain("CONCAT('dish-catalog:', r.enterprise_key)");
  });

  it("rejects catalog correlation for another dataset or an unregistered target", () => {
    expect(() => compileStructuredReadScope(snapshot(), "catalog", "dishes")).toThrow(
      "UNKNOWN_AUTHORIZATION_TARGET"
    );
    expect(() =>
      compileStructuredReadScope(snapshot(), "arbitrary" as "catalog", "dish_catalog")
    ).toThrow("UNKNOWN_AUTHORIZATION_TARGET");
  });
});
