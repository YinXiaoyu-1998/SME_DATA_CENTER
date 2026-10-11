import { canReadLedgerPdf, currentLedgerAuthorization } from "./pdf-authorization.js";
import { readLedgerSourceMetadata } from "./source-reader.js";
import { Prisma } from "@prisma/client";
import { ledgerStoreNameHash } from "./keys.js";
import { assertLedgerDate } from "./scope.js";
import type { LedgerPartitionKey } from "./types.js";

export async function lockLedgerSourceMutation(
  tx: Prisma.TransactionClient,
  orgId: string
): Promise<void> {
  const organizations = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`
  );
  if (!organizations.length) throw new Error("LEDGER_ORG_NOT_FOUND");
}

export function ledgerPartitionsFromRows(
  orgId: string,
  rows: { payload: Record<string, unknown> }[]
): LedgerPartitionKey[] {
  const keys = new Map<string, LedgerPartitionKey>();
  for (const { payload } of rows) {
    const storeName = payload["store_name"];
    const purchaseDate = payload["purchase_date"];
    if (typeof storeName !== "string" || !storeName || typeof purchaseDate !== "string")
      throw new Error("LEDGER_PARTITION_KEY_INVALID");
    assertLedgerDate(purchaseDate);
    keys.set(JSON.stringify([storeName, purchaseDate]), { orgId, storeName, purchaseDate });
  }
  return [...keys.values()];
}

/** Call only inside the same transaction that commits the source mutation. */
export async function markLedgerPartitionsChanged(
  tx: Prisma.TransactionClient,
  keys: LedgerPartitionKey[]
): Promise<void> {
  const unique = new Map(
    keys.map((key) => [JSON.stringify([key.orgId, key.storeName, key.purchaseDate]), key])
  );
  for (const key of [...unique.values()].sort((a, b) =>
    Buffer.compare(Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b)))
  )) {
    assertLedgerDate(key.purchaseDate);
    const identity = {
      orgId: key.orgId,
      storeNameHash: ledgerStoreNameHash(key.storeName),
      purchaseDate: new Date(`${key.purchaseDate}T00:00:00.000Z`)
    };
    const partition = await tx.ledgerPdfPartition.upsert({
      where: { orgId_storeNameHash_purchaseDate: identity },
      create: { ...identity, storeName: key.storeName, dataRevision: 1 },
      update: { dataRevision: { increment: 1 } }
    });
    if (partition.storeName !== key.storeName) throw new Error("LEDGER_STORE_HASH_COLLISION");
  }
}

export async function ledgerPartitionsForReceipt(
  tx: Prisma.TransactionClient,
  orgId: string,
  receiptId: string
): Promise<LedgerPartitionKey[]> {
  const rows = await tx.$queryRaw<{ storeName: string; purchaseDate: string }[]>(Prisma.sql`
    SELECT ANY_VALUE(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.store_name'))) AS storeName,
      JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.purchase_date')) AS purchaseDate
    FROM delivery_ledger_rows r JOIN documents d ON d.id = r.source_document_id AND d.org_id = r.org_id
      JOIN import_batches b ON b.id = r.import_batch_id AND b.org_id = r.org_id
    WHERE r.org_id = ${orgId} AND d.status = 'active' AND d.archived_at IS NULL
      AND b.status = 'applied' AND b.archived_at IS NULL
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.receipt_id')) AS BINARY) = CAST(${receiptId} AS BINARY)
    GROUP BY CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.store_name')) AS BINARY), JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.purchase_date'))
  `);
  return rows.map((row) => ({
    orgId,
    storeName: String(row.storeName),
    purchaseDate: row.purchaseDate
  }));
}

export async function ledgerPartitionsForDocument(
  tx: Prisma.TransactionClient,
  orgId: string,
  documentId: string
): Promise<LedgerPartitionKey[]> {
  const rows = await tx.deliveryLedgerRow.findMany({
    where: { orgId, sourceDocumentId: documentId },
    select: { payload: true }
  });
  const keys = ledgerPartitionsFromRows(
    orgId,
    rows.map((row) => ({ payload: row.payload as Record<string, unknown> }))
  );
  const certificate = await tx.quarantineCertificate.findFirst({
    where: { orgId, sourceDocumentId: documentId }
  });
  if (certificate)
    keys.push(...(await ledgerPartitionsForReceipt(tx, orgId, certificate.receiptId)));
  const published = await tx.ledgerPdfSource.findMany({
    where: { orgId, sourceDocumentId: documentId },
    include: { partition: true }
  });
  keys.push(
    ...published.map((source) => ({
      orgId,
      storeName: source.partition.storeName,
      purchaseDate: source.partition.purchaseDate.toISOString().slice(0, 10)
    }))
  );
  return [...new Map(keys.map((key) => [JSON.stringify(key), key])).values()];
}

/** Mutation hints never reveal a hidden ledger partition through a known receipt/photo. */
export async function readableLedgerPartitionHints(
  tx: Prisma.TransactionClient,
  employeeId: string,
  keys: LedgerPartitionKey[]
): Promise<LedgerPartitionKey[]> {
  if (!keys.length) return [];
  const snapshot = await currentLedgerAuthorization(tx, employeeId, keys[0]!.orgId);
  if (snapshot.disabled) return [];
  const visible: LedgerPartitionKey[] = [];
  for (const key of keys) {
    if (key.orgId !== snapshot.orgId) continue;
    const metadata = await readLedgerSourceMetadata(tx, key);
    if (metadata.rowCount && (await canReadLedgerPdf(tx, snapshot, key, metadata.sources)))
      visible.push(key);
  }
  return visible;
}
