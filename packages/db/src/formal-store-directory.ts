import { Prisma } from "@prisma/client";

type DirectoryTransaction = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Resolve inside the transaction that publishes or writes the resource. The lock
 * is held until that transaction ends, so a concurrent rename or confirmation
 * cannot make a previously checked name stale at publication time.
 *
 * `storeKey` is the immutable pre-directory authorization/partition key, never
 * an import alias. The caller remains responsible for existing retired-store and
 * historical-supplement policy.
 */
export async function resolveFormalStore(
  tx: DirectoryTransaction,
  input: { orgId: string; enterpriseKey: string; name: string }
): Promise<{ storeId: string; storeKey: string; retired: boolean } | null> {
  if (!input.name.trim()) return null;
  const rows = await tx.$queryRaw<
    Array<{ storeId: string; storeKey: string; retired: boolean; confirmation: string }>
  >(Prisma.sql`
    SELECT store_id AS storeId, name AS storeKey, retired, confirmation
    FROM business_stores
    WHERE org_id = ${input.orgId}
      AND enterprise_key = ${input.enterpriseKey}
      AND BINARY official_name = BINARY ${input.name}
    FOR SHARE
  `);
  const row = rows[0];
  if (!row || row.confirmation !== "confirmed") return null;
  return { storeId: row.storeId, storeKey: row.storeKey, retired: Boolean(row.retired) };
}
