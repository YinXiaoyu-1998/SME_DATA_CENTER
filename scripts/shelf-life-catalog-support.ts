import { type PrismaClient } from "@prisma/client";
import { parse } from "csv-parse/sync";
import {
  parseShelfLifeEntries,
  ShelfLifeValidationError,
  type ShelfLifeEntry
} from "@smedc/domain";
import { planShelfLifeCatalogUpdate, upsertShelfLifeCatalog } from "@smedc/db";
import { lockLedgerSourceMutation } from "@smedc/ledger-archive";
import { LedgerCliUsageError } from "./ledger-pdf-support.js";

export const shelfLifeCatalogHelp = `Usage: npm run shelf-life:catalog -- --org-id <id> --org-name <exact-name> --input <catalog.csv>
  [--dry-run | --execute --operator <label>] [--allow-remote]

CSV requires exactly two columns: 物品名,保质期 (UTF-8, optional BOM).
Default: dry-run. Exact names include case, width and whitespace.
Execute merges entries with transactional before/after audits; absent names remain.
Only future delivery receipt imports use these values. Existing ledger rows stay unchanged.
`;

export function parseShelfLifeCsv(csv: string): ShelfLifeEntry[] {
  let rows: string[][];
  try {
    rows = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 8192 }) as string[][];
  } catch {
    throw new LedgerCliUsageError("Input must be valid two-column UTF-8 CSV.");
  }
  const header = rows.shift();
  if (header?.length !== 2 || header[0] !== "物品名" || header[1] !== "保质期")
    throw new LedgerCliUsageError("CSV headers must be exactly 物品名,保质期.");
  try {
    return parseShelfLifeEntries(rows.map((row) => ({ itemName: row[0], shelfLife: row[1] })));
  } catch (error) {
    if (error instanceof ShelfLifeValidationError) throw new LedgerCliUsageError(error.message);
    throw error;
  }
}

/** Internal operator entrypoint. Future upload handlers reuse the domain/DB layer with their actor. */
export async function importShelfLifeCatalog(
  prisma: PrismaClient,
  command: { orgId: string; orgName: string; execute: boolean; operator?: string },
  input: readonly ShelfLifeEntry[]
) {
  const entries = parseShelfLifeEntries(input);
  if (command.execute && (!command.operator?.trim() || command.operator.length > 255))
    throw new LedgerCliUsageError("Execute requires an operator label (max 255 characters).");
  return prisma.$transaction(
    async (tx) => {
      await lockLedgerSourceMutation(tx, command.orgId);
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: command.orgId }
      });
      if (organization.name !== command.orgName)
        throw new LedgerCliUsageError("Organization ID/name mismatch.");
      const plan = await (command.execute ? upsertShelfLifeCatalog : planShelfLifeCatalogUpdate)(
        tx,
        command.orgId,
        entries
      );
      if (command.execute) {
        for (let offset = 0; offset < plan.changes.length; offset += 500) {
          await tx.auditLog.createMany({
            data: plan.changes.slice(offset, offset + 500).map((change) => ({
              orgId: command.orgId,
              action: "shelf_life_catalog.upsert",
              targetType: "shelf_life_catalog_entry",
              clientSource: "operator_cli",
              metadata: { operator: command.operator!, ...change }
            }))
          });
        }
      }
      return {
        mode: command.execute ? "execute" : "dry-run",
        orgId: command.orgId,
        orgName: organization.name,
        entryCount: entries.length,
        ...plan
      };
    },
    { maxWait: 10000, timeout: 120000 }
  );
}
