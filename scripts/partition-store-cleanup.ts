import { open, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import {
  assertStoreCleanupRuntime,
  createStoreCleanupRepository,
  normalizeStoreCleanupScope,
  parseStoreCleanupArgs,
  type StoreCleanupInventory
} from "./partition-store-cleanup-support.js";

export async function saveStoreCleanupInventory(path: string, inventory: StoreCleanupInventory) {
  // Exclusive creation refuses symlinks and prevents accidental overwrite of a reviewed preview.
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(inventory, null, 2) + "\n");
  } finally {
    await file.close();
  }
}
export async function runStoreCleanupCli(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const { execute, values } = parseStoreCleanupArgs(argv);
  assertStoreCleanupRuntime(env);
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(env["DATABASE_URL"]!) });
  try {
    const repository = createStoreCleanupRepository(prisma);
    if (execute) {
      const inventory = JSON.parse(
        await readFile(values["inventory"]!, "utf8")
      ) as StoreCleanupInventory;
      if (inventory.scope?.orgId !== values["org-id"])
        throw new Error("STORE_CLEANUP_ORGANIZATION_MISMATCH");
      console.log(
        JSON.stringify({
          mode: "execute",
          ...(await repository.executeStoreCleanup({
            inventory,
            expectedFingerprint: values["confirm"]!
          }))
        })
      );
    } else {
      const scope = normalizeStoreCleanupScope({
        orgId: values["org-id"],
        enterpriseName: values["enterprise"],
        datasets: values["datasets"]?.split(","),
        ...(values["store-names"] ? { storeNames: JSON.parse(values["store-names"]) } : {}),
        ...(values["store-name-contains"]
          ? { storeNameContains: JSON.parse(values["store-name-contains"]) }
          : {}),
        startDate: values["start-date"],
        endDate: values["end-date"]
      });
      const inventory = await repository.buildStoreCleanupInventory(scope);
      await saveStoreCleanupInventory(values["inventory"]!, inventory);
      console.log(
        JSON.stringify({
          mode: "dry-run",
          targetPartitionCount: inventory.targets.length,
          preserved: inventory.preserved,
          fingerprint: inventory.fingerprint
        })
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runStoreCleanupCli(process.argv.slice(2));
  } catch (error) {
    const code =
      error instanceof Error && /^STORE_CLEANUP_[A-Z_]+$/.test(error.message)
        ? error.message
        : "STORE_CLEANUP_FAILED";
    console.error(JSON.stringify({ errorCode: code }));
    process.exitCode = 1;
  }
}
