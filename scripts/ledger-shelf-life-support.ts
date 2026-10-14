import { parseShelfLifeEntries, ShelfLifeValidationError } from "@smedc/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ledgerPartitionsFromRows,
  lockLedgerSourceMutation,
  markLedgerPartitionsChanged
} from "@smedc/ledger-archive";
import { LedgerCliUsageError } from "./ledger-pdf-support.js";

export type ShelfLifeMapping = { itemName: string; shelfLife: string };
type UpdateCommand = { orgId: string; orgName: string; execute: boolean; operator?: string };
export type ShelfLifeCommand = UpdateCommand & { input: string; allowRemote: boolean };

export const shelfLifeHelp = `Usage: npm run ledger:shelf-life -- --org-id <id> --org-name <exact-name> --input <mapping.json>
  [--dry-run | --execute --operator <label>] [--allow-remote]

JSON input: [{"itemName":"加多宝","shelfLife":"24月"}]
Default: dry-run. DATABASE_URL comes from the environment or local .env.
Only active documents with applied, unarchived delivery-ledger imports are eligible.
Names match exactly, including case, width and whitespace. Duplicate conflicting
names are rejected. No XLSX layout or time unit is assumed; shelfLife is stored as given.
Output: totalRows, matchedRows, changedRows, updatedRows and affectedPartitions.
Execute atomically updates values, records before/after audits and bumps PDF revisions.
No PDF jobs are submitted. Scheduled reconciliation handles regeneration.
`;

export function parseShelfLifeMappings(input: unknown): ShelfLifeMapping[] {
  try {
    return parseShelfLifeEntries(input);
  } catch (error) {
    if (error instanceof ShelfLifeValidationError) throw new LedgerCliUsageError(error.message);
    throw error;
  }
}

export function parseShelfLifeArgs(argv: readonly string[]): ShelfLifeCommand {
  const valueFlags = new Set(["--org-id", "--org-name", "--input", "--operator"]);
  const booleanFlags = new Set(["--execute", "--dry-run", "--allow-remote"]);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (values.has(flag) || flags.has(flag)) throw new LedgerCliUsageError("Duplicate option.");
    if (booleanFlags.has(flag)) {
      flags.add(flag);
      continue;
    }
    if (!valueFlags.has(flag)) throw new LedgerCliUsageError("Unknown option.");
    const value = argv[++index];
    if (!value?.trim() || value.startsWith("--"))
      throw new LedgerCliUsageError("Missing option value.");
    values.set(flag, value);
  }
  const required = (flag: string, max: number) => {
    const value = values.get(flag);
    if (!value || value.length > max)
      throw new LedgerCliUsageError(`${flag} is required (max ${max} characters).`);
    return value;
  };
  const execute = flags.has("--execute");
  if (execute && flags.has("--dry-run"))
    throw new LedgerCliUsageError("Choose --dry-run or --execute.");
  return {
    orgId: required("--org-id", 64),
    orgName: required("--org-name", 255),
    input: required("--input", 4096),
    execute,
    allowRemote: flags.has("--allow-remote"),
    ...(execute ? { operator: required("--operator", 255) } : {})
  };
}

/** Internal operator maintenance, scoped to one explicitly verified organization. */
export async function updateLedgerShelfLife(
  prisma: PrismaClient,
  command: UpdateCommand,
  input: readonly ShelfLifeMapping[]
) {
  const mappings = parseShelfLifeMappings(input);
  if (command.execute && (!command.operator?.trim() || command.operator.length > 255))
    throw new LedgerCliUsageError("Execute requires an operator label (max 255 characters).");
  return prisma.$transaction(
    async (tx) => {
      // Same lock/order as ingestion, source archival and PDF publication.
      await lockLedgerSourceMutation(tx, command.orgId);
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: command.orgId }
      });
      if (organization.name !== command.orgName)
        throw new LedgerCliUsageError("Organization ID/name mismatch.");
      const scope = Prisma.sql`r.org_id = ${command.orgId}
      AND d.org_id = r.org_id AND d.status = 'active' AND d.archived_at IS NULL
      AND b.org_id = r.org_id AND b.dataset = 'delivery_ledger'
      AND b.status = 'applied' AND b.archived_at IS NULL`;
      const from = Prisma.sql`delivery_ledger_rows r
      JOIN documents d ON d.id = r.source_document_id
      JOIN import_batches b ON b.id = r.import_batch_id AND b.source_document_id = r.source_document_id`;
      const [count] = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT COUNT(*) AS total FROM ${from} WHERE ${scope}`);
      const rows = await tx.$queryRaw<{ id: string; payload: Prisma.JsonObject }[]>(Prisma.sql`
      SELECT r.id, r.payload FROM ${from} WHERE ${scope}
      AND JSON_TYPE(JSON_EXTRACT(r.payload, '$.item_name')) = 'STRING'
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.item_name')) AS BINARY)
        IN (${Prisma.join(mappings.map((m) => Prisma.sql`CAST(${m.itemName} AS BINARY)`))})
      ORDER BY r.id`);
      const desired = new Map(mappings.map((m) => [m.itemName, m.shelfLife]));
      const matched = rows.filter(
        (row) =>
          typeof row.payload["item_name"] === "string" && desired.has(row.payload["item_name"])
      );
      const changes = matched.filter(
        (row) => row.payload["shelf_life"] !== desired.get(row.payload["item_name"] as string)
      );
      const keys = ledgerPartitionsFromRows(command.orgId, changes);
      let updatedRows = 0;
      if (command.execute && changes.length) {
        for (const mapping of mappings) {
          const itemRows = changes.filter((row) => row.payload["item_name"] === mapping.itemName);
          for (let offset = 0; offset < itemRows.length; offset += 200) {
            const page = itemRows.slice(offset, offset + 200);
            const updated = await tx.$executeRaw(Prisma.sql`
            UPDATE delivery_ledger_rows SET payload = JSON_SET(payload, '$.shelf_life', ${mapping.shelfLife})
            WHERE org_id = ${command.orgId} AND id IN (${Prisma.join(page.map((row) => row.id))})`);
            if (updated !== page.length) throw new Error("LEDGER_SHELF_LIFE_UPDATE_CONFLICT");
            updatedRows += updated;
            await tx.auditLog.createMany({
              data: page.map((row) => ({
                orgId: command.orgId,
                action: "ledger.shelf_life.update",
                targetType: "delivery_ledger_row",
                targetId: row.id,
                clientSource: "operator_cli",
                metadata: {
                  operator: command.operator!,
                  itemName: mapping.itemName,
                  beforePresent: Object.hasOwn(row.payload, "shelf_life"),
                  before: row.payload["shelf_life"] ?? null,
                  after: mapping.shelfLife
                }
              }))
            });
          }
        }
        await markLedgerPartitionsChanged(tx, keys);
      }
      return {
        mode: command.execute ? "execute" : "dry-run",
        orgId: organization.id,
        orgName: organization.name,
        mappingCount: mappings.length,
        totalRows: Number(count?.total ?? 0),
        matchedRows: matched.length,
        changedRows: changes.length,
        updatedRows,
        affectedPartitions: keys.length,
        unmatchedItemNames: mappings
          .filter((m) => !matched.some((row) => row.payload["item_name"] === m.itemName))
          .map((m) => m.itemName)
      };
    },
    { maxWait: 10000, timeout: 120000 }
  );
}
