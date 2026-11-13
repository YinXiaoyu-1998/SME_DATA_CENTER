export const LEDGER_SCOPE_MAX_PARTITIONS = 5_000;
export const LEDGER_STORE_NAME_MAX_CHARS = 512;
const LEDGER_PDF_PREFIX = "食品经营单位进货台帐_";

export const LEDGER_BUNDLE_LIMITS = {
  files: LEDGER_SCOPE_MAX_PARTITIONS,
  bytes: 1_073_741_824,
  deadlineMs: 600_000,
  retentionMs: 86_400_000
} as const;

export function ledgerBundleZipOverhead(entryCount: number, totalNameBytes: number): number {
  // STORE adds local/central headers, descriptors and UTF-8 filename extras.
  return 22 + 128 * entryCount + 4 * totalNameBytes;
}

// Each UTF-16 code unit occupies at most three bytes after filename escaping or UTF-8 encoding.
const maxEntryNameBytes =
  2 * 3 * LEDGER_STORE_NAME_MAX_CHARS +
  Buffer.byteLength(`/2000-01-01/${LEDGER_PDF_PREFIX}_2000-01-01.pdf`);
export const LEDGER_BUNDLE_MAX_ZIP_BYTES =
  LEDGER_BUNDLE_LIMITS.bytes +
  ledgerBundleZipOverhead(
    LEDGER_BUNDLE_LIMITS.files,
    LEDGER_BUNDLE_LIMITS.files * maxEntryNameBytes
  );

export function ledgerStoreFileSegment(storeName: string): string {
  // Escape percent itself so encoding is reversible and path separators stay literal.
  return [...storeName]
    .map((character, index, characters) =>
      '%./\\<>:"|?*'.includes(character) ||
      character.codePointAt(0)! < 32 ||
      character.codePointAt(0) === 127 ||
      (character === " " && index === characters.length - 1)
        ? `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`
        : character
    )
    .join("");
}

export function decodeLedgerStoreFileSegment(segment: string): string {
  return segment.replace(/%([0-9A-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

export function ledgerPdfNameForSegment(storeSegment: string, purchaseDate: string): string {
  return `${LEDGER_PDF_PREFIX}${storeSegment}_${purchaseDate}.pdf`;
}
