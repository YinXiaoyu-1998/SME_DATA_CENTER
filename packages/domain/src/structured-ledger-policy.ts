import {
  getStructuredRegistry,
  type StructuredDatasetName,
  type StructuredDatasetRegistry
} from "./structured-registry.js";

/** Import and internal PDF readers use the full registry; public ledger reads remain closed. */
export function getPublicStructuredRegistry(
  dataset: StructuredDatasetName
): StructuredDatasetRegistry & { queryModes?: []; allowedAggregates?: [] } {
  const registry = getStructuredRegistry(dataset);
  return dataset === "delivery_ledger"
    ? {
        ...registry,
        rowTable: undefined,
        presentation: undefined,
        fields: [],
        queryModes: [],
        allowedAggregates: []
      }
    : registry;
}
