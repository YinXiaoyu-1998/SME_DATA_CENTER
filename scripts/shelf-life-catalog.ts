import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { ShelfLifeValidationError } from "@smedc/domain";
import { assertLedgerCliDatabase, LedgerCliUsageError } from "./ledger-pdf-support.js";
import { parseShelfLifeArgs } from "./ledger-shelf-life-support.js";
import {
  importShelfLifeCatalog,
  parseShelfLifeCsv,
  shelfLifeCatalogHelp
} from "./shelf-life-catalog-support.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && ["--help", "help"].includes(argv[0]!)) {
    console.log(shelfLifeCatalogHelp);
    return;
  }
  const command = parseShelfLifeArgs(argv);
  loadDotenv({ quiet: true, override: false });
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new LedgerCliUsageError("DATABASE_URL is required.");
  const environment = assertLedgerCliDatabase(databaseUrl, command.allowRemote);
  const bytes = await readFile(command.input);
  if (bytes.length > 2 * 1024 * 1024) throw new LedgerCliUsageError("Catalog input exceeds 2 MiB.");
  let csv: string;
  try {
    csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LedgerCliUsageError("Input must be valid UTF-8 CSV.");
  }
  const entries = parseShelfLifeCsv(csv);
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  try {
    console.log(
      JSON.stringify({ environment, ...(await importShelfLifeCatalog(prisma, command, entries)) })
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        error:
          error instanceof LedgerCliUsageError || error instanceof ShelfLifeValidationError
            ? error.message
            : "SHELF_LIFE_CATALOG_CLI_FAILED"
      })
    );
    process.exitCode = 1;
  });
}
