import { describe, expect, it } from "vitest";
import { cachedUserProfileSchema, parseCurrentUserProfileResponse } from "./user-profile.js";

const adminProfile = {
  displayName: "Admin",
  email: "admin@example.invalid",
  role: "admin",
  clearance: 0,
  organizationName: "Example Org"
};

describe("launcher cached user profile", () => {
  it("selects exactly the five public fields from the live employee envelope", () => {
    const profile = parseCurrentUserProfileResponse({
      employee: { id: "emp_internal", orgId: "org_internal", disabled: false, ...adminProfile }
    });

    expect(profile).toEqual(adminProfile);
    expect(JSON.stringify(profile)).not.toMatch(/"(?:id|orgId|disabled)":/);
    expect(
      parseCurrentUserProfileResponse({
        employee: { ...adminProfile, role: "employee", clearance: 3 }
      })
    ).toEqual({
      ...adminProfile,
      role: "employee",
      clearance: 3
    });
  });

  it.each([
    ["displayName", ""],
    ["displayName", "  "],
    ["email", "\t"],
    ["organizationName", "\n"],
    ["role", "owner"],
    ["clearance", -1],
    ["clearance", 4],
    ["clearance", 1.5],
    ["clearance", "0"]
  ])("rejects an invalid %s value of %j", (field, value) => {
    expect(() =>
      parseCurrentUserProfileResponse({ employee: { ...adminProfile, [field]: value } })
    ).toThrow();
  });

  it.each(Object.keys(adminProfile))("requires the %s field", (field) => {
    const incomplete: Record<string, unknown> = { ...adminProfile };
    delete incomplete[field];
    expect(() => parseCurrentUserProfileResponse({ employee: incomplete })).toThrow();
  });

  it.each([null, [], "invalid", {}, { employee: null }, { employee: [] }, adminProfile])(
    "rejects a malformed response %j",
    (value) => {
      expect(() => parseCurrentUserProfileResponse(value)).toThrow();
    }
  );

  it("rejects extra properties in persisted profiles", () => {
    expect(cachedUserProfileSchema.parse(adminProfile)).toEqual(adminProfile);
    expect(() => cachedUserProfileSchema.parse({ ...adminProfile, id: "internal" })).toThrow();
  });
});
