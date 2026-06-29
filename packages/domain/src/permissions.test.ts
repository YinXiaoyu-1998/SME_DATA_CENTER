import { describe, expect, it } from "vitest";

import { canEmployeeAccessDocument } from "./permissions.js";

describe("canEmployeeAccessDocument", () => {
  it("allows an active employee to access a document with a matching store label", () => {
    const canAccess = canEmployeeAccessDocument({
      employee: {
        disabled: false,
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
        labelKeys: ["store:baoli"]
      },
      document: {
        labelKeys: ["all_staff"]
      }
    });

    expect(canAccess).toBe(false);
  });
});
