import {
  EvidenceParseError,
  validatePdfTableWorkBudget,
  type EvidenceWarning,
  type ParsedEvidenceBlock,
  type PdfSourceLocation,
  type PdfTable,
  type PdfTableCell
} from "@smedc/domain";

/** Input tables must first pass parsePdfEvidenceResult. Indices are zero-based. */
export function createPdfTableBlocks(
  table: PdfTable,
  context: { headingPath: string[]; sourceLocation: PdfSourceLocation; maxChunkChars: number }
): ParsedEvidenceBlock[] {
  if (!Number.isSafeInteger(context.maxChunkChars) || context.maxChunkChars < 1) {
    throw new EvidenceParseError("PDF_INVALID_CHUNK_LIMIT", "Invalid PDF table chunk limit.");
  }
  validatePdfTableWorkBudget(table);
  const headers = new Set(table.headerRows);
  const labels = Array.from({ length: table.columnCount }, (_, column) => {
    const values = [...headers]
      .sort((a, b) => a - b)
      .map((row) => cellAt(row, column)?.text.trim())
      .filter((value): value is string => Boolean(value));
    return [...new Set(values)].join(" / ") || `列${column + 1}`;
  });
  const prefix = `表头: ${labels.join(" | ")}\n`;
  const blocks: ParsedEvidenceBlock[] = [];
  let pending: Array<{ row: number; text: string }> = [];

  for (let row = 0; row < table.rowCount; row++) {
    if (headers.has(row)) continue;
    const values = labels.map((_, column) => cellAt(row, column)?.text ?? "");
    const text = renderRow(row, values);
    if (prefix.length + text.length > context.maxChunkChars) {
      flush();
      const overhead =
        prefix.length +
        renderRow(
          row,
          labels.map(() => "")
        ).length;
      const available = context.maxChunkChars - overhead;
      // Repeat complete short cells (including amount ranges) whenever they fit,
      // reserving at least one character for every remaining long cell.
      const repeated = values.map(() => false);
      let variableCount = values.length;
      let fixedSize = 0;
      const shortestFirst = values
        .map((value, index) => ({ length: value.length, index }))
        .sort((a, b) => a.length - b.length);
      for (const candidate of shortestFirst) {
        if (variableCount > 1 && candidate.length <= available - fixedSize - (variableCount - 1)) {
          repeated[candidate.index] = true;
          fixedSize += candidate.length;
          variableCount--;
        }
      }
      const sliceSize = Math.floor((available - fixedSize) / variableCount);
      if (sliceSize < 1 || !Number.isFinite(sliceSize)) {
        // Context/labels cannot fit: keep the relationship intact and make this visible.
        emit([row], text, {
          code: "PDF_TABLE_CONTEXT_EXCEEDS_CHUNK_LIMIT",
          message: "PDF table context exceeds the chunk limit; the row was retained intact."
        });
        continue;
      }
      const pieces = values.map((value, index) =>
        repeated[index] ? [value] : splitCell(value, sliceSize)
      );
      if (pieces.some((cellPieces) => cellPieces === null)) {
        emit([row], text, {
          code: "PDF_TABLE_CONTEXT_EXCEEDS_CHUNK_LIMIT",
          message:
            "PDF table context leaves insufficient room for a complete character; the row was retained intact."
        });
        continue;
      }
      const parts = Math.max(...pieces.map((cellPieces) => cellPieces!.length));
      for (let partIndex = 0; partIndex < parts; partIndex++) {
        const fragments = pieces.map((cellPieces, index) =>
          repeated[index] ? values[index]! : (cellPieces![partIndex] ?? "")
        );
        emit(
          [row],
          renderRow(row, fragments),
          {
            code: "PDF_TABLE_ROW_CONTINUED",
            message:
              "An oversized PDF table row was continued with stable row and column provenance."
          },
          { rowId: rowId(row), partIndex, partCount: parts }
        );
      }
      continue;
    }
    const candidate = prefix + [...pending.map((entry) => entry.text), text].join("\n");
    if (pending.length > 0 && candidate.length > context.maxChunkChars) flush();
    pending.push({ row, text });
  }
  flush();
  // A header-only table remains searchable and traceable.
  if (blocks.length === 0 && table.headerRows.length > 0) {
    emit(
      [...table.headerRows].sort((a, b) => a - b),
      "",
      prefix.trim().length > context.maxChunkChars
        ? {
            code: "PDF_TABLE_CONTEXT_EXCEEDS_CHUNK_LIMIT",
            message: "PDF table headers exceed the chunk limit and were retained intact."
          }
        : undefined
    );
  }
  return blocks;

  function cellAt(row: number, column: number): PdfTableCell | undefined {
    return table.cells.find(
      (cell) =>
        cell.row <= row &&
        row < cell.row + cell.rowSpan &&
        cell.column <= column &&
        column < cell.column + cell.columnSpan
    );
  }
  function rowId(row: number) {
    return `${table.id}:row:${row}`;
  }
  function renderRow(row: number, values: string[]) {
    return `行 ${row + 1}: ${values.map((value, column) => `${labels[column]}: ${value}`).join(" | ")}`;
  }
  function flush() {
    if (pending.length === 0) return;
    emit(
      pending.map((entry) => entry.row),
      pending.map((entry) => entry.text).join("\n")
    );
    pending = [];
  }
  function emit(
    rows: number[],
    text: string,
    warning?: Pick<EvidenceWarning, "code" | "message">,
    continuation?: { rowId: string; partIndex: number; partCount: number }
  ) {
    const sourceLocation = { ...context.sourceLocation, tableRow: rows[0] };
    blocks.push({
      blockId: `${table.id}:rows:${rows[0]}-${rows.at(-1)}${continuation ? `:part:${continuation.partIndex}` : ""}`,
      blockType: "table",
      text: text.length === 0 ? prefix.slice(0, -1) : prefix + text,
      headingPath: [...context.headingPath],
      sourceLocation,
      metadata: {
        pdfTableChunk: true,
        tableId: table.id,
        rowStart: rows[0],
        rowEnd: rows.at(-1),
        rowIds: rows.map(rowId),
        // Include original span coordinates even when the cell carries into another row.
        cellOrigins: table.cells
          .filter((cell) => rows.some((row) => cell.row <= row && row < cell.row + cell.rowSpan))
          .map(({ row, column, rowSpan, columnSpan }) => ({ row, column, rowSpan, columnSpan })),
        ...(continuation ? { continuation } : {}),
        ...(warning ? { warnings: [{ ...warning, sourceLocation }] } : {})
      }
    });
  }
}

/** Keep surrogate pairs together while respecting the existing UTF-16 character budget. */
function splitCell(value: string, limit: number): string[] | null {
  const pieces: string[] = [];
  let current = "";
  for (const character of value) {
    if (character.length > limit) return null;
    if (current.length + character.length > limit) {
      pieces.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}
