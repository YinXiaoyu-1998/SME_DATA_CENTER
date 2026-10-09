import { Prisma, type PrismaClient } from "@prisma/client";
import {
  enqueueStorageGarbage,
  invalidatePartitionDownloadsForPartitions,
  literalStoreNameScope,
  partitionDownloadFingerprint,
  retryIdempotentDatabaseOperation
} from "@smedc/db";
import { parsePartitionStoreNameContains } from "@smedc/domain";
import { isStagingRuntimeDatabaseUrl } from "./staging-runtime-targets.js";

export interface StoreCleanupScope {
  orgId: string;
  enterpriseName: string;
  datasets: ("business" | "dishes")[];
  storeNames?: string[];
  storeNameContains?: string[];
  startDate?: string;
  endDate?: string;
}
export interface StoreCleanupTarget {
  id: string;
  enterpriseKey: string;
  dataset: "business" | "dishes";
  storeKey: string;
  storeName: string;
  merchantId: string | null;
  publishedByJobId: string;
  updatedAt: string;
  businessDate: string;
  objectKey: string;
  checksumSha256: string;
  confidentialityLevel: number;
  rowCount: string;
  byteSize: string;
}
export interface StoreCleanupInventory {
  version: 1;
  scope: StoreCleanupScope;
  targets: StoreCleanupTarget[];
  preserved: { partitions: number; importJobs: number; employees: number };
  fingerprint: string;
}
const failure = (code: string): never => {
  throw new Error(code);
};
export function normalizeStoreCleanupScope(input: unknown): StoreCleanupScope {
  if (!input || typeof input !== "object") return failure("STORE_CLEANUP_SCOPE_REQUIRED");
  const value = input as StoreCleanupScope;
  const name = (v: unknown, max: number): string => {
    if (typeof v !== "string" || !v.trim() || v.length > max)
      return failure("STORE_CLEANUP_SCOPE_REQUIRED");
    return v.normalize("NFC").trim();
  };
  if (
    !Array.isArray(value.datasets) ||
    !value.datasets.length ||
    value.datasets.some((d) => !["business", "dishes"].includes(d))
  )
    return failure("STORE_CLEANUP_DATASET_INVALID");
  if (Boolean(value.storeNames) === Boolean(value.storeNameContains))
    return failure("STORE_CLEANUP_STORE_SCOPE_REQUIRED");
  const stores = (v: string[] | undefined) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.length || v.length > 20)
      return failure("STORE_CLEANUP_STORE_SCOPE_REQUIRED");
    return [...new Set(v.map((s) => name(s, 255)))].sort();
  };
  const storeNames = stores(value.storeNames);
  const storeNameContains = parsePartitionStoreNameContains(value.storeNameContains);
  for (const date of [value.startDate, value.endDate]) {
    if (
      date !== undefined &&
      (typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date)
    )
      return failure("STORE_CLEANUP_DATE_INVALID");
  }
  if (value.startDate && value.endDate && value.startDate > value.endDate)
    return failure("STORE_CLEANUP_DATE_INVALID");
  return {
    orgId: name(value.orgId, 64),
    enterpriseName: name(value.enterpriseName, 255),
    datasets: [...new Set(value.datasets)].sort(),
    ...(storeNames ? { storeNames } : {}),
    ...(storeNameContains ? { storeNameContains: [...new Set(storeNameContains)].sort() } : {}),
    ...(value.startDate ? { startDate: value.startDate } : {}),
    ...(value.endDate ? { endDate: value.endDate } : {})
  };
}
export function assertStoreCleanupRuntime(env: NodeJS.ProcessEnv): void {
  try {
    const database = new URL(env["DATABASE_URL"] ?? "");
    if (
      [...database.searchParams.keys()].some(
        (key) =>
          ![
            "connectionLimit",
            "minimumIdle",
            "idleTimeout",
            "connection_limit",
            "pool_timeout",
            "connect_timeout"
          ].includes(key)
      )
    )
      failure("STORE_CLEANUP_RUNTIME_MISMATCH");
    if (
      !env["DATABASE_URL"] ||
      new URL(env["DATABASE_URL"]).protocol !== "mysql:" ||
      !isStagingRuntimeDatabaseUrl(env["DATABASE_URL"]) ||
      env["STORAGE_DRIVER"] !== "oss" ||
      env["AWS_S3_BUCKET"] !== "yxy-test-sme-data-center" ||
      env["AWS_REGION"] !== "oss-cn-beijing" ||
      ![
        "https://oss-cn-beijing.aliyuncs.com",
        "https://oss-cn-beijing-internal.aliyuncs.com"
      ].includes(env["AWS_ENDPOINT"] ?? "") ||
      (env["AWS_S3_PREFIX"]?.trim() || "smedc").replace(/^\/+|\/+$/g, "") !== "smedc"
    )
      failure("STORE_CLEANUP_RUNTIME_MISMATCH");
  } catch {
    failure("STORE_CLEANUP_RUNTIME_MISMATCH");
  }
}
export function parseStoreCleanupArgs(argv: string[]) {
  const values: Record<string, string> = {};
  let execute = false;
  const allowed = [
    "target",
    "org-id",
    "inventory",
    "confirm",
    "enterprise",
    "datasets",
    "store-names",
    "store-name-contains",
    "start-date",
    "end-date"
  ];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--execute") {
      execute = true;
      continue;
    }
    if (argv[i] === "--dry-run") {
      if (execute) failure("STORE_CLEANUP_ARGUMENT_INVALID");
      continue;
    }
    const key = argv[i]?.slice(2) ?? "";
    const value = argv[++i];
    if (!allowed.includes(key) || !value || value.startsWith("--") || values[key] !== undefined)
      failure("STORE_CLEANUP_ARGUMENT_INVALID");
    values[key] = value!;
  }
  if (values["target"] !== "staging" || !values["org-id"]?.trim() || !values["inventory"]?.trim())
    failure("STORE_CLEANUP_TARGET_REQUIRED");
  if (execute && !/^[a-f0-9]{64}$/.test(values["confirm"] ?? ""))
    failure("STORE_CLEANUP_CONFIRMATION_REQUIRED");
  if (execute && allowed.slice(4).some((key) => values[key] !== undefined))
    failure("STORE_CLEANUP_EXECUTE_USES_SAVED_INVENTORY");
  return { execute, values };
}

/** No environment bypass in the CLI; injecting a client here permits isolated synthetic tests. */
export function createStoreCleanupRepository(prisma: PrismaClient) {
  const transaction = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    retryIdempotentDatabaseOperation(() =>
      prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30000
      })
    );
  async function lockOrg(tx: Prisma.TransactionClient, orgId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM organizations WHERE BINARY id = ${orgId} FOR UPDATE`
    );
    if (rows.length !== 1) failure("STORE_CLEANUP_ORGANIZATION_NOT_FOUND");
  }
  async function targets(
    tx: Prisma.TransactionClient,
    scope: StoreCleanupScope,
    lock: boolean
  ): Promise<StoreCleanupTarget[]> {
    const rows = await tx.$queryRaw<
      (Omit<StoreCleanupTarget, "businessDate" | "rowCount" | "byteSize" | "updatedAt"> & {
        businessDate: Date;
        updatedAt: Date;
        rowCount: bigint;
        byteSize: bigint;
      })[]
    >(Prisma.sql`
      SELECT id, enterprise_key AS enterpriseKey, dataset, store_key AS storeKey, store_name AS storeName,
        business_date AS businessDate, object_key AS objectKey, checksum_sha256 AS checksumSha256,
        merchant_id AS merchantId, published_by_job_id AS publishedByJobId, updated_at AS updatedAt,
        confidentiality_level AS confidentialityLevel, row_count AS rowCount, byte_size AS byteSize
      FROM structured_partitions WHERE org_id = ${scope.orgId} AND BINARY enterprise_name = ${scope.enterpriseName}
      AND dataset IN (${Prisma.join(scope.datasets)})
      ${scope.storeNames ? Prisma.sql`AND BINARY store_name IN (${Prisma.join(scope.storeNames)})` : Prisma.empty}
      ${scope.storeNameContains ? Prisma.sql`AND ${literalStoreNameScope(scope.storeNameContains)}` : Prisma.empty}
      ${scope.startDate ? Prisma.sql`AND business_date >= ${new Date(scope.startDate)}` : Prisma.empty}
      ${scope.endDate ? Prisma.sql`AND business_date <= ${new Date(scope.endDate)}` : Prisma.empty}
      ORDER BY id ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
    `);
    if (!rows.length) failure("STORE_CLEANUP_EMPTY_MATCH");
    if (new Set(rows.map((row) => row.enterpriseKey)).size !== 1)
      failure("STORE_CLEANUP_ENTERPRISE_AMBIGUOUS");
    return rows.map((row) => ({
      ...row,
      businessDate: row.businessDate.toISOString().slice(0, 10),
      updatedAt: row.updatedAt.toISOString(),
      rowCount: String(row.rowCount),
      byteSize: String(row.byteSize)
    }));
  }
  const fingerprint = (scope: StoreCleanupScope, rows: StoreCleanupTarget[]) =>
    partitionDownloadFingerprint({ version: 1, scope, targets: rows });
  return {
    async buildStoreCleanupInventory(input: StoreCleanupScope): Promise<StoreCleanupInventory> {
      const scope = normalizeStoreCleanupScope(input);
      return transaction(async (tx) => {
        await lockOrg(tx, scope.orgId);
        const rows = await targets(tx, scope, true);
        const preserved = {
          partitions: await tx.structuredPartition.count({
            where: { orgId: scope.orgId, id: { notIn: rows.map((row) => row.id) } }
          }),
          importJobs: await tx.partitionImportJob.count({ where: { orgId: scope.orgId } }),
          employees: await tx.employee.count({ where: { orgId: scope.orgId } })
        };
        return {
          version: 1,
          scope,
          targets: rows,
          preserved,
          fingerprint: fingerprint(scope, rows)
        };
      });
    },
    async executeStoreCleanup(input: {
      inventory: StoreCleanupInventory;
      expectedFingerprint: string;
    }) {
      const { inventory, expectedFingerprint } = input;
      const scope = normalizeStoreCleanupScope(inventory.scope);
      if (
        inventory.version !== 1 ||
        !Array.isArray(inventory.targets) ||
        !inventory.targets.length ||
        expectedFingerprint !== inventory.fingerprint ||
        fingerprint(scope, inventory.targets) !== expectedFingerprint
      )
        failure("STORE_CLEANUP_FINGERPRINT_MISMATCH");
      return transaction(async (tx) => {
        await lockOrg(tx, scope.orgId);
        // Lock download owners before sources. Organization lock prevents new prepare requests.
        const affected = await invalidatePartitionDownloadsForPartitions(tx, {
          orgId: scope.orgId,
          partitionIds: inventory.targets.map((row) => row.id)
        });
        const current = await targets(tx, scope, true);
        if (fingerprint(scope, current) !== expectedFingerprint)
          failure("STORE_CLEANUP_FINGERPRINT_MISMATCH");
        const deleted = await tx.structuredPartition.deleteMany({
          where: { orgId: scope.orgId, id: { in: current.map((row) => row.id) } }
        });
        const objectKeys = new Set(affected.objectKeys);
        for (const row of current) {
          // Protect any remaining current reference, even if future schemas permit shared objects.
          if (await tx.structuredPartition.count({ where: { objectKey: row.objectKey } })) continue;
          await enqueueStorageGarbage(tx, {
            objectKey: row.objectKey,
            reason: "partition_store_cleanup"
          });
          objectKeys.add(row.objectKey);
        }
        await tx.auditLog.create({
          data: {
            orgId: scope.orgId,
            action: "partition.store_cleanup",
            targetType: "structured_partition",
            targetId: expectedFingerprint,
            clientSource: "release-ops",
            metadata: {
              deletedPartitionCount: deleted.count,
              invalidatedRequestCount: affected.invalidatedRequestCount,
              garbageObjectCount: objectKeys.size,
              externalCleanupPending: true
            }
          }
        });
        return {
          deletedPartitionCount: deleted.count,
          invalidatedRequestCount: affected.invalidatedRequestCount,
          garbageObjectCount: objectKeys.size,
          externalCleanupPending: true as const
        };
      });
    }
  };
}
