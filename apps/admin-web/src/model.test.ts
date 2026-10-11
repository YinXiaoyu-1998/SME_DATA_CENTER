import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
async function model() {
  const module = await import("./model.js").catch(() => null);
  expect(module, "browser grant editor model must exist").not.toBeNull();
  return runInNewContext(`${module!.permissionModelSource}; model;`) as {
    replaceGrant(grants: unknown[], id: string, edit: unknown): unknown[];
    removeGrant(grants: unknown[], id: string): unknown[];
    changed(before: unknown, after: unknown): boolean;
  };
}
describe("browser permission drafts", () => {
  it("edits one complete grant tuple without dropping other or retired selections", async () => {
    const editor = await model();
    const grants = [
      {
        id: "one",
        orgId: "org_a",
        enterpriseKey: "业务企业",
        ownership: "store",
        categoryIds: ["business"],
        stores: { kind: "fixed", values: ["A店"] },
        dimensions: { project: { kind: "fixed", values: ["X"] } }
      },
      {
        id: "two",
        orgId: "org_a",
        enterpriseKey: "业务企业",
        ownership: "store",
        categoryIds: ["retired-category"],
        stores: { kind: "fixed", values: ["B店"] },
        dimensions: {
          project: { kind: "fixed", values: ["Y"] },
          "retired-dimension": { kind: "all" }
        }
      }
    ];
    const updated = editor.replaceGrant(grants, "one", { ...grants[0], stores: { kind: "all" } });
    expect(updated).toHaveLength(2);
    expect(updated[1]).toEqual(grants[1]);
    expect(updated[0]).toMatchObject({
      id: "one",
      stores: { kind: "all" },
      dimensions: { project: { kind: "fixed", values: ["X"] } }
    });
    expect(grants[0]!.stores.kind).toBe("fixed");
  });
  it("only removes the explicitly chosen grant and recognizes unchanged records", async () => {
    const editor = await model();
    const grants = [
      { id: "one", ownership: "group" },
      { id: "two", ownership: "store" }
    ];
    expect(editor.removeGrant(grants, "one")).toEqual([grants[1]]);
    expect(editor.changed({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(editor.changed(grants, editor.removeGrant(grants, "one"))).toBe(true);
  });
});
