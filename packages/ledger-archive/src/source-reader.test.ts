import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createPrismaLedgerSourceReader } from "./source-reader.js";
const key = { orgId: "org", storeName: "Shop A ", purchaseDate: "2026-10-04" };
const checksum = "a".repeat(64);
const payload = {
  receipt_id: "R1",
  item_name: "Rice",
  purchase_quantity: "1.234567890123456789",
  purchase_amount: "5.00",
  supplier_name: "Supplier",
  specification: "null",
  production_date_or_batch: null
};
function fixture() {
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ count: 1n }])
      .mockResolvedValueOnce([{ count: 0n, bytes: null, invalid: 0n }])
      .mockResolvedValueOnce([
        {
          id: "row",
          sourceDocumentId: "ledger",
          importBatchId: "batch",
          confidentialityLevel: 1,
          checksumSha256: checksum,
          sourceSheetIndex: 0,
          sourceRowNumber: 2,
          payload
        }
      ])
      .mockResolvedValueOnce([]),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValueOnce([{ id: "supplier-batch", source_document_id: "supplier" }])
      .mockResolvedValueOnce([
        { supplier_name: "Supplier", unit_address: "Address", contact_phone: "null" }
      ]),
    document: {
      findFirstOrThrow: vi
        .fn()
        .mockResolvedValue({ id: "supplier", confidentialityLevel: 2, checksumSha256: checksum })
    },
    ledgerPdfPartition: {
      findUnique: vi.fn().mockResolvedValue({ dataRevision: 3, storeName: key.storeName })
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(tx))
  };
  return {
    tx,
    reader: createPrismaLedgerSourceReader({ prisma: prisma as unknown as PrismaClient })
  };
}
describe("complete ledger source snapshot", () => {
  it("preserves precise decimals, literal null blanks and only actual supplier dependencies", async () => {
    const { reader } = fixture();
    const snapshot = await reader.readLedgerSnapshot(key);
    expect(snapshot.rows[0]).toMatchObject({
      purchase_quantity: payload.purchase_quantity,
      purchase_amount: "5.00",
      specification: null,
      supplier_unit_address: "Address",
      supplier_contact_phone: null
    });
    expect(snapshot.sources.map((source) => source.kind)).toEqual(["ledger", "supplier"]);
    expect(snapshot.confidentialityLevel).toBe(2);
    expect(snapshot.dataRevision).toBe(3);
  });
  it("does not fingerprint ordinary supplier content, and duplicates leave dynamic values blank", async () => {
    const one = fixture();
    const two = fixture();
    two.tx.$queryRawUnsafe
      .mockReset()
      .mockResolvedValueOnce([{ id: "supplier-batch", source_document_id: "supplier" }])
      .mockResolvedValueOnce([
        { supplier_name: "Supplier", unit_address: "Other", contact_phone: "0123" }
      ]);
    expect((await one.reader.readLedgerSnapshot(key)).sourceFingerprint).toBe(
      (await two.reader.readLedgerSnapshot(key)).sourceFingerprint
    );
    const duplicate = fixture();
    duplicate.tx.$queryRawUnsafe
      .mockReset()
      .mockResolvedValueOnce([{ id: "supplier-batch", source_document_id: "supplier" }])
      .mockResolvedValueOnce([
        { supplier_name: "Supplier", unit_address: "Address" },
        { supplier_name: "Supplier", unit_address: "Address 2" }
      ]);
    const snapshot = await duplicate.reader.readLedgerSnapshot(key);
    expect(snapshot.rows[0]?.supplier_unit_address).toBeNull();
    expect(snapshot.sources.map((source) => source.kind)).toEqual(["ledger"]);
  });
  it("checks row and photo limits before materializing business rows or photo references", async () => {
    const { reader, tx } = fixture();
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ count: 10001n }]);
    await expect(reader.readLedgerSnapshot(key)).rejects.toThrow("LEDGER_ROW_LIMIT_EXCEEDED");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const photo = fixture();
    photo.tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ count: 1n }])
      .mockResolvedValueOnce([{ count: 201n, bytes: 1n, invalid: 0n }]);
    await expect(photo.reader.readLedgerSnapshot(key)).rejects.toThrow(
      "LEDGER_CERTIFICATE_LIMIT_EXCEEDED"
    );
    expect(photo.tx.$queryRaw).toHaveBeenCalledTimes(2);
    const oversize = fixture();
    oversize.tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ count: 1n }])
      .mockResolvedValueOnce([{ count: 1n, bytes: 524288001n, invalid: 0n }]);
    await expect(oversize.reader.readLedgerSnapshot(key)).rejects.toThrow(
      "LEDGER_CERTIFICATE_BYTES_LIMIT_EXCEEDED"
    );
    const invalid = fixture();
    invalid.tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ count: 1n }])
      .mockResolvedValueOnce([{ count: 1n, bytes: 1n, invalid: 1n }]);
    await expect(invalid.reader.readLedgerSnapshot(key)).rejects.toThrow(
      "LEDGER_SOURCE_METADATA_INVALID"
    );
  });
});
