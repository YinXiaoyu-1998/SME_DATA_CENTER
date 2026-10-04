/** Internal ledger archive contracts. Decimal values stay exact strings. */
export type LedgerPartitionKey = { orgId: string; storeName: string; purchaseDate: string };
export type LedgerScope = { storeNames: string[] } & (
  | { dates: string[]; startDate?: never; endDate?: never }
  | { startDate: string; endDate: string; dates?: never }
);
export type LedgerActor =
  | { kind: "employee"; employeeId: string }
  | { kind: "operator"; label: string }
  | { kind: "system_reconciler"; reconciliationRunId: string };
export type LedgerSourceRef = {
  sourceDocumentId: string;
  kind: "ledger" | "supplier" | "certificate";
  confidentialityLevel: number;
  checksumSha256: string;
};
export type LedgerPrintRow = {
  receipt_id: string;
  item_name: string;
  specification: string | null;
  purchase_quantity: string;
  purchase_amount: string;
  production_date_or_batch: string | null;
  shelf_life: string | null;
  supplier_name: string | null;
  supplier_unit_address: string | null;
  supplier_contact_phone: string | null;
  purchase_date: string;
  sourceSheetIndex: number;
  sourceRowNumber: number;
};
export type LedgerCertificate = {
  sourceDocumentId: string;
  receiptId: string;
  storageObjectKey: string;
  checksumSha256: string;
  contentType: string;
  byteSize: number;
  uploadedAt: string;
};
export type LedgerSnapshot = {
  key: LedgerPartitionKey;
  dataRevision: number;
  sourceFingerprint: string;
  rows: LedgerPrintRow[];
  certificates: LedgerCertificate[];
  sources: LedgerSourceRef[];
  confidentialityLevel: number;
};
export type RenderedLedgerPdf = {
  path: string;
  byteSize: number;
  checksumSha256: string;
  pageCount: number;
};
export type LedgerRequestRef = { requestId: string; status: string };
