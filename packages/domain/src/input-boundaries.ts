export const PUBLIC_INPUT_LIMITS = Object.freeze({
  uploadFilenameChars: 255,
  uploadMediaTypeChars: 255,
  evidenceTitleChars: 512,
  sourceSystemChars: 255,
  enterpriseNameChars: 255,
  idempotencyKeyChars: 255,
  labelKeyChars: 128,
  labelsPerRequest: 50,
  evidenceQueryChars: 4_000,
  evidenceFilterIdChars: 64,
  evidenceFilterIdsPerGroup: 100,
  cursorChars: 4_096,
  structuredQueryStringScalarChars: 32_767,
  multipartFiles: 1,
  multipartFields: 60,
  multipartParts: 61
} as const);
