import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { profileStructuredWorkbook } from "../apps/worker/src/structured/profile-workbook.js";
import { STRUCTURED_DATASETS, type StructuredDatasetName } from "@enterprise-hub/domain";

const [, , datasetArg, filePath] = process.argv;

if (!datasetArg || !filePath || !isStructuredDataset(datasetArg)) {
  console.error("Usage: tsx scripts/profile-structured-workbook.ts <dishes|business> <xlsx-path>");
  process.exit(1);
}

const profile = profileStructuredWorkbook({
  dataset: datasetArg,
  fileName: basename(filePath),
  content: await readFile(filePath)
});

console.log(JSON.stringify(profile, null, 2));

function isStructuredDataset(value: string): value is StructuredDatasetName {
  return (STRUCTURED_DATASETS as readonly string[]).includes(value);
}
