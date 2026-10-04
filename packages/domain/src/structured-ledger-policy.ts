import {
  getStructuredRegistry,
  type StructuredDatasetName,
  type StructuredDatasetRegistry
} from "./structured-registry.js";

export const PUBLIC_LEDGER_SCOPE_FIELDS = new Set(["store_name", "purchase_date"]);
export const PUBLIC_LEDGER_AGGREGATES = [
  { op: "count" },
  { op: "countDistinct", field: "receipt_id" },
  { op: "sum", field: "purchase_amount" }
] as const;

/** Public discovery/compiler projection; import and internal readers keep the full registry. */
export function getPublicStructuredRegistry(
  dataset: StructuredDatasetName,
  ledgerPdfDeliveryEnabled = false
): StructuredDatasetRegistry & {
  queryModes?: ["aggregate"];
  allowedAggregates?: typeof PUBLIC_LEDGER_AGGREGATES;
} {
  const registry = getStructuredRegistry(dataset);
  if (!ledgerPdfDeliveryEnabled || dataset !== "delivery_ledger") return registry;

  const fieldsByName = new Map(registry.fields.map((field) => [field.canonicalName, field]));
  return {
    ...registry,
    presentation: undefined,
    queryModes: ["aggregate"],
    allowedAggregates: PUBLIC_LEDGER_AGGREGATES,
    fields: ["receipt_id", "store_name", "purchase_date", "purchase_amount"].map((name) => {
      const field = fieldsByName.get(name)!;
      const scopeField = PUBLIC_LEDGER_SCOPE_FIELDS.has(name);
      return {
        ...field,
        defaultReturn: false,
        operators: scopeField ? field.operators : [],
        capabilities: {
          filter: scopeField,
          sort: scopeField,
          group: scopeField,
          aggregate: !scopeField
        }
      };
    })
  };
}
