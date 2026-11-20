// Each instance belongs to one authorized enterprise and one evidence selection.
export interface CatalogItem {
  sku: string;
  spu: string;
  name: string;
  spec: string | null;
  departmentId: string | null;
  departmentName: string | null;
  isCombo: boolean | null;
  children: string[];
}
export interface ComboSaleItem {
  store: string;
  parentCode: string;
  parentName: string;
  name: string;
  spec: string | null;
}

export interface StoreMapping {
  id: string;
  sourceName: string;
  specification: string | null;
  target: { kind: "sku"; skuId: string } | { kind: "department"; departmentId: string };
  basis: string;
  valid: boolean;
  departmentId: string | null;
  departmentName: string | null;
}

function indexValue<T>(index: Map<string, Set<T>>, key: string, value: T) {
  const values = index.get(key);
  if (values) values.add(value);
  else index.set(key, new Set([value]));
}

export class ComboAttribution {
  private readonly byName = new Map<string, Set<CatalogItem>>();
  private readonly evidence = new Map<string, Set<string>>();

  private readonly mappings = new Map<string, StoreMapping>();
  addMapping(store: string, mapping: StoreMapping) {
    const key = JSON.stringify([store, mapping.sourceName, mapping.specification]);
    if (this.mappings.has(key))
      throw new Error("Duplicate mapping identity in authorized selection.");
    this.mappings.set(key, mapping);
  }

  private readonly parentsBySpu = new Map<string, Set<CatalogItem>>();

  constructor(catalog: Iterable<CatalogItem>) {
    for (const item of catalog) {
      indexValue(this.byName, item.name, item);
      if (item.isCombo) indexValue(this.parentsBySpu, item.spu, item);
    }
  }

  addEvidence(store: string, name: string, linked: string, method: string) {
    if (linked && linked !== "--" && name) {
      indexValue(this.evidence, JSON.stringify([store, method, name]), linked);
    }
  }

  private namedCandidates(store: string, name: string, parent: boolean) {
    const links = [
      ...(this.evidence.get(JSON.stringify([store, parent ? "套餐" : "单品", name])) ?? [])
    ].sort();
    const find = (key: string) =>
      [...(this.byName.get(key) ?? [])].filter((item) => Boolean(item.isCombo) === parent);
    const linked = links.filter((key) => find(key).length);
    const names = linked.length ? linked : [name];
    const items = [...new Set(names.flatMap(find))];
    return { items, names, links, basis: linked.length ? "linked" : "original" };
  }

  resolve(sale: ComboSaleItem) {
    const child = this.namedCandidates(sale.store, sale.name, false);
    const namedParents = this.namedCandidates(sale.store, sale.parentName, true).items;
    const coded = [...(this.parentsBySpu.get(sale.parentCode) ?? [])];
    // Source item codes can coincide with unrelated catalog SPUs. Require name evidence.
    const parents = coded.length ? namedParents.filter((p) => coded.includes(p)) : namedParents;
    const parent = parents.length === 1 ? parents[0] : undefined;
    const parentConflict = Boolean(coded.length && namedParents.length && !parents.length);
    const fromGroup = parent?.children.length
      ? child.items.filter((item) => parent.children.includes(item.sku))
      : child.items;
    const spec = sale.spec && sale.spec !== "--" ? sale.spec : null;
    const exact = spec ? child.items.filter((item) => item.spec === spec) : [];
    // Some exports append an approximate serving weight to an otherwise exact catalog specification.
    const baseSpec = spec?.replace(/（约\d+(?:\.\d+)?克）$/u, "");
    const normalized =
      !exact.length && baseSpec && baseSpec !== spec
        ? child.items.filter((item) => item.spec === baseSpec)
        : [];
    const specMatches = exact.length ? exact : normalized;
    const intersection = specMatches.length
      ? fromGroup.filter((item) => specMatches.includes(item))
      : fromGroup;
    const conflict = parentConflict
      ? "parent_identity_conflict"
      : child.items.length && !fromGroup.length
        ? "composition_conflict"
        : fromGroup.length && !intersection.length
          ? "composition_spec_conflict"
          : null;
    const items = conflict ? child.items : intersection;
    const first = items[0];
    const deps = new Set(items.map((item) => item.departmentId));
    const reason =
      conflict ??
      (!first
        ? "no_catalog_match"
        : deps.has(null)
          ? "department_missing"
          : deps.size > 1
            ? "multiple_departments"
            : null);
    const automatic = {
      status: reason ? "unresolved" : items.length === 1 ? "sku" : "department",
      reason,
      sku: !conflict && items.length === 1 ? first!.sku : null,
      departmentId: reason ? null : first!.departmentId,
      departmentName: reason ? null : first!.departmentName,
      candidates: items.map((item) => item.sku).sort(),
      matchedNames: child.items.length ? child.names : [],
      linkedNames: child.links,
      nameBasis: child.basis,
      parentSku: parent?.sku ?? null,
      parentCandidates: parents.map((item) => item.sku).sort(),
      specEvidence: !spec
        ? "not_provided"
        : exact.length
          ? "exact"
          : normalized.length
            ? "weight_annotation"
            : "text_differs"
    };
    const exactSpec = sale.spec === "--" || sale.spec === null ? "" : sale.spec;
    const mapping =
      this.mappings.get(JSON.stringify([sale.store, sale.name, exactSpec])) ??
      this.mappings.get(JSON.stringify([sale.store, sale.name, null]));
    if (!mapping) return { ...automatic, mappingId: null, mappingBasis: null };
    const sku = mapping.valid && mapping.target.kind === "sku" ? mapping.target.skuId : null;
    const mappedReason = !mapping.valid
      ? "mapping_target_invalid"
      : !mapping.departmentId
        ? "department_missing"
        : null;
    return {
      ...automatic,
      nameBasis: "confirmed",
      mappingId: mapping.id,
      mappingBasis: mapping.basis,
      status: mappedReason ? "unresolved" : sku ? "sku" : "department",
      reason: mappedReason,
      sku,
      departmentId: mapping.valid ? mapping.departmentId : null,
      departmentName: mapping.valid ? mapping.departmentName : null,
      candidates: sku ? [sku] : []
    };
  }
}
