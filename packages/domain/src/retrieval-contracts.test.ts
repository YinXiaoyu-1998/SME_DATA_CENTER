import { describe, expect, it } from "vitest";
import {
  isAllowedFileTypeForDocumentKind,
  isDocumentKind,
  isPhase3FileType,
  PHASE3_ERROR_CODES
} from "./index.js";

describe("Phase 3 retrieval contracts", () => {
  it("accepts only the supported file types for each document kind", () => {
    expect(isDocumentKind("evidence")).toBe(true);
    expect(isDocumentKind("structured")).toBe(true);
    expect(isDocumentKind("legacy")).toBe(false);

    expect(isPhase3FileType("md")).toBe(true);
    expect(isPhase3FileType("xlsx")).toBe(true);
    expect(isPhase3FileType("json")).toBe(false);

    expect(isAllowedFileTypeForDocumentKind("evidence", "docx")).toBe(true);
    expect(isAllowedFileTypeForDocumentKind("evidence", "xlsx")).toBe(false);
    expect(isAllowedFileTypeForDocumentKind("structured", "csv")).toBe(true);
    expect(isAllowedFileTypeForDocumentKind("structured", "json")).toBe(false);
  });

  it("publishes stable client-safe Phase 3 error codes", () => {
    expect(PHASE3_ERROR_CODES.unsupportedFileType).toBe("UNSUPPORTED_FILE_TYPE");
    expect(PHASE3_ERROR_CODES.temporarilyUnavailable).toBe("TEMPORARILY_UNAVAILABLE");
    expect(PHASE3_ERROR_CODES.idempotencyKeyConflict).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });
});
