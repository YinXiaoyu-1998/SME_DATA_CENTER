import { describe, expect, it } from "vitest";

import { canEmployeeAccessDocument } from "./permissions.js";
import { canEmployeeUploadFiles } from "./index.js";

describe("canEmployeeUploadFiles", () => {
  it("allows only active admins, independently of read clearance", () => {
    expect(canEmployeeUploadFiles({ role: "admin", disabled: false })).toBe(true);
    expect(canEmployeeUploadFiles({ role: "employee", disabled: false })).toBe(false);
    expect(canEmployeeUploadFiles({ role: "admin", disabled: true })).toBe(false);
  });
});

describe("canEmployeeAccessDocument", () => {
  it("allows an active employee whose clearance reaches the document level", () => {
    const canAccess = (
      employee: {
        disabled: boolean;
        clearance: number;
      },
      confidentialityLevel: number
    ) => canEmployeeAccessDocument({ employee, document: { confidentialityLevel } });

    expect(canAccess({ disabled: false, clearance: 0 }, 0)).toBe(true);
    expect(canAccess({ disabled: false, clearance: 3 }, 3)).toBe(true);
  });

  it("denies a document above the employee clearance regardless of role outside this helper", () => {
    const canAccess = canEmployeeAccessDocument({
      employee: {
        disabled: false,
        clearance: 1
      },
      document: {
        confidentialityLevel: 2
      }
    });

    expect(canAccess).toBe(false);
  });

  it("denies a disabled employee even with sufficient clearance", () => {
    const canAccess = canEmployeeAccessDocument({
      employee: {
        disabled: true,
        clearance: 3
      },
      document: {
        confidentialityLevel: 0
      }
    });

    expect(canAccess).toBe(false);
  });
});
