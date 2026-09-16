import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  PARTITION_ERROR_CODES,
  getStructuredRegistry,
  partitionStoreIdentity,
  resolveStructuredHeaders,
  type StructuredFieldRegistryEntry
} from "@enterprise-hub/domain";
import { parse as createCsvParser } from "csv-parse";
import { CalamineSourceError, streamCalamineXlsxFileRows } from "./calamine-reader.js";

const HEADER_SCAN_ROWS = 10;
const PARTITION_WRITE_BUFFER_BYTES = 256 * 1024;

export interface StructuredPartitionLimits {
  maxSourceBytes: number;
  maxRows: number;
  maxPartitions: number;
  maxCanonicalBytes: number;
  maxOpenFiles: number;
  maxStructuredCellChars: number;
  maxXlsxSheets: number;
  maxXlsxUncompressedBytes: number;
  maxXlsxZipEntries: number;
  maxXlsxCompressionRatio: number;
}

export interface StructuredPartitionExportEntry {
  storeKey: string;
  merchantId: string | null;
  storeName: string;
  businessDate: string;
  rowCount: bigint;
  filePath: string;
  byteSize: bigint;
  checksumSha256: string;
}

export interface StructuredPartitionExport {
  totalRowCount: bigint;
  partitions: StructuredPartitionExportEntry[];
  profile: StructuredPartitionExportProfile;
}

export interface StructuredPartitionExportProfile {
  sourceFormat: "csv" | "xlsx";
  totalMs: number;
  prepareMs: number;
  structureReadMs: number;
  mergeScanMs: number;
  rowDecodeMs: number;
  rowRoutingMs: number;
  canonicalizeMs: number;
  partitionWriteMs: number;
  partitionFlushCount: number;
  finalizeMs: number;
}

interface SourceRow {
  rowNumber: number;
  cells: string[];
}

interface PartitionState {
  storeKey: string;
  merchantId: string | null;
  storeName: string;
  businessDate: string;
  rowCount: bigint;
  filePath: string;
  byteSize: bigint;
  hash: ReturnType<typeof createHash>;
  initialized: boolean;
}

export class StructuredPartitionExportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StructuredPartitionExportError";
    this.code = code;
  }
}

export async function exportStructuredPartitions(input: {
  dataset: "business" | "dishes";
  sourcePath: string;
  outputDirectory: string;
  limits: StructuredPartitionLimits;
  signal?: AbortSignal;
  xlsxReaderCommand?: readonly string[];
}): Promise<StructuredPartitionExport> {
  const profileStarted = performance.now();
  validateLimits(input.limits);
  throwIfAborted(input.signal);
  const source = await stat(input.sourcePath);
  if (!source.isFile()) throw invalidSource("Partition source must be a regular file.");
  if (source.size > input.limits.maxSourceBytes) throw limitExceeded("source bytes");

  const candidateDirectory = path.join(input.outputDirectory, "candidates");
  await rm(candidateDirectory, { force: true, recursive: true });
  await mkdir(candidateDirectory, { recursive: true });

  const registry = getStructuredRegistry(input.dataset);
  const fields = registry.fields.filter((field) => field.inputSource === "file");
  const fieldByName = new Map(fields.map((field) => [field.canonicalName, field]));
  const headerBytes = `${fields.map((field) => csvCell(field.sourceColumn)).join(",")}\n`;
  const partitions = new Map<string, PartitionState>();
  const writers = new BoundedFileWriterPool(
    input.limits.maxOpenFiles,
    PARTITION_WRITE_BUFFER_BYTES
  );
  let totalRowCount = 0n;
  let totalCanonicalBytes = 0n;
  let canonicalizeMs = 0;

  const processDataRow = async (
    row: SourceRow,
    header: {
      width: number;
      mappings: Array<{ canonicalName: string; sourceColumnIndex: number }>;
    }
  ): Promise<void> => {
    if (!row.cells.some((cell) => cell.trim()) || isSummary(row.cells)) return;
    if (
      row.cells.length > header.width &&
      row.cells.slice(header.width).some((cell) => cell.trim())
    )
      throw invalidSource(`Row ${row.rowNumber} has data outside the resolved header width.`);

    const canonicalStarted = performance.now();
    const canonical = new Map<string, string>();
    for (const mapping of header.mappings) {
      const field = fieldByName.get(mapping.canonicalName);
      if (!field) throw invalidSource("Resolved partition field is not registered.");
      canonical.set(
        mapping.canonicalName,
        canonicalCell(field, row.cells[mapping.sourceColumnIndex] ?? "", row.rowNumber)
      );
    }
    canonicalizeMs += performance.now() - canonicalStarted;

    const identity = partitionStoreIdentity({
      merchantId: canonical.get("merchant_id"),
      storeName: canonical.get("store_name")
    });
    const businessDate = canonical.get("business_date");
    if (!businessDate) throw invalidSource(`Row ${row.rowNumber} business date is required.`);
    const identityKey = `${identity.storeKey}\u0000${businessDate}`;
    let partition = partitions.get(identityKey);

    if (!partition) {
      if (partitions.size >= input.limits.maxPartitions) throw limitExceeded("partition count");
      partition = {
        ...identity,
        businessDate,
        rowCount: 0n,
        filePath: path.join(
          candidateDirectory,
          `${createHash("sha256").update(identityKey).digest("hex")}.csv`
        ),
        byteSize: 0n,
        hash: createHash("sha256"),
        initialized: false
      };
      partitions.set(identityKey, partition);
    } else if (
      partition.storeName &&
      identity.storeName &&
      partition.storeName !== identity.storeName
    ) {
      throw new StructuredPartitionExportError(
        PARTITION_ERROR_CODES.storeIdentityConflict,
        `Rows for merchant ${identity.merchantId ?? "fallback"} disagree on store name.`
      );
    } else if (!partition.storeName && identity.storeName) {
      partition.storeName = identity.storeName;
    }

    totalRowCount += 1n;
    if (totalRowCount > BigInt(input.limits.maxRows)) throw limitExceeded("row count");

    if (!partition.initialized) {
      await writers.write(partition.filePath, headerBytes);
      partition.hash.update(headerBytes);
      partition.byteSize += BigInt(Buffer.byteLength(headerBytes));
      totalCanonicalBytes += BigInt(Buffer.byteLength(headerBytes));
      partition.initialized = true;
    }

    const line = `${fields.map((field) => csvCell(canonical.get(field.canonicalName) ?? "")).join(",")}\n`;
    await writers.write(partition.filePath, line);
    partition.hash.update(line);
    const lineBytes = BigInt(Buffer.byteLength(line));
    partition.byteSize += lineBytes;
    partition.rowCount += 1n;
    totalCanonicalBytes += lineBytes;
    if (totalCanonicalBytes > BigInt(input.limits.maxCanonicalBytes))
      throw limitExceeded("canonical bytes");
  };

  const createSheetProcessor = (sheetName: string, hidden: boolean) => {
    let header:
      | {
          rowNumber: number;
          width: number;
          mappings: Array<{ canonicalName: string; sourceColumnIndex: number }>;
        }
      | undefined;
    const buffered: SourceRow[] = [];
    let sawContent = false;

    return {
      async row(row: SourceRow): Promise<void> {
        throwIfAborted(input.signal);
        if (row.cells.some((cell) => cell.trim())) sawContent = true;

        if (!header && row.rowNumber <= HEADER_SCAN_ROWS) {
          buffered.push(row);
          const headers = trimTail(row.cells);
          const resolved = resolveStructuredHeaders(input.dataset, headers);
          if (resolved.ok) {
            header = { rowNumber: row.rowNumber, width: headers.length, mappings: resolved.fields };
            if (hidden) throw invalidSource(`Hidden non-empty sheet ${sheetName} is not allowed.`);
            for (const pending of buffered) {
              if (pending.rowNumber > header.rowNumber) await processDataRow(pending, header);
            }
            buffered.length = 0;
          }
          return;
        }

        if (!header) {
          if (sawContent)
            throw invalidSource(`Sheet ${sheetName} has no recognized ${input.dataset} header.`);
          return;
        }
        await processDataRow(row, header);
      },
      finish(): void {
        if (!sawContent) return;
        if (hidden) throw invalidSource(`Hidden non-empty sheet ${sheetName} is not allowed.`);
        if (!header)
          throw invalidSource(`Sheet ${sheetName} has no recognized ${input.dataset} header.`);
      }
    };
  };

  const processSheet = async (
    rows: AsyncIterable<SourceRow>,
    sheetName: string,
    hidden: boolean
  ): Promise<number> => {
    const processor = createSheetProcessor(sheetName, hidden);
    let consumerMs = 0;
    for await (const row of rows) {
      const consumerStarted = performance.now();
      await processor.row(row);
      consumerMs += performance.now() - consumerStarted;
    }
    const consumerStarted = performance.now();
    processor.finish();
    consumerMs += performance.now() - consumerStarted;
    return consumerMs;
  };

  const prepareMs = performance.now() - profileStarted;
  try {
    const extension = path.extname(input.sourcePath).toLowerCase();
    const sourceFormat = extension === ".csv" ? "csv" : "xlsx";
    let structureReadMs = 0;
    let mergeScanMs = 0;
    let rowDecodeMs = 0;
    let rowConsumerMs = 0;
    if (extension === ".csv") {
      const rowScanStarted = performance.now();
      rowConsumerMs = await processSheet(
        csvRows(input.sourcePath, input.limits.maxStructuredCellChars),
        "Sheet1",
        false
      );
      rowDecodeMs = Math.max(0, performance.now() - rowScanStarted - rowConsumerMs);
    } else if (extension === ".xlsx") {
      let processor: ReturnType<typeof createSheetProcessor> | undefined;
      let xlsxProfile;
      try {
        xlsxProfile = await streamCalamineXlsxFileRows({
          filePath: input.sourcePath,
          limits: input.limits,
          signal: input.signal,
          command: input.xlsxReaderCommand,
          consumer: {
            startSheet(sheet) {
              processor = createSheetProcessor(sheet.name, sheet.hidden);
            },
            async row(_sheet, rowNumber, cells) {
              await processor!.row({ rowNumber, cells });
            },
            endSheet() {
              processor!.finish();
              processor = undefined;
            }
          }
        });
      } catch (error) {
        if (error instanceof CalamineSourceError) throw invalidSource(error.message);
        throw error;
      }
      structureReadMs = xlsxProfile.structureReadMs;
      mergeScanMs = xlsxProfile.mergeScanMs;
      rowDecodeMs = xlsxProfile.rowDecodeMs;
      rowConsumerMs = xlsxProfile.consumerMs;
    } else {
      throw invalidSource("Partition source must be CSV or XLSX.");
    }

    if (totalRowCount === 0n) throw invalidSource("Partition source contains no data rows.");
    const finalizeStarted = performance.now();
    const rowPartitionWriteMs = writers.elapsedMs;
    const writeMsBeforeClose = writers.elapsedMs;
    await writers.closeAll();
    const closeWriteMs = writers.elapsedMs - writeMsBeforeClose;
    const exportedPartitions = [...partitions.values()]
      .sort(
        (left, right) =>
          left.businessDate.localeCompare(right.businessDate) ||
          left.storeKey.localeCompare(right.storeKey)
      )
      .map((partition) => ({
        storeKey: partition.storeKey,
        merchantId: partition.merchantId,
        storeName: partition.storeName,
        businessDate: partition.businessDate,
        rowCount: partition.rowCount,
        filePath: partition.filePath,
        byteSize: partition.byteSize,
        checksumSha256: partition.hash.digest("hex")
      }));
    const finalizeMs = Math.max(0, performance.now() - finalizeStarted - closeWriteMs);
    const partitionWriteMs = writers.elapsedMs;
    return {
      totalRowCount,
      partitions: exportedPartitions,
      profile: {
        sourceFormat,
        totalMs: roundedMs(performance.now() - profileStarted),
        prepareMs: roundedMs(prepareMs),
        structureReadMs: roundedMs(structureReadMs),
        mergeScanMs: roundedMs(mergeScanMs),
        rowDecodeMs: roundedMs(rowDecodeMs),
        rowRoutingMs: roundedMs(Math.max(0, rowConsumerMs - canonicalizeMs - rowPartitionWriteMs)),
        canonicalizeMs: roundedMs(canonicalizeMs),
        partitionWriteMs: roundedMs(partitionWriteMs),
        partitionFlushCount: writers.flushCount,
        finalizeMs: roundedMs(finalizeMs)
      }
    };
  } catch (error) {
    await writers.abortAll().catch(() => undefined);
    await rm(candidateDirectory, { force: true, recursive: true });
    await mkdir(candidateDirectory, { recursive: true });
    throw error;
  }
}

async function* csvRows(filePath: string, maxCellChars: number): AsyncGenerator<SourceRow> {
  const parser = createReadStream(filePath).pipe(
    createCsvParser({ bom: true, relax_column_count: true, skip_empty_lines: false })
  );
  let rowNumber = 0;
  for await (const record of parser as AsyncIterable<unknown[]>) {
    rowNumber += 1;
    yield { rowNumber, cells: record.map((value) => checkedText(String(value), maxCellChars)) };
  }
}

function canonicalCell(
  field: StructuredFieldRegistryEntry,
  value: string,
  rowNumber: number
): string {
  const text = value.trim();
  if (!text) {
    if (!field.nullable)
      throw invalidSource(`Row ${rowNumber} ${field.canonicalName} is required.`);
    return "";
  }
  if (field.type === "integer") {
    if (!/^[+-]?\d+$/.test(text))
      throw invalidSource(`Row ${rowNumber} ${field.canonicalName} must be an integer.`);
    const number = Number(text);
    if (!Number.isSafeInteger(number))
      throw invalidSource(`Row ${rowNumber} ${field.canonicalName} must be a safe integer.`);
    return String(number);
  }
  if (field.type === "decimal" || field.type === "percent") {
    const numeric = field.type === "percent" && text.endsWith("%") ? text.slice(0, -1) : text;
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(numeric))
      throw invalidSource(`Row ${rowNumber} ${field.canonicalName} must be numeric.`);
    return canonicalDecimal(numeric);
  }
  if (field.type === "date" || field.type === "date_time") {
    const parsed = parseDateText(text, field.type === "date_time");
    if (!parsed) throw invalidSource(`Row ${rowNumber} ${field.canonicalName} must be a date.`);
    return parsed;
  }
  return text;
}

function parseDateText(text: string, requireTime: boolean): string | null {
  const match =
    /^(\d{4})(?:(\d{2})(\d{2})|-(\d{2})-(\d{2})|\/(\d{2})\/(\d{2}))(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      text
    );
  if (!match || (requireTime && match[8] === undefined)) return null;
  const year = Number(match[1]);
  const month = Number(match[2] ?? match[4] ?? match[6]);
  const day = Number(match[3] ?? match[5] ?? match[7]);
  const hour = Number(match[8] ?? 0);
  const minute = Number(match[9] ?? 0);
  const second = Number(match[10] ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  const result = formatDate(date);
  return requireTime ? `${result} ${two(hour)}:${two(minute)}:${two(second)}` : result;
}

function canonicalDecimal(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "");
  const [integerRaw = "0", fractionRaw = ""] = unsigned.split(".");
  const integer = integerRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.replace(/0+$/, "");
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function checkedText(value: string, maximum: number): string {
  if (value.length > maximum) throw invalidSource("Structured cell length limit exceeded.");
  return value.trim();
}

function trimTail(row: string[]): string[] {
  const trimmed = [...row];
  while (trimmed.length > 0 && !trimmed.at(-1)?.trim()) trimmed.pop();
  return trimmed;
}

function isSummary(row: string[]): boolean {
  return ["合计", "总计"].includes(row[0]?.trim() ?? "");
}

function formatDate(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function roundedMs(value: number): number {
  return Number(value.toFixed(1));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Partition export was aborted.");
  error.name = "AbortError";
  throw error;
}

function invalidSource(message: string): StructuredPartitionExportError {
  return new StructuredPartitionExportError("PARTITION_SOURCE_INVALID", message);
}

function limitExceeded(limit: string): StructuredPartitionExportError {
  return new StructuredPartitionExportError(
    PARTITION_ERROR_CODES.limitExceeded,
    `Partition ${limit} limit exceeded.`
  );
}

function validateLimits(limits: StructuredPartitionLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive safe integer.`);
  }
}

interface BufferedFileHandle {
  handle: FileHandle;
  chunks: string[];
  byteLength: number;
}

class BoundedFileWriterPool {
  private readonly handles = new Map<string, BufferedFileHandle>();
  elapsedMs = 0;
  flushCount = 0;

  constructor(
    private readonly maximum: number,
    private readonly flushThresholdBytes: number
  ) {}

  async write(filePath: string, bytes: string): Promise<void> {
    const startedAt = performance.now();
    try {
      const entry = await this.handleFor(filePath);
      entry.chunks.push(bytes);
      entry.byteLength += Buffer.byteLength(bytes);
      if (entry.byteLength >= this.flushThresholdBytes) await this.flush(entry);
    } finally {
      this.elapsedMs += performance.now() - startedAt;
    }
  }

  async closeAll(): Promise<void> {
    const startedAt = performance.now();
    const entries = [...this.handles.values()];
    this.handles.clear();
    try {
      await Promise.all(
        entries.map(async (entry) => {
          try {
            await this.flush(entry);
          } finally {
            await entry.handle.close();
          }
        })
      );
    } finally {
      this.elapsedMs += performance.now() - startedAt;
    }
  }

  async abortAll(): Promise<void> {
    const entries = [...this.handles.values()];
    this.handles.clear();
    for (const entry of entries) {
      entry.chunks.length = 0;
      entry.byteLength = 0;
    }
    await Promise.all(entries.map((entry) => entry.handle.close()));
  }

  private async handleFor(filePath: string): Promise<BufferedFileHandle> {
    const existing = this.handles.get(filePath);
    if (existing) {
      this.handles.delete(filePath);
      this.handles.set(filePath, existing);
      return existing;
    }
    if (this.handles.size >= this.maximum) {
      const oldestPath = this.handles.keys().next().value as string | undefined;
      if (oldestPath) {
        const oldest = this.handles.get(oldestPath)!;
        this.handles.delete(oldestPath);
        try {
          await this.flush(oldest);
        } finally {
          await oldest.handle.close();
        }
      }
    }
    const handle = await open(filePath, "a");
    const entry = { handle, chunks: [], byteLength: 0 };
    this.handles.set(filePath, entry);
    return entry;
  }

  private async flush(entry: BufferedFileHandle): Promise<void> {
    if (entry.byteLength === 0) return;
    const bytes = entry.chunks.join("");
    entry.chunks.length = 0;
    entry.byteLength = 0;
    await entry.handle.write(bytes);
    this.flushCount += 1;
  }
}
