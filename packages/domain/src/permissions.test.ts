import { describe, expect, it } from "vitest";

import { canEmployeeAccessDocument } from "./permissions.js";

describe("canEmployeeAccessDocument", () => {
  it("applies the canonical document policy for disabled admins, admins, all_staff, matching, and non-matching labels", () => {
    const canAccess = (
      employee: {
        disabled: boolean;
        role: "admin" | "manager" | "employee";
        labelKeys: string[];
      },
      documentLabelKeys: string[]
    ) => canEmployeeAccessDocument({ employee, document: { labelKeys: documentLabelKeys } });

    expect(
      canAccess({ disabled: true, role: "admin", labelKeys: ["store:baoli"] }, ["store:baoli"])
    ).toBe(false);
    expect(canAccess({ disabled: false, role: "admin", labelKeys: [] }, ["store:baoli"])).toBe(
      true
    );
    expect(canAccess({ disabled: false, role: "employee", labelKeys: [] }, ["all_staff"])).toBe(
      true
    );
    expect(
      canAccess({ disabled: false, role: "employee", labelKeys: ["store:baoli"] }, ["store:baoli"])
    ).toBe(true);
    expect(
      canAccess({ disabled: false, role: "employee", labelKeys: ["store:baoli"] }, ["store:suzhou"])
    ).toBe(false);
  });

  it("allows an active employee to access a document with a matching store label", () => {
    const canAccess = canEmployeeAccessDocument({
      employee: {
        disabled: false,
        role: "employee",
        labelKeys: ["store:baoli"]
      },
      document: {
        labelKeys: ["store:baoli"]
      }
    });

    expect(canAccess).toBe(true);
  });

  it("allows any active employee to access an all_staff document", () => {
    const canAccess = canEmployeeAccessDocument({
      employee: {
        disabled: false,
        role: "employee",
        labelKeys: []
      },
      document: {
        labelKeys: ["all_staff"]
      }
    });

    expect(canAccess).toBe(true);
  });

  it("allows an active employee to access a document with a matching personal label", () => {
    const canAccess = canEmployeeAccessDocument({
      employee: {
        disabled: false,
        role: "employee",
        labelKeys: ["person:baoli.manager"]
      },
      document: {
        labelKeys: ["person:baoli.manager"]
      }
    });

    expect(canAccess).toBe(true);
  });

  it("denies an active employee when no document label matches", () => {
    const canAccess = canEmployeeAccessDocument({
      employee: {
        disabled: false,
        role: "employee",
        labelKeys: ["store:baoli"]
      },
      document: {
        labelKeys: ["store:suzhou"]
      }
    });

    expect(canAccess).toBe(false);
  });

  it("denies a disabled employee even when the document is all_staff", () => {
    const canAccess = canEmployeeAccessDocument({
      employee: {
        disabled: true,
        role: "employee",
        labelKeys: ["store:baoli"]
      },
      document: {
        labelKeys: ["all_staff"]
      }
    });

    expect(canAccess).toBe(false);
  });
});
