import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { profileStructuredFile } from "@smedc/structured-ingestion";
import { PHASE3_RUNTIME_LIMIT_DEFAULTS } from "@smedc/domain";
import { STRUCTURED_DATASETS, type StructuredDatasetName } from "@smedc/domain";

const [, , datasetArg, filePath] = process.argv;

if (!datasetArg || !filePath || !isStructuredDataset(datasetArg)) {
  console.error("Usage: tsx scripts/profile-structured-workbook.ts <dishes|business> <xlsx-path>");
  process.exit(1);
}

const profile = await profileStructuredFile({
  dataset: datasetArg,
  fileName: basename(filePath),
  content: await readFile(filePath),
  fileType: "xlsx",
  limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
});

console.log(JSON.stringify(profile, null, 2));

function isStructuredDataset(value: string): value is StructuredDatasetName {
  return (STRUCTURED_DATASETS as readonly string[]).includes(value);
}
