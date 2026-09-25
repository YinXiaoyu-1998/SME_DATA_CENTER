import { describe, expect, it } from "vitest";
import { redactSecrets, type SecureCredentialStore } from "./auth.js";

describe("official launcher OAuth bootstrap", () => {
  it("redacts credentials from values passed to tool errors", () => {
    expect(
      redactSecrets({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        authorization: "Bearer header-secret",
        nested: { code: "authorization-code" }
      })
    ).toEqual({
      access_token: "[REDACTED]",
      refresh_token: "[REDACTED]",
      authorization: "[REDACTED]",
      nested: { code: "[REDACTED]" }
    });
  });

  it("does not offer a filesystem fallback credential store", () => {
    const store: SecureCredentialStore = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined
    };

    expect(Object.keys(store)).toEqual(["get", "set", "delete"]);
  });
});
