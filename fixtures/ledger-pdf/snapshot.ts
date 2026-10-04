import type { LedgerSnapshot } from "@smedc/ledger-archive";
export function syntheticSnapshot(rowCount = 80, certificateCount = 0): LedgerSnapshot {
  return {
    key: { orgId: "synthetic-org", storeName: "合成测试门店", purchaseDate: "2026-10-04" },
    dataRevision: 1,
    sourceFingerprint: "synthetic-fingerprint",
    confidentialityLevel: 1,
    sources: [],
    rows: Array.from({ length: rowCount }, (_, index) => ({
      receipt_id: "TEST-RECEIPT-001",
      item_name: `合成食品${index + 1}`,
      specification: null,
      purchase_quantity: "1234567890.123456789",
      purchase_amount: "12.3400",
      production_date_or_batch: "合成批次",
      shelf_life: "null",
      supplier_name: "合成供货商",
      supplier_unit_address: "北京市朝阳区合成测试街道一百二十三号示例园区二号楼三层西侧仓库",
      supplier_contact_phone: index % 2 === 0 ? "00123" : "+86123",
      purchase_date: "2026-10-04",
      sourceSheetIndex: 0,
      sourceRowNumber: index + 2
    })),
    certificates: Array.from({ length: certificateCount }, (_, index) => ({
      sourceDocumentId: `synthetic-photo-${index}`,
      receiptId: "TEST-RECEIPT-001",
      storageObjectKey: `synthetic/photo-${index}.png`,
      checksumSha256: "synthetic-checksum",
      contentType: "image/png",
      byteSize: 1000,
      uploadedAt: "2026-10-04T00:00:00.000Z"
    }))
  };
}
