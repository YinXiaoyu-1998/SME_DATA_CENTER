import { describe, expect, it } from "vitest";
import { ComboAttribution, type CatalogItem } from "./combo-attribution.js";

function item(sku: string, name: string, spec: string, department: string | null): CatalogItem {
  return {
    sku,
    spu: sku,
    name,
    spec,
    departmentId: department,
    departmentName: department,
    isCombo: false,
    children: []
  };
}
const catalog = [
  item("b1", "Steamed roll", "small", "bakery"),
  item("b2", "Steamed roll", "large", "bakery"),
  item("d1", "Online roll", "bottle", "drinks")
];
const sale = {
  store: "East",
  parentCode: "set",
  parentName: "Lunch",
  name: "Online roll",
  spec: "large"
};

describe("current department attribution for combo sales", () => {
  it("prefers the authorized same-store linked name and uses the reported specification", () => {
    const reader = new ComboAttribution(catalog);
    reader.addEvidence("East", "Online roll", "Steamed roll", "单品");
    expect(reader.resolve(sale)).toMatchObject({
      status: "sku",
      sku: "b2",
      departmentId: "bakery",
      candidates: ["b2"],
      matchedNames: ["Steamed roll"],
      nameBasis: "linked"
    });
    expect(reader.resolve({ ...sale, store: "West" })).toMatchObject({ sku: "d1" });
  });
});

it("keeps all SKU candidates and attributes only a department common to every candidate", () => {
  const loose = { ...sale, name: "Steamed roll", spec: null };
  expect(new ComboAttribution(catalog).resolve(loose)).toMatchObject({
    status: "department",
    sku: null,
    departmentId: "bakery",
    candidates: ["b1", "b2"]
  });
  expect(
    new ComboAttribution([...catalog, item("b3", "Steamed roll", "medium", null)]).resolve(loose)
  ).toMatchObject({ status: "unresolved", departmentId: null, reason: "department_missing" });
  expect(new ComboAttribution(catalog).resolve({ ...loose, name: "Unlisted" })).toMatchObject({
    status: "unresolved",
    reason: "no_catalog_match",
    candidates: []
  });
});

it("uses uniquely identified parent composition and preserves conflicts as unresolved", () => {
  const parent = { ...item("p", "Lunch", "", null), spu: "set", isCombo: true, children: ["b2"] };
  const reader = new ComboAttribution([...catalog, parent]);
  expect(reader.resolve({ ...sale, name: "Steamed roll", spec: null })).toMatchObject({
    status: "sku",
    sku: "b2",
    parentSku: "p"
  });
  expect(reader.resolve({ ...sale, name: "Steamed roll", spec: "small" })).toMatchObject({
    status: "unresolved",
    reason: "composition_spec_conflict"
  });
});

it("uses a store confirmation, prefers an exact specification and keeps invalid targets unresolved", () => {
  const reader = new ComboAttribution(catalog);
  const confirmed = {
    id: "map-1",
    sourceName: sale.name,
    specification: null,
    target: { kind: "department" as const, departmentId: "service" },
    basis: "operator",
    valid: true,
    departmentId: "service",
    departmentName: "Service"
  };
  reader.addMapping("East", confirmed);
  expect(reader.resolve(sale)).toMatchObject({
    status: "department",
    departmentId: "service",
    sku: null,
    mappingId: "map-1"
  });
  reader.addMapping("East", { ...confirmed, id: "map-2", specification: "large", valid: false });
  expect(reader.resolve(sale)).toMatchObject({
    status: "unresolved",
    reason: "mapping_target_invalid",
    departmentId: null
  });
  expect(reader.resolve({ ...sale, store: "West" })).toMatchObject({ sku: "d1" });
});
