import { describe, expect, it } from "vitest";
import {
  compileCostCardQuery,
  compileCostCardSelection,
  parseCostCardSelection
} from "./cost-card-query.js";
import { createStructuredCursor } from "./structured-query.js";

const input = {
  orgId: "org",
  employee: { id: "employee", clearance: 2 },
  cursorSecret: "synthetic-secret",
  businessAuthorization: {
    version: "1",
    sql: "EXISTS (SELECT 1 WHERE ? = ?)",
    params: ["allowed", "allowed"]
  }
};
describe("cost card directory compiler", () => {
  it("compiles bounded directory-only SQL with literal case-sensitive names and precise decimals", () => {
    const result = compileCostCardQuery({
      ...input,
      query: {
        dataset: "cost_cards",
        select: ["cost_card_id", "dish_name", "sale_price", "revision"],
        filter: {
          and: [
            { field: "dish_name", op: "contains", value: "滩羊%_!肉锅" },
            { field: "sale_price", op: "gte", value: "99999999999999.123456" }
          ]
        },
        page: { limit: 2 }
      }
    });
    expect(result.sql).toContain("FROM cost_cards c");
    expect(result.sql).toContain("c.archived_at IS NULL");
    expect(result.sql).toContain("CAST(c.sale_price AS CHAR)");
    expect(result.sql).toContain("CAST(c.revision AS CHAR)");
    expect(result.sql).toContain("ESCAPE '!'");
    expect(result.sql).not.toMatch(/payload|JOIN documents/);
    expect(result.params).toContain("%滩羊!%!_!!肉锅%");
    expect(result.params).toContain("99999999999999.123456");
    expect(result.params.slice(-2)).toEqual([2, 0]);
  });
  it("rejects details, aggregates, numeric price filters and missing current authorization", () => {
    for (const query of [
      { dataset: "cost_cards", select: ["item_name"] },
      { dataset: "cost_cards", filter: { field: "recipe_name", op: "eq", value: "标准" } },
      { dataset: "cost_cards", aggregates: [{ op: "count" }] },
      { dataset: "cost_cards", filter: { field: "sale_price", op: "eq", value: 1 } },
      { dataset: "cost_cards", sql: "SELECT *" }
    ])
      expect(() => compileCostCardQuery({ ...input, query })).toThrow();
    expect(() =>
      compileCostCardQuery({
        ...input,
        businessAuthorization: undefined,
        query: { dataset: "cost_cards" }
      })
    ).toThrow();
  });
  it("binds cursors to employee, current permissions and the selected query", () => {
    const query = {
      dataset: "cost_cards",
      filter: { field: "sku_id", op: "in", value: ["001", "002"] },
      page: { limit: 1 }
    };
    const first = compileCostCardQuery({ ...input, query });
    const cursor = createStructuredCursor({
      offset: 1,
      shapeHash: first.shapeHash,
      secret: input.cursorSecret
    });
    expect(
      compileCostCardQuery({ ...input, query: { ...query, page: { limit: 1, cursor } } }).offset
    ).toBe(1);
    expect(() =>
      compileCostCardQuery({
        ...input,
        businessAuthorization: { ...input.businessAuthorization, version: "2" },
        query: { ...query, page: { limit: 1, cursor } }
      })
    ).toThrow();
  });
  it("uses AND across selector fields, OR within arrays, and rejects empty/unknown selection", () => {
    const selection = parseCostCardSelection({
      costCardIds: ["one", "two"],
      spuIds: ["01"],
      dishNameContains: "%_"
    });
    const result = compileCostCardSelection(selection);
    expect(result.sql).toContain("CAST(c.id AS BINARY) IN");
    expect(result.sql).toContain(" AND ");
    expect(result.params).toEqual(["one", "two", "01", "%!%!_%"]);
    for (const value of [
      { costCardIds: [] },
      { spuIds: [1] },
      { storeName: "甲" },
      { skuIds: Array(101).fill("x") }
    ])
      expect(() => parseCostCardSelection(value)).toThrow();
  });
});
