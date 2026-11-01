import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  inspectXlsxFile,
  type XlsxReadLimits,
  type XlsxStreamConsumer,
  type XlsxStreamProfile
} from "./xlsx-stream.js";

const DEFAULT_READER_COMMAND = "smedc-calamine-reader";
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PARTITION_COLUMNS = 1_024;

export class CalamineSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalamineSourceError";
  }
}

export async function streamCalamineXlsxFileRows(input: {
  filePath: string;
  limits: XlsxReadLimits;
  consumer: XlsxStreamConsumer;
  signal?: AbortSignal;
  command?: readonly string[];
  preserveCellWhitespace?: boolean;
}): Promise<XlsxStreamProfile> {
  throwIfAborted(input.signal);
  const inspection = await inspectXlsxFile(input.filePath, input.limits);
  const command = input.command ?? [
    process.env.SMEDC_CALAMINE_READER_PATH || DEFAULT_READER_COMMAND
  ];
  const [executable, ...prefixArguments] = command;
  if (!executable) throw new Error("Calamine reader command must not be empty.");

  const child = spawn(
    executable,
    [
      ...prefixArguments,
      "--input",
      input.filePath,
      "--max-cell-chars",
      String(input.limits.maxStructuredCellChars),
      "--max-sheets",
      String(input.limits.maxXlsxSheets),
      "--max-uncompressed-bytes",
      String(input.limits.maxXlsxUncompressedBytes),
      "--max-zip-entries",
      String(input.limits.maxXlsxZipEntries),
      "--max-compression-ratio",
      String(input.limits.maxXlsxCompressionRatio)
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
  );
  child.stderr.resume();
  const abort = () => child.kill("SIGTERM");
  input.signal?.addEventListener("abort", abort, { once: true });

  const decodeStartedAt = performance.now();
  let consumerMs = 0;
  let activeSheetIndex: number | undefined;
  let nextSheetIndex = 0;
  let lastRowNumber = 0;
  let completed = false;

  try {
    for await (const line of protocolLines(child.stdout)) {
      throwIfAborted(input.signal);
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES)
        throw new Error("Calamine reader protocol line exceeded its limit.");
      const event = parseEvent(line);
      if (event.type === "sheet") {
        if (activeSheetIndex !== undefined || event.sheetIndex !== nextSheetIndex || completed)
          throw new Error("Calamine reader emitted an invalid sheet sequence.");
        const expected = inspection.sheets[event.sheetIndex];
        if (!expected || expected.name !== event.name || expected.hidden !== event.hidden)
          throw new Error("Calamine reader worksheet metadata did not match the XLSX archive.");
        activeSheetIndex = event.sheetIndex;
        lastRowNumber = 0;
        const consumerStartedAt = performance.now();
        await input.consumer.startSheet(expected);
        consumerMs += performance.now() - consumerStartedAt;
        continue;
      }
      if (event.type === "rows") {
        if (activeSheetIndex === undefined || event.sheetIndex !== activeSheetIndex || completed)
          throw new Error("Calamine reader emitted rows outside an active sheet.");
        const sheet = inspection.sheets[activeSheetIndex]!;
        for (const [rowNumber, rawCells] of event.rows) {
          if (!Number.isSafeInteger(rowNumber) || rowNumber <= lastRowNumber)
            throw new Error("Calamine reader emitted non-monotonic row numbers.");
          if (rawCells.length > MAX_PARTITION_COLUMNS)
            throw new CalamineSourceError("Partition worksheet column limit exceeded.");
          const cells = rawCells.map((cell) =>
            checkedCellText(cell, input.limits, input.preserveCellWhitespace)
          );
          lastRowNumber = rowNumber;
          const consumerStartedAt = performance.now();
          await input.consumer.row(sheet, rowNumber, cells);
          consumerMs += performance.now() - consumerStartedAt;
        }
        continue;
      }
      if (event.type === "end_sheet") {
        if (activeSheetIndex === undefined || event.sheetIndex !== activeSheetIndex || completed)
          throw new Error("Calamine reader emitted an invalid sheet ending.");
        const sheet = inspection.sheets[activeSheetIndex]!;
        const consumerStartedAt = performance.now();
        await input.consumer.endSheet(sheet);
        consumerMs += performance.now() - consumerStartedAt;
        activeSheetIndex = undefined;
        nextSheetIndex += 1;
        continue;
      }
      if (
        completed ||
        activeSheetIndex !== undefined ||
        nextSheetIndex !== inspection.sheets.length ||
        event.sheetCount !== inspection.sheets.length
      )
        throw new Error("Calamine reader completed before every worksheet ended.");
      completed = true;
    }

    const result = await exit;
    throwIfAborted(input.signal);
    if (result.code !== 0) {
      throw new CalamineSourceError(
        `Calamine reader exited unsuccessfully (code ${result.code ?? "signal"}).`
      );
    }
    if (!completed) throw new Error("Calamine reader protocol ended before completion.");
    const elapsedMs = performance.now() - decodeStartedAt;
    return {
      structureReadMs: inspection.structureReadMs,
      mergeScanMs: 0,
      rowDecodeMs: Math.max(0, elapsedMs - consumerMs),
      consumerMs
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exit.catch(() => undefined);
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

async function* protocolLines(
  stream: AsyncIterable<Buffer | Uint8Array | string>
): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let byteLength = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      byteLength += part.byteLength;
      if (byteLength > MAX_PROTOCOL_LINE_BYTES)
        throw new Error("Calamine reader protocol line exceeded its limit.");
      if (part.byteLength > 0) parts.push(part);
      if (newline === -1) break;
      const line = Buffer.concat(parts, byteLength);
      const content = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
      yield decoder.decode(content);
      parts = [];
      byteLength = 0;
      offset = newline + 1;
    }
  }
  if (byteLength > 0) yield decoder.decode(Buffer.concat(parts, byteLength));
}

type ProtocolEvent =
  | { type: "sheet"; sheetIndex: number; name: string; hidden: boolean }
  | { type: "rows"; sheetIndex: number; rows: Array<[number, string[]]> }
  | { type: "end_sheet"; sheetIndex: number }
  | { type: "complete"; sheetCount: number };

function parseEvent(line: string): ProtocolEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Calamine reader emitted invalid JSON.");
  }
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error("Calamine reader emitted an invalid event.");
  if (value.type === "sheet") {
    if (
      !Number.isSafeInteger(value.sheetIndex) ||
      typeof value.name !== "string" ||
      typeof value.hidden !== "boolean"
    )
      throw new Error("Calamine reader emitted invalid worksheet metadata.");
    return value as ProtocolEvent;
  }
  if (value.type === "rows") {
    if (!Number.isSafeInteger(value.sheetIndex) || !Array.isArray(value.rows))
      throw new Error("Calamine reader emitted an invalid row batch.");
    for (const row of value.rows) {
      if (
        !Array.isArray(row) ||
        row.length !== 2 ||
        !Number.isSafeInteger(row[0]) ||
        !Array.isArray(row[1]) ||
        !row[1].every((cell) => typeof cell === "string")
      )
        throw new Error("Calamine reader emitted an invalid row.");
    }
    return value as ProtocolEvent;
  }
  if (value.type === "end_sheet") {
    if (!Number.isSafeInteger(value.sheetIndex))
      throw new Error("Calamine reader emitted an invalid sheet ending.");
    return value as ProtocolEvent;
  }
  if (value.type === "complete") {
    if (!Number.isSafeInteger(value.sheetCount))
      throw new Error("Calamine reader emitted an invalid completion event.");
    return value as ProtocolEvent;
  }
  throw new Error("Calamine reader emitted an unknown event.");
}

function checkedCellText(
  value: string,
  limits: XlsxReadLimits,
  preserveWhitespace = false
): string {
  if (value.length > limits.maxStructuredCellChars)
    throw new CalamineSourceError("Structured cell length limit exceeded.");
  return preserveWhitespace ? value : value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Partition export was aborted.");
  error.name = "AbortError";
  throw error;
}
