import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { assertLedgerCliDatabase, LedgerCliUsageError } from "./ledger-pdf-support.js";
import {
  parseShelfLifeArgs,
  parseShelfLifeMappings,
  shelfLifeHelp,
  updateLedgerShelfLife
} from "./ledger-shelf-life-support.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && ["--help", "help"].includes(argv[0]!)) {
    console.log(shelfLifeHelp);
    return;
  }
  const command = parseShelfLifeArgs(argv);
  loadDotenv({ quiet: true, override: false });
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new LedgerCliUsageError("DATABASE_URL is required.");
  const environment = assertLedgerCliDatabase(databaseUrl, command.allowRemote);
  const bytes = await readFile(command.input);
  if (bytes.length > 2 * 1024 * 1024) throw new LedgerCliUsageError("Mapping input exceeds 2 MiB.");
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new LedgerCliUsageError("Input must be valid UTF-8 JSON.");
  }
  const mappings = parseShelfLifeMappings(input);
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  try {
    const result = await updateLedgerShelfLife(prisma, command, mappings);
    console.log(JSON.stringify({ environment, ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Driver/file errors can contain credentials or private paths; only domain/usage messages are safe.
    const message =
      error instanceof LedgerCliUsageError
        ? error.message
        : error instanceof Error && /^LEDGER_[A-Z_]+$/.test(error.message)
          ? error.message
          : "LEDGER_SHELF_LIFE_CLI_FAILED";
    console.error(JSON.stringify({ error: message }));
    process.exitCode = 1;
  });
}
