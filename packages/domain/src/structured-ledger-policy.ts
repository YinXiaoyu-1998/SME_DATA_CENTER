import {
  getStructuredRegistry,
  type StructuredDatasetName,
  type StructuredDatasetRegistry
} from "./structured-registry.js";
import { COST_CARD_DIRECTORY_REGISTRY } from "./cost-cards.js";

/** Import and internal PDF readers use the full registry; public ledger reads remain closed. */
export function getPublicStructuredRegistry(
  dataset: StructuredDatasetName
): StructuredDatasetRegistry & { queryModes?: Array<"detail">; allowedAggregates?: [] } {
  const registry = getStructuredRegistry(dataset);
  if (dataset === "cost_cards")
    return {
      ...registry,
      fields: [...COST_CARD_DIRECTORY_REGISTRY.fields],
      queryModes: ["detail"],
      allowedAggregates: []
    };
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
