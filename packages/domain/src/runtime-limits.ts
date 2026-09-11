export type RuntimeLimitEnv = Readonly<Record<string, string | undefined>>;

export interface PositiveSafeIntegerRule {
  defaultValue: number;
  minimum?: number;
}

export const PHASE3_RUNTIME_LIMIT_DEFAULTS = Object.freeze({
  maxUploadBytes: 52_428_800,
  mcpMaxConcurrentRequests: 8,
  maxStructuredImportRows: 100_000,
  maxXlsxSheets: 20,
  maxStructuredCellChars: 32_767,
  maxXlsxUncompressedBytes: 209_715_200,
  maxXlsxZipEntries: 10_000,
  maxXlsxCompressionRatio: 100,
  structuredImportBatchInsertSize: 500,
  structuredImportTransactionTimeoutMs: 120_000,
  maxDocumentChars: 5_000_000,
  maxChunksPerDocument: 5_000,
  evidenceChunkMaxChars: 1_600,
  evidenceChunkOverlapChars: 200,
  evidenceSectionMaxChars: 6_000,
  evidenceSectionMaxChunks: 6,
  workerConcurrency: 2,
  workerLeaseSeconds: 120,
  workerPollIntervalMs: 1_000,
  workerMaxAttempts: 3,
  workerRetryBaseMs: 1_000,
  workerRetryMaxMs: 60_000
} as const);

export function parsePositiveSafeInteger(
  env: RuntimeLimitEnv,
  key: string,
  rule: PositiveSafeIntegerRule
): number {
  const rawValue = env[key]?.trim();

  if (!rawValue) {
    return rule.defaultValue;
  }

  const parsed = Number(rawValue);
  const minimum = rule.minimum ?? 1;

  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    const condition =
      minimum === 1
        ? "must be a safe integer greater than 0."
        : `must be a safe integer greater than or equal to ${minimum}.`;
    throw new Error(`${key} ${condition}`);
  }

  return parsed;
}
