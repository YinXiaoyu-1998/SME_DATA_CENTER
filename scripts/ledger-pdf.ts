import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import {
  createLedgerArchiveService,
  createPrismaLedgerArchiveRepository
} from "@smedc/ledger-archive";
import { AliyunOssStorageAdapter, createStorageAdapter } from "@smedc/storage";
import {
  createPrismaLedgerReconciliation,
  ledgerNeedsRepair
} from "@smedc/ledger-archive/reconciliation";
import {
  assertLedgerCliDatabase,
  ledgerCliHelp,
  LedgerCliUsageError,
  parseLedgerCliArgs,
  runLedgerCli
} from "./ledger-pdf-support.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) {
    console.log(ledgerCliHelp);
    return 0;
  }
  loadDotenv({ quiet: true, override: false });
  const command = parseLedgerCliArgs(argv);
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new LedgerCliUsageError("DATABASE_URL is required.");
  const environment = assertLedgerCliDatabase(databaseUrl, command.allowRemote);
  // Instantiate configured storage only to obtain its trusted physical prefix. No I/O.
  const storage = command.kind === "status" ? null : createStorageAdapter();
  const objectKeyPrefix = storage instanceof AliyunOssStorageAdapter ? storage.keyPrefix : "";
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    console.log(JSON.stringify({ environment, orgId: command.orgId, command: command.kind }));
    const archive = createLedgerArchiveService(
      createPrismaLedgerArchiveRepository({ prisma, objectKeyPrefix })
    );
    const reconciliation = createPrismaLedgerReconciliation({ prisma, objectKeyPrefix });
    return await runLedgerCli(command, {
      archive,
      now: () => new Date(),
      output: (value) => console.log(JSON.stringify(value)),
      signal: controller.signal,
      inspectPartition: async (key) => {
        const { partition, source } = await reconciliation.repository.observe(key);
        const head = partition?.currentObjectKey
          ? await storage!.headObject(partition.currentObjectKey)
          : undefined;
        return ledgerNeedsRepair(partition, source, head);
      }
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Driver/provider errors may include credentials. Show only safe usage/domain errors.
      const code =
        error instanceof LedgerCliUsageError
          ? error.message
          : error instanceof Error && /^LEDGER_[A-Z_]+$/.test(error.message)
            ? error.message
            : "LEDGER_CLI_FAILED";
      console.error(JSON.stringify({ error: code }));
      process.exitCode = 1;
    });
}
