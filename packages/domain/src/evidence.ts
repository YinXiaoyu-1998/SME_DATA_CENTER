export const EVIDENCE_BLOCK_TYPES = ["heading", "paragraph", "list", "table", "code"] as const;

export type EvidenceBlockType = (typeof EVIDENCE_BLOCK_TYPES)[number];

export interface EvidenceSourceLocation {
  pageNumber?: number;
  bbox?: { left: number; top: number; right: number; bottom: number };
  method?: "native" | "ocr";
  startLine?: number;
  endLine?: number;
  blockOrdinal?: number;
  tableRow?: number;
  tableCell?: number;
}

export interface EvidenceWarning {
  code: string;
  message: string;
  sourceLocation?: EvidenceSourceLocation;
}

export interface ParsedEvidenceBlock {
  blockId: string;
  blockType: EvidenceBlockType;
  text: string;
  headingPath: string[];
  sourceLocation: EvidenceSourceLocation;
  metadata: Record<string, unknown>;
}

export interface ParsedEvidenceDocument {
  blocks: ParsedEvidenceBlock[];
  warnings: EvidenceWarning[];
}

export class EvidenceParseError extends Error {
  readonly code: string;
  readonly canBecomeActive: false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvidenceParseError";
    this.code = code;
    this.canBecomeActive = false;
  }
}
