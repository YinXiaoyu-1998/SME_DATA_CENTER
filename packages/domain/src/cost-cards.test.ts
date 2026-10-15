import { describe, expect, test } from "vitest";
import * as domain from "./index.js";

function card() {
  const row = Object.fromEntries(
    domain.COST_CARD_UPLOAD_SCHEMA.map((f) => [
      f.canonicalName,
      f.nullable ? null : f.type === "boolean" ? false : "x"
    ])
  );
  Object.assign(row, {
    spu_id: "001",
    sku_id: "002",
    dish_name: "同名菜",
    recipe_type: "标准配方",
    recipe_name: "标准",
    item_code: "03",
    item_name: "盐",
    cost_unit: "克",
    sale_price: "99999999999999.123456",
    net_quantity: "0",
    yield_rate: "0.82"
  });
  return domain.costCardFromRows([row], {
    enterpriseKey: "enterprise",
    sourceNamespace: "meituan",
    spuId: "001",
    skuId: "002"
  });
}

describe("cost card business contracts", () => {
  test("exact decimal normalization preserves precision and explicit percentage meaning", () => {
    expect(domain.normalizeCostCardDecimal("99999999999999.123456")).toBe("99999999999999.123456");
    expect(domain.normalizeCostCardDecimal("82%", true)).toBe("0.82");
    expect(domain.normalizeCostCardDecimal("0.820000", true)).toBe("0.82");
    expect(domain.normalizeCostCardDecimal("82", true)).toBe("82");
    expect(domain.normalizeCostCardDecimal("-0.000000")).toBe("0");
    expect(() => domain.normalizeCostCardDecimal("1.1234567")).toThrow(/precision/);
    expect(() => domain.normalizeCostCardDecimal("100000000000000")).toThrow(/precision/);
  });
  test("fingerprint ignores row, source and store ordering but retains duplicate multiplicity", () => {
    const first = card();
    const recipe = first.recipes[0]!;
    recipe.recipe_type = "例外配方";
    recipe.source_stores_text = "乙店, 甲店";
    recipe.stores = ["乙店", "甲店"];
    recipe.items.push({ ...recipe.items[0]!, item_code: "04" });
    const second = structuredClone(first);
    second.recipes[0]!.stores.reverse();
    second.recipes[0]!.source_stores_text = "甲店；乙店";
    second.recipes[0]!.items.reverse();
    second.recipes[0]!.items[0]!.source = {
      sourceSheetIndex: 4,
      sourceSheetName: "new",
      sourceRowNumber: 91
    };
    second.card.sale_price = "99999999999999.1234560";
    expect(domain.hashCostCard(second)).toBe(domain.hashCostCard(first));
    second.recipes[0]!.items.push({ ...second.recipes[0]!.items[0]! });
    expect(domain.hashCostCard(second)).not.toBe(domain.hashCostCard(first));
  });
  test("null to zero, recipe fields, recipe removal and different SPU change the fingerprint", () => {
    const first = card();
    for (const mutate of [
      (c: typeof first) => {
        c.recipes[0]!.other_cost = "0";
      },
      (c: typeof first) => {
        c.recipes[0]!.remark = "新备注";
      },
      (c: typeof first) => {
        c.recipes = [];
      },
      (c: typeof first) => {
        c.identity.spuId = "other";
      }
    ]) {
      const next = structuredClone(first);
      mutate(next);
      expect(domain.hashCostCard(next)).not.toBe(domain.hashCostCard(first));
    }
  });
  test("upload schema is complete and directory capabilities exclude recipes and aggregates", () => {
    expect(domain.COST_CARD_UPLOAD_SCHEMA).toHaveLength(35);
    expect(
      domain.COST_CARD_DIRECTORY_REGISTRY.fields.some((f) => f.canonicalName === "net_quantity")
    ).toBe(false);
    expect(
      domain.COST_CARD_DIRECTORY_REGISTRY.fields.every(
        (f) => !f.capabilities.aggregate && !f.capabilities.group
      )
    ).toBe(true);
    expect(
      domain.resolveStructuredHeaders(
        "cost_cards",
        domain.COST_CARD_UPLOAD_SCHEMA.map((f) => f.sourceColumn)
      ).ok
    ).toBe(true);
    expect(
      domain.resolveStructuredHeaders("cost_cards", [
        ...domain.COST_CARD_UPLOAD_SCHEMA.map((f) => f.sourceColumn),
        "source_row_number"
      ]).ok
    ).toBe(false);
  });
});
