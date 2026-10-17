import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { permissionsCopy } from "./copy.js";

describe("permissions browser script and localization", () => {
  it("ships executable same-origin UI code with complete bilingual messages", async () => {
    const module = await import("./client.js").catch(() => null);
    expect(module, "interactive permissions UI must exist").not.toBeNull();
    expect(() => new Script(module!.permissionsClientSource)).not.toThrow();
    for (const key of module!.permissionsClientSource.matchAll(
      /(?:text|pair|button|field|heading|status|confirmDialog)\("([A-Za-z_]+)"/g
    )) {
      expect(permissionsCopy, `missing bilingual key ${key[1]}`).toHaveProperty(key[1]!);
    }
    expect(permissionsCopy.store_reviews).toEqual({ zh: "店铺评价", en: "Store reviews" });
    for (const [key, value] of Object.entries(permissionsCopy)) {
      expect(value.zh.trim(), key).not.toBe("");
      expect(value.en.trim(), key).not.toBe("");
    }
    expect(module!.permissionsClientSource).not.toContain("localStorage");
    expect(module!.permissionsClientSource).not.toContain("innerHTML");
  });
});
