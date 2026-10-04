import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ledgerStoreNameHash } from "./keys.js";
import { assertLedgerDate } from "./scope.js";
import {
  findReadableCurrentSupplierCatalog,
  findSupplierCatalogMatches,
  nullableValue
} from "./supplier-values.js";
import type {
  LedgerCertificate,
  LedgerPartitionKey,
  LedgerPrintRow,
  LedgerSnapshot,
  LedgerSourceRef
} from "./types.js";

export const LEDGER_SNAPSHOT_LIMITS = {
  rows: 10_000,
  certificates: 200,
  certificateBytes: 500 * 1024 * 1024
} as const;
const dynamicFields = ["supplier_unit_address", "supplier_contact_phone"];
function nullableText(value: unknown): string | null {
  const normalized = nullableValue(value);
  return normalized === null ? null : String(normalized);
}
function requiredText(value: unknown): string {
  const text = nullableText(value);
  if (text === null) throw new Error("LEDGER_SOURCE_DATA_INVALID");
  return text;
}
function exactDecimal(value: unknown): string {
  // Imported payloads preserve decimal strings; reject corrupted/non-decimal facts.
  const text = requiredText(value);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) throw new Error("LEDGER_SOURCE_DATA_INVALID");
  return text;
}
function sourceChecksum(value: unknown): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value))
    throw new Error("LEDGER_SOURCE_METADATA_INVALID");
  return value;
}
function factFilter(key: LedgerPartitionKey) {
  return Prisma.sql`r.org_id = ${key.orgId} AND d.status = 'active' AND d.archived_at IS NULL
    AND b.status = 'applied' AND b.archived_at IS NULL
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.store_name')) AS BINARY) = CAST(${key.storeName} AS BINARY)
    AND JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.purchase_date')) = ${key.purchaseDate}`;
}
function factFrom() {
  return Prisma.sql`delivery_ledger_rows r JOIN documents d ON d.id = r.source_document_id AND d.org_id = r.org_id
    JOIN import_batches b ON b.id = r.import_batch_id AND b.org_id = r.org_id`;
}
type Fact = {
  id: string;
  payload: Prisma.JsonValue;
  sourceSheetIndex: number;
  sourceRowNumber: number;
  sourceDocumentId: string;
  importBatchId: string;
  checksumSha256: string;
  confidentialityLevel: number;
};
type Photo = {
  sourceDocumentId: string;
  receiptId: string;
  storageObjectKey: string;
  checksumSha256: string;
  contentType: string;
  byteSize: bigint;
  uploadedAt: Date;
  confidentialityLevel: number;
};

export type LedgerSourceMetadata = {
  sourceFingerprint: string;
  rowCount: number;
  sources: LedgerSourceRef[];
};
/** Bounded metadata only: never selects business payloads or fetches object/photo bytes. */
export async function readLedgerSourceMetadata(
  tx: Prisma.TransactionClient,
  key: LedgerPartitionKey
): Promise<LedgerSourceMetadata> {
  assertLedgerDate(key.purchaseDate);
  const filter = factFilter(key);
  const from = factFrom();
  const [stats] = await tx.$queryRaw<{ count: bigint }[]>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${from} WHERE ${filter}`
  );
  const rowCount = Number(stats?.count ?? 0);
  if (rowCount > LEDGER_SNAPSHOT_LIMITS.rows) throw new Error("LEDGER_ROW_LIMIT_EXCEEDED");
  const ledger = await tx.$queryRaw<
    {
      sourceDocumentId: string;
      batchId: string;
      rowCount: bigint;
      checksumSha256: string;
      confidentialityLevel: number;
    }[]
  >(Prisma.sql`
    SELECT r.source_document_id AS sourceDocumentId, r.import_batch_id AS batchId,
      COUNT(*) AS rowCount, d.checksum_sha256 AS checksumSha256,
      d.confidentiality_level AS confidentialityLevel
    FROM ${from} WHERE ${filter}
    GROUP BY r.source_document_id, r.import_batch_id, d.checksum_sha256, d.confidentiality_level
    LIMIT ${LEDGER_SNAPSHOT_LIMITS.rows + 1}`);
  const photos = await tx.$queryRaw<Photo[]>(Prisma.sql`
    SELECT q.source_document_id AS sourceDocumentId, q.receipt_id AS receiptId,
      cd.storage_object_key AS storageObjectKey, cd.checksum_sha256 AS checksumSha256,
      cd.content_type AS contentType, cd.byte_size AS byteSize, q.created_at AS uploadedAt,
      cd.confidentiality_level AS confidentialityLevel
    FROM quarantine_certificates q JOIN documents cd ON cd.id = q.source_document_id AND cd.org_id = q.org_id
    WHERE q.org_id = ${key.orgId} AND cd.status = 'active' AND cd.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM ${from} WHERE ${filter}
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.receipt_id')) AS BINARY) = CAST(q.receipt_id AS BINARY))
    ORDER BY CAST(q.receipt_id AS BINARY), q.created_at, q.source_document_id
    LIMIT ${LEDGER_SNAPSHOT_LIMITS.certificates + 1}`);
  if (photos.length > LEDGER_SNAPSHOT_LIMITS.certificates)
    throw new Error("LEDGER_CERTIFICATE_LIMIT_EXCEEDED");
  let bytes = 0n;
  const certificates = photos.map((photo) => {
    if (
      !photo.byteSize ||
      photo.byteSize <= 0n ||
      !["image/jpeg", "image/png"].includes(photo.contentType)
    )
      throw new Error("LEDGER_SOURCE_METADATA_INVALID");
    bytes += photo.byteSize;
    return {
      sourceDocumentId: photo.sourceDocumentId,
      receiptId: requiredText(photo.receiptId),
      storageObjectKey: requiredText(photo.storageObjectKey),
      checksumSha256: sourceChecksum(photo.checksumSha256),
      contentType: photo.contentType,
      byteSize: Number(photo.byteSize),
      uploadedAt: photo.uploadedAt.toISOString(),
      confidentialityLevel: photo.confidentialityLevel
    };
  });
  if (bytes > BigInt(LEDGER_SNAPSHOT_LIMITS.certificateBytes))
    throw new Error("LEDGER_CERTIFICATE_BYTES_LIMIT_EXCEEDED");
  const fingerprintMetadata = {
    ledger: ledger
      .map((entry) => ({
        source: {
          sourceDocumentId: entry.sourceDocumentId,
          kind: "ledger",
          confidentialityLevel: entry.confidentialityLevel,
          checksumSha256: sourceChecksum(entry.checksumSha256)
        },
        batchId: entry.batchId,
        rowCount: Number(entry.rowCount)
      }))
      .sort((a, b) => a.source.sourceDocumentId.localeCompare(b.source.sourceDocumentId)),
    certificates
  };
  return {
    rowCount,
    sources: [
      ...fingerprintMetadata.ledger.map((entry) => ({ ...entry.source, kind: "ledger" as const })),
      ...photos.map((photo) => ({
        sourceDocumentId: photo.sourceDocumentId,
        kind: "certificate" as const,
        confidentialityLevel: photo.confidentialityLevel,
        checksumSha256: sourceChecksum(photo.checksumSha256)
      }))
    ],
    sourceFingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprintMetadata))
      .digest("hex")
  };
}

export function createPrismaLedgerSourceReader({ prisma }: { prisma: PrismaClient }) {
  return {
    readLedgerSourceMetadata(key: LedgerPartitionKey) {
      return prisma.$transaction((tx) => readLedgerSourceMetadata(tx, key), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000
      });
    },
    async readLedgerSnapshot(key: LedgerPartitionKey): Promise<LedgerSnapshot> {
      assertLedgerDate(key.purchaseDate);
      if (!key.orgId || !key.storeName) throw new Error("LEDGER_PARTITION_KEY_INVALID");
      return prisma.$transaction(
        async (tx) => {
          const filter = factFilter(key);
          const from = factFrom();
          const [count] = await tx.$queryRaw<{ count: bigint }[]>(
            Prisma.sql`SELECT COUNT(*) AS count FROM ${from} WHERE ${filter}`
          );
          if (Number(count?.count ?? 0) > LEDGER_SNAPSHOT_LIMITS.rows)
            throw new Error("LEDGER_ROW_LIMIT_EXCEEDED");
          const certificateFilter = Prisma.sql`q.org_id = ${key.orgId} AND cd.status = 'active' AND cd.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM ${from} WHERE ${filter}
            AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.receipt_id')) AS BINARY) = CAST(q.receipt_id AS BINARY))`;
          const [photoStats] = await tx.$queryRaw<
            { count: bigint; bytes: Prisma.Decimal | null; invalid: bigint | null }[]
          >(Prisma.sql`
          SELECT COUNT(*) AS count, SUM(cd.byte_size) AS bytes,
            SUM(cd.byte_size IS NULL OR cd.byte_size <= 0 OR cd.storage_object_key = '' OR cd.checksum_sha256 IS NULL
              OR cd.content_type IS NULL OR cd.content_type NOT IN ('image/jpeg', 'image/png')) AS invalid
          FROM quarantine_certificates q JOIN documents cd ON cd.id = q.source_document_id AND cd.org_id = q.org_id WHERE ${certificateFilter}`);
          if (Number(photoStats?.count ?? 0) > LEDGER_SNAPSHOT_LIMITS.certificates)
            throw new Error("LEDGER_CERTIFICATE_LIMIT_EXCEEDED");
          if (
            BigInt(photoStats?.bytes?.toString() ?? "0") >
            BigInt(LEDGER_SNAPSHOT_LIMITS.certificateBytes)
          )
            throw new Error("LEDGER_CERTIFICATE_BYTES_LIMIT_EXCEEDED");
          if (Number(photoStats?.invalid ?? 0)) throw new Error("LEDGER_SOURCE_METADATA_INVALID");
          const facts = await tx.$queryRaw<Fact[]>(Prisma.sql`
          SELECT r.id, r.payload, r.source_sheet_index AS sourceSheetIndex, r.source_row_number AS sourceRowNumber,
            r.source_document_id AS sourceDocumentId, r.import_batch_id AS importBatchId, d.checksum_sha256 AS checksumSha256,
            d.confidentiality_level AS confidentialityLevel FROM ${from} WHERE ${filter}
          ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.receipt_id')) AS BINARY), r.source_sheet_index, r.source_row_number, r.source_document_id, r.id`);
          const photos = await tx.$queryRaw<Photo[]>(Prisma.sql`
          SELECT q.source_document_id AS sourceDocumentId, q.receipt_id AS receiptId, cd.storage_object_key AS storageObjectKey,
            cd.checksum_sha256 AS checksumSha256, cd.content_type AS contentType, cd.byte_size AS byteSize,
            q.created_at AS uploadedAt, cd.confidentiality_level AS confidentialityLevel
          FROM quarantine_certificates q JOIN documents cd ON cd.id = q.source_document_id AND cd.org_id = q.org_id WHERE ${certificateFilter}
          ORDER BY CAST(q.receipt_id AS BINARY), q.created_at, q.source_document_id`);
          const rows: LedgerPrintRow[] = facts.map((fact) => {
            const payload = fact.payload as Record<string, unknown>;
            return {
              receipt_id: requiredText(payload["receipt_id"]),
              item_name: requiredText(payload["item_name"]),
              specification: nullableText(payload["specification"]),
              purchase_quantity: exactDecimal(payload["purchase_quantity"]),
              purchase_amount: exactDecimal(payload["purchase_amount"]),
              production_date_or_batch: nullableText(payload["production_date_or_batch"]),
              shelf_life: nullableText(payload["shelf_life"]),
              supplier_name: nullableText(payload["supplier_name"]),
              supplier_unit_address: null,
              supplier_contact_phone: null,
              purchase_date: key.purchaseDate,
              sourceSheetIndex: fact.sourceSheetIndex,
              sourceRowNumber: fact.sourceRowNumber
            };
          });
          const ledgerMetadata = new Map<
            string,
            { source: LedgerSourceRef; batchId: string; rowCount: number }
          >();
          for (const fact of facts) {
            const existing = ledgerMetadata.get(fact.sourceDocumentId);
            if (existing) existing.rowCount++;
            else
              ledgerMetadata.set(fact.sourceDocumentId, {
                source: {
                  sourceDocumentId: fact.sourceDocumentId,
                  kind: "ledger",
                  confidentialityLevel: fact.confidentialityLevel,
                  checksumSha256: sourceChecksum(fact.checksumSha256)
                },
                batchId: fact.importBatchId,
                rowCount: 1
              });
          }
          const certificates: LedgerCertificate[] = photos.map((photo) => ({
            sourceDocumentId: photo.sourceDocumentId,
            receiptId: requiredText(photo.receiptId),
            storageObjectKey: requiredText(photo.storageObjectKey),
            checksumSha256: sourceChecksum(photo.checksumSha256),
            contentType: photo.contentType,
            byteSize: Number(photo.byteSize),
            uploadedAt: photo.uploadedAt.toISOString()
          }));
          const sources: LedgerSourceRef[] = [...ledgerMetadata.values()].map(
            (entry) => entry.source
          );
          sources.push(
            ...photos.map((photo) => ({
              sourceDocumentId: photo.sourceDocumentId,
              kind: "certificate" as const,
              confidentialityLevel: photo.confidentialityLevel,
              checksumSha256: sourceChecksum(photo.checksumSha256)
            }))
          );
          const fingerprintMetadata = {
            ledger: [...ledgerMetadata.values()].sort((a, b) =>
              a.source.sourceDocumentId.localeCompare(b.source.sourceDocumentId)
            ),
            certificates: certificates.map((certificate, index) => ({
              ...certificate,
              confidentialityLevel: photos[index]!.confidentialityLevel
            }))
          };
          const sourceFingerprint = createHash("sha256")
            .update(JSON.stringify(fingerprintMetadata))
            .digest("hex");
          const names = [
            ...new Set(
              rows.flatMap((row) => (row.supplier_name === null ? [] : [row.supplier_name]))
            )
          ];
          const catalog = names.length
            ? await findReadableCurrentSupplierCatalog(tx, { orgId: key.orgId })
            : null;
          if (catalog) {
            const matches = await findSupplierCatalogMatches(
              tx,
              catalog.id,
              catalog.source_document_id,
              names,
              dynamicFields,
              key.orgId
            );
            const byName = new Map<string, Record<string, unknown>[]>();
            for (const match of matches) {
              const name = match["supplier_name"];
              if (typeof name === "string") byName.set(name, [...(byName.get(name) ?? []), match]);
            }
            let used = false;
            for (const row of rows) {
              const matched =
                row.supplier_name === null ? [] : (byName.get(row.supplier_name) ?? []);
              if (matched.length !== 1) continue;
              row.supplier_unit_address = nullableText(matched[0]!["unit_address"]);
              row.supplier_contact_phone = nullableText(matched[0]!["contact_phone"]);
              used ||= row.supplier_unit_address !== null || row.supplier_contact_phone !== null;
            }
            if (used) {
              const document = await tx.document.findFirstOrThrow({
                where: { orgId: key.orgId, id: catalog.source_document_id }
              });
              sources.push({
                sourceDocumentId: document.id,
                kind: "supplier",
                confidentialityLevel: document.confidentialityLevel,
                checksumSha256: sourceChecksum(document.checksumSha256)
              });
            }
          }
          const partition = await tx.ledgerPdfPartition.findUnique({
            where: {
              orgId_storeNameHash_purchaseDate: {
                orgId: key.orgId,
                storeNameHash: ledgerStoreNameHash(key.storeName),
                purchaseDate: new Date(`${key.purchaseDate}T00:00:00.000Z`)
              }
            }
          });
          if (partition && partition.storeName !== key.storeName)
            throw new Error("LEDGER_STORE_HASH_COLLISION");
          return {
            key,
            dataRevision: partition?.dataRevision ?? 0,
            sourceFingerprint,
            rows,
            certificates,
            sources,
            confidentialityLevel: Math.max(
              0,
              ...sources.map((source) => source.confidentialityLevel)
            )
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 }
      );
    },
    async listLedgerFactPartitions(input: {
      orgId: string;
      cursor?: string;
      limit: number;
    }): Promise<{ keys: LedgerPartitionKey[]; nextCursor: string | null }> {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)
        throw new Error("LEDGER_PAGE_LIMIT_INVALID");
      let cursor: [string, string] | null = null;
      if (input.cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(input.cursor, "base64url").toString()
          ) as unknown[];
          if (
            !Array.isArray(decoded) ||
            decoded.length !== 3 ||
            decoded[0] !== input.orgId ||
            typeof decoded[1] !== "string" ||
            typeof decoded[2] !== "string"
          )
            throw new Error();
          cursor = [decoded[1], decoded[2]];
        } catch {
          throw new Error("LEDGER_CURSOR_INVALID");
        }
      }
      const after = cursor
        ? Prisma.sql`AND (CAST(storeName AS BINARY) > CAST(${cursor[0]} AS BINARY) OR (CAST(storeName AS BINARY) = CAST(${cursor[0]} AS BINARY) AND purchaseDate > ${cursor[1]}))`
        : Prisma.empty;
      const found = await prisma.$queryRaw<
        { storeName: string; purchaseDate: string }[]
      >(Prisma.sql`
        SELECT CONVERT(storeName USING utf8mb4) AS storeName, purchaseDate FROM (
          SELECT DISTINCT CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.store_name')) AS BINARY) AS storeName,
            JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.purchase_date')) AS purchaseDate FROM ${factFrom()}
          WHERE r.org_id = ${input.orgId} AND d.status = 'active' AND d.archived_at IS NULL AND b.status = 'applied' AND b.archived_at IS NULL
        ) facts WHERE storeName IS NOT NULL AND purchaseDate IS NOT NULL ${after} ORDER BY CAST(storeName AS BINARY), purchaseDate LIMIT ${input.limit + 1}`);
      const page = found.slice(0, input.limit).map((row) => ({
        orgId: input.orgId,
        storeName: String(row.storeName),
        purchaseDate: row.purchaseDate
      }));
      const last = page.at(-1);
      return {
        keys: page,
        nextCursor:
          found.length > input.limit && last
            ? Buffer.from(
                JSON.stringify([input.orgId, last.storeName, last.purchaseDate])
              ).toString("base64url")
            : null
      };
    }
  };
}
