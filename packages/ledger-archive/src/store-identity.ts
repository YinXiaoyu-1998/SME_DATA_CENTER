import { Prisma } from "@prisma/client";

export function ledgerStoreKeyFromMetadata(metadata: unknown): string | undefined {
  if (metadata && typeof metadata === "object" && "ledgerStoreKey" in metadata)
    return typeof metadata.ledgerStoreKey === "string" ? metadata.ledgerStoreKey : undefined;
}

// Receipt source documents carry the resolved immutable name. Existing receipts
// already used that name in the payload. Keep their PDFs and history addressable.
export const ledgerStoreKeySql = Prisma.sql`COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(d.source_metadata, '$.ledgerStoreKey')),
  JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.store_name'))
)`;
