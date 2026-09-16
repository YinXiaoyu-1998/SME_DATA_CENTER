import { performance } from "node:perf_hooks";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPartitionDataset, type PartitionDatasetName } from "@smedc/domain";
import {
  exportStructuredPartitions,
  type StructuredPartitionExportProfile
} from "@smedc/structured-ingestion";

export interface PartitionSourceProfile {
  sourceBytes: number;
  totalRows: number;
  dateMin: string;
  dateMax: string;
  distinctStores: number;
  partitionCount: number;
  canonicalBytes: number;
  peakRssBytes: number;
  elapsedMs: number;
  sourceExportProfile: StructuredPartitionExportProfile;
}

export async function profilePartitionSource(input: {
  dataset: PartitionDatasetName;
  sourcePath: string;
  xlsxReaderCommand?: readonly string[];
}): Promise<PartitionSourceProfile> {
  if (!path.isAbsolute(input.sourcePath)) throw new Error("sourcePath must be absolute.");
  const source = await stat(input.sourcePath);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "enterprise-hub-partition-profile-"));
  let peakRssBytes = process.memoryUsage().rss;
  const started = performance.now();
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 25);

  try {
    const result = await exportStructuredPartitions({
      dataset: input.dataset,
      sourcePath: input.sourcePath,
      outputDirectory: temporaryRoot,
      xlsxReaderCommand: input.xlsxReaderCommand,
      limits: {
        maxSourceBytes: 2_147_483_648,
        maxRows: 5_000_000,
        maxPartitions: 10_000,
        maxCanonicalBytes: 8_589_934_592,
        maxOpenFiles: 32,
        maxStructuredCellChars: 32_767,
        maxXlsxSheets: 20,
        maxXlsxUncompressedBytes: 8_589_934_592,
        maxXlsxZipEntries: 10_000,
        maxXlsxCompressionRatio: 100
      }
    });
    const dates = result.partitions.map((partition) => partition.businessDate).sort();
    const canonicalBytes = result.partitions.reduce(
      (total, partition) => total + partition.byteSize,
      0n
    );
    return {
      sourceBytes: source.size,
      totalRows: Number(result.totalRowCount),
      dateMin: dates[0]!,
      dateMax: dates.at(-1)!,
      distinctStores: new Set(result.partitions.map((partition) => partition.storeKey)).size,
      partitionCount: result.partitions.length,
      canonicalBytes: Number(canonicalBytes),
      peakRssBytes,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      sourceExportProfile: result.profile
    };
  } finally {
    clearInterval(sampler);
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const [, , dataset, sourcePath] = process.argv;
  if (!dataset || !sourcePath || !isPartitionDataset(dataset) || !path.isAbsolute(sourcePath)) {
    throw new Error(
      "Usage: npm run profile:partitions -- <business|dishes> <absolute-source-path>"
    );
  }
  console.log(JSON.stringify(await profilePartitionSource({ dataset, sourcePath }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
