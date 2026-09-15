# Business / Dishes OSS Partition Hard Migration Implementation Plan

**Implementation status (2026-09-15):** Tasks 1–8 and Task 9's cleanup/local-integration work are implemented and locally verified on PR #160. The opt-in two-file real-scale service acceptance remains to run after human review. Tasks 10–12 (launcher publication, recommendation/skill synchronization, staging hard cutover and official acceptance) remain intentionally gated; current server recommendation metadata and user skills do not advertise unpublished launcher 0.4.0.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `business` / `dishes` 从“源文件保留 + MySQL 每行一条 + MCP 分页查询”硬迁移为“launcher 直传临时 OSS + worker 按企业/门店/营业日生成 canonical CSV + MySQL 当前分区目录 + launcher 本地批量下载”，使几十万至上百万行来源文件的上传和周报/月报读取不再与 LLM token 或 MySQL 明细行数线性绑定。

**Architecture:** HTTP API 是上传会话、任务状态、分区目录和 manifest 的权威契约；MCP 只做认证薄适配；official launcher 在本机负责不经过模型上下文的 multipart 上传与 manifest 下载；worker 流式校验一个源文件并一次原子发布其全部分区；OSS 保存当前 canonical CSV 字节，MySQL 保存当前指针、授权元数据和有限期任务记录。`vip`、`dish_catalog`、`delivery_ledger`、`supplier_catalog` 保持现有 row-table 路径。

**Tech Stack:** Node.js 22、TypeScript、Fastify、Prisma 7 / MySQL、AWS SDK S3-compatible Alibaba Cloud OSS、Vitest、stdio MCP launcher、Python 3 报告脚本。

**Spec:** [ADR 0026](../adr/0026-business-dishes-current-oss-partitions.md)；本文同时是经产品负责人确认的详细迁移设计和执行清单。

## Global Constraints

- Base/lead branch is the repository default branch `main`; implementation branches use the `codex/` prefix.
- This is a hard migration. Do not add dual write, backfill, old endpoint aliases, old table readers, compatibility flags, historical partition versions, rollback copies, or a mixed row/partition mode for `business` / `dishes`.
- Existing staging and local `business` / `dishes` data is QA-only and may be hard-deleted during the controlled cutover. Never apply that authorization to identity/configuration data or a future environment with real customer data.
- One source file is the atomic boundary. Two files mentioned in one employee request commit independently.
- The service performs validation, partitioning and canonicalization. The employee-owned agent supplies the original local path and business metadata; it must not split, rewrite, Base64-emit, or directly manipulate OSS/MySQL.
- The original XLSX/CSV is temporary transport data. It is absent after `published`, `rejected`, terminal `failed`, cancellation or expiry, except while a retryable worker attempt still needs it.
- A partition is current state, not a version. Replacement may change content and confidentiality level. No user-facing or internal history pointer remains.
- Ordinary reads enforce organization first and then `partition.confidentialityLevel <= employee.clearance`. `admin` does not bypass this rule.
- The launcher contract change ships as `enterprise-hub-mcp-launcher@0.4.0`. Per the repository release rule, publish and independently verify 0.4.0 before changing server recommended-version metadata or either `enterprise-hub-mcp` skill copy.
- Real exports under `/Users/xiaoyuyin/Desktop/MAIJIA_MANAGEMENT_SKILLS/documents/raw_exports` are authorized test inputs but must never be committed, copied into fixtures, printed into logs, or retained under `.data/` after a run.
- Use focused tests while implementing. Run the full static/unit/integration/MCP/release gates once on the final tree, then remove run-created files, containers, volumes, networks and inactive worktrees.

---

## 1. Approved behavior

### 1.1 Partition identity

The database uniqueness tuple is:

```text
(orgId, enterpriseKey, dataset, storeKey, businessDate)
```

Normalization is deterministic and service-owned:

```ts
normalizeIdentityText(value) = value.normalize("NFC").trim().replace(/\s+/gu, " ");
enterpriseKey = asciiLowercase(normalizeIdentityText(enterpriseName));
merchantId = normalizeIdentityText(cell("商户号")); // string; preserve leading zeroes
storeKey = merchantId
  ? `merchant:${merchantId}`
  : `name:${asciiLowercase(normalizeIdentityText(storeName))}`;
```

- `dishes` uses `门店`; `business` uses `门店名称` as `storeName`.
- A blank merchant ID is allowed only when the normalized store name is non-empty.
- If rows inside one source partition disagree about the non-empty store name for one merchant ID, reject the entire source file with `PARTITION_STORE_IDENTITY_CONFLICT` rather than choosing one silently.
- `enterpriseName` is retained for display and may be refreshed by a later upload with the same `enterpriseKey`.
- A later source that supplies a merchant ID does not heuristically merge or delete an older name-fallback partition; the two `storeKey` values are distinct. This edge case is acceptable because the approved real exports contain merchant IDs.
- Only store/date pairs actually present in the source produce partitions. Absence does not create an empty file and does not delete a pre-existing partition outside the produced set.

### 1.2 Canonical CSV

Each partition is byte-deterministic:

- UTF-8 without BOM, comma delimiter, RFC 4180 quoting, `\n` line endings and one final newline;
- exact fixed Chinese `inputSource="file"` headers from the `business` or `dishes` registry, in registry order; synthetic metadata fields such as `source_document_id` are absent;
- exactly one header row and at least one validated data row;
- metadata/title/filter rows and aggregate/footer rows are excluded by the same parser rules used for validation;
- source rows retain `(sheetIndex, sourceRowNumber)` order inside a partition;
- blank nullable cells serialize as an empty CSV field;
- text values use the validated trimmed value; merchant IDs remain strings;
- dates serialize `YYYY-MM-DD`, date-times `YYYY-MM-DD HH:mm:ss`, booleans `true`/`false`, and numeric values as non-exponent base-10 text without insignificant trailing zeroes;
- canonicalization must not depend on process locale, timezone or upload filename.

`checksumSha256` is calculated over these exact bytes. Two sources with semantically equal rows in a different row order are allowed to have different hashes and therefore replace the current partition.

### 1.3 Overwrite and deduplication

For every produced unique key:

| Current state                                         | New canonical bytes / metadata | Result                                                                   |
| ----------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| no row                                                | any                            | insert current partition                                                 |
| same SHA, same confidentiality/display metadata       | identical                      | no-op; keep row/object                                                   |
| same SHA, changed confidentiality or display metadata | same bytes                     | reuse object; atomically update current metadata                         |
| different SHA                                         | any                            | atomically point to new object and metadata; enqueue old object deletion |

All keys from one source file publish in one short transaction. Keys are sorted before locking. Concurrent jobs use the unique constraint plus row locks/retry; the last successfully committed source file wins. A reader sees either all old current rows or all new current rows for that source file, never a partially published set or an empty gap.

Upload authorization does not compare the employee's clearance with the partition being replaced. Any active employee in the organization may publish the explicitly declared level, including lowering the old level. The employee-facing job response never reveals whether an invisible old partition existed, its hash/level, or whether an individual key was inserted, deduplicated or replaced.

### 1.4 Upload lifecycle

The official user experience remains one natural-language action and one outward MCP tool call:

```text
employee -> agent: “把这两个大文件上传到 Enterprise Hub”
agent -> launcher: upload_structured_dataset(file.encoding="path", ...)
launcher -> API: create upload session
launcher -> OSS: multipart PUT original bytes (bounded concurrency)
launcher -> API: complete upload session
API -> worker: queue partition import
launcher -> agent: one job ID and compact status
agent -> API/MCP: poll the job ID
```

The model never carries file bytes, multipart URLs, ETags, OSS keys or access credentials. The initial default limits are:

| Limit                                  |   Default |
| -------------------------------------- | --------: |
| source bytes                           |     2 GiB |
| parsed rows per source                 | 5,000,000 |
| partitions per source                  |    10,000 |
| canonical bytes per source             |     8 GiB |
| required free worker temp disk         |    12 GiB |
| multipart part size                    |    16 MiB |
| launcher upload concurrency            |         4 |
| worker open partition files            |        32 |
| upload session expiry                  |  24 hours |
| terminal import-job metadata retention |   30 days |

Limits are typed runtime configuration, fail closed at startup, and are included in safe error details. They are not MCP/model context chunk sizes.

The create-session request contains `dataset`, `enterpriseName`, `startDate`, `endDate`, `originalFileName`, `mediaType`, `sourceByteSize`, `sourceChecksumSha256`, `idempotencyKey` and optional `confidentialityLevel`. The launcher hashes the file as a stream, verifies its size/mtime did not change before multipart completion, and the server independently verifies the completed OSS object. Create returns `partitionImportJobId`, 16 MiB `partSize`, expiry and the first bounded page of presigned part URLs; later pages come from the parts endpoint. Complete submits ordered `{partNumber, etag}` values and queues exactly one processing run. Status returns the job state, safe validation summary, total rows and partition count, but no OSS key or per-existing-partition action.

### 1.5 Manifest and local extraction

The canonical HTTP response is:

```json
{
  "dataset": "dishes",
  "enterpriseName": "麦家小馆",
  "startDate": "2026-09-07",
  "endDate": "2026-09-13",
  "expiresAt": "2026-09-15T10:15:00.000Z",
  "partitionCount": 14,
  "totalRowCount": 30655,
  "partitions": [
    {
      "businessDate": "2026-09-07",
      "storeId": "000123",
      "storeName": "门店A",
      "rowCount": 2011,
      "byteSize": 184321,
      "checksumSha256": "64 lowercase hex characters",
      "presignedDownloadUrl": "short-lived URL"
    }
  ]
}
```

- Request fields are `dataset`, `enterpriseName`, inclusive `startDate`, inclusive `endDate`, and optional `storeIds`.
- Each `storeId` is the exact merchant-ID string; partitions using the store-name fallback have `storeId: null` and can still be selected by omitting `storeIds`.
- Only `business` and `dishes` are accepted.
- Results are ordered by `businessDate`, then `storeKey`.
- Authorization is applied before counts and URLs are produced. Hidden partitions are indistinguishable from absent partitions.
- A successful empty manifest is valid. The service does not infer whether a missing store/day means zero sales, omitted scope or inaccessible data.
- Maximum manifest size is 10,000 partitions. Larger requests return `PARTITION_MANIFEST_TOO_LARGE` and safe narrowing guidance.
- Links expire in 15 minutes and are never saved in audit payloads or returned by the launcher to the model.

The launcher downloads into a newly created OS application-data temp directory, uses concurrency 6, verifies size and SHA-256, and names files `{dataset}_{YYYYMMDD}_{sha256(storeKey)[0:16]}.csv`. It writes a local `manifest.json` mapping those filenames to metadata with URLs and OSS keys removed, and returns only `localDirectory`, dataset/date/enterprise summary, partition count, row count and local filenames. Any failed/cancelled download removes the entire new directory. Launcher startup and successful runs remove extract directories older than 24 hours.

### 1.6 Report workflow

`maijia-business-analyses-smedc` changes from many `query_structured_dataset` pages to:

1. discover `business`, `dishes`, `dish_catalog`;
2. request local extracts for all required current/previous/year-over-year periods for `business` and `dishes`; coalesce only overlapping or directly adjacent windows, and never bridge unused months between a current window and year-over-year window;
3. keep `dish_catalog` on its current controlled-query path;
4. load canonical partition CSVs locally and run the existing fact/report generators;
5. produce the durable HTML/facts/provenance artifacts;
6. remove every launcher-created extract directory in `finally`, on success or error.

Missing partitions retain the skill's current partial/empty-report behavior. They do not create technical warnings, fabricated rows or a coverage-completeness claim.

---

## 2. Target data model

Add these Prisma concepts; names below are normative unless an implementation constraint is documented in the PR:

```prisma
enum PartitionDataset {
  dishes
  business
}

enum PartitionImportJobStatus {
  uploading
  queued
  processing
  published
  rejected
  failed
  cancelled
  expired
}

model PartitionImportJob {
  id                    String                   @id @db.VarChar(32)
  orgId                 String                   @map("org_id") @db.VarChar(64)
  uploaderId            String                   @map("uploader_employee_id") @db.VarChar(32)
  dataset               PartitionDataset
  enterpriseKey         String                   @map("enterprise_key") @db.VarChar(191)
  enterpriseName        String                   @map("enterprise_name") @db.VarChar(255)
  confidentialityLevel  Int                      @map("confidentiality_level") @db.UnsignedTinyInt
  idempotencyKey        String                   @map("idempotency_key") @db.VarChar(255)
  requestFingerprint    String                   @map("request_fingerprint") @db.VarChar(64)
  originalFileName      String                   @map("original_file_name") @db.VarChar(512)
  mediaType             String                   @map("media_type") @db.VarChar(255)
  sourceByteSize        BigInt                   @map("source_byte_size")
  sourceChecksumSha256  String                   @map("source_checksum_sha256") @db.VarChar(64)
  temporaryObjectKey    String?                  @map("temporary_object_key") @db.VarChar(1024)
  status                PartitionImportJobStatus @default(uploading)
  totalRowCount         BigInt                   @default(0) @map("total_row_count")
  partitionCount        Int                      @default(0) @map("partition_count")
  errorCode             String?                  @map("error_code") @db.VarChar(128)
  errorSummary          String?                  @map("error_summary") @db.Text
  validationErrors      Json?                    @map("validation_errors")
  expiresAt             DateTime                 @map("expires_at")
  publishedAt           DateTime?                @map("published_at")
  finishedAt            DateTime?                @map("finished_at")
  createdAt             DateTime                 @default(now()) @map("created_at")
  updatedAt             DateTime                 @updatedAt @map("updated_at")
  organization          Organization             @relation(fields: [orgId], references: [id], onDelete: Restrict)
  uploader              Employee                 @relation(fields: [uploaderId], references: [id], onDelete: Restrict)
  processingRun         ProcessingRun?

  @@unique([orgId, idempotencyKey])
  @@index([status, expiresAt])
  @@index([orgId, uploaderId, createdAt])
  @@map("partition_import_jobs")
}

model StructuredPartition {
  id                    String           @id @db.VarChar(32)
  orgId                 String           @map("org_id") @db.VarChar(64)
  enterpriseKey         String           @map("enterprise_key") @db.VarChar(191)
  enterpriseName        String           @map("enterprise_name") @db.VarChar(255)
  dataset               PartitionDataset
  storeKey              String           @map("store_key") @db.VarChar(255)
  merchantId            String?          @map("merchant_id") @db.VarChar(255)
  storeName             String           @map("store_name") @db.VarChar(255)
  businessDate          DateTime         @map("business_date") @db.Date
  objectKey             String           @unique @map("object_key") @db.VarChar(1024)
  rowCount              BigInt           @map("row_count")
  byteSize              BigInt           @map("byte_size")
  checksumSha256        String           @map("checksum_sha256") @db.VarChar(64)
  confidentialityLevel  Int              @map("confidentiality_level") @db.UnsignedTinyInt
  publishedByJobId      String           @map("published_by_job_id") @db.VarChar(32)
  createdAt             DateTime         @default(now()) @map("created_at")
  updatedAt             DateTime         @updatedAt @map("updated_at")
  organization          Organization     @relation(fields: [orgId], references: [id], onDelete: Restrict)

  @@unique([orgId, enterpriseKey, dataset, storeKey, businessDate], map: "structured_partitions_identity_uq")
  @@index([orgId, dataset, enterpriseKey, businessDate], map: "structured_partitions_manifest_idx")
  @@index([orgId, confidentialityLevel, dataset, businessDate], map: "structured_partitions_auth_idx")
  @@map("structured_partitions")
}

model StorageGarbage {
  id             String   @id @db.VarChar(32)
  objectKey      String   @unique @map("object_key") @db.VarChar(1024)
  reason         String   @db.VarChar(64)
  attemptCount   Int      @default(0) @map("attempt_count")
  availableAt    DateTime @default(now()) @map("available_at")
  lastErrorCode  String?  @map("last_error_code") @db.VarChar(128)
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  @@index([availableAt])
  @@map("storage_garbage")
}
```

`ProcessingRun.documentId` and its `Document` relation become nullable, and the model gains a nullable unique `partitionImportJobId` / `PartitionImportJob` relation. A database `CHECK` requires exactly one of `documentId` and `partitionImportJobId`. Add the `structured_partition_import` job type. `PartitionImportJob` contains user-visible business state; `ProcessingRun` continues to own lease, heartbeat, attempt and retry state. The worker sweeps due `StorageGarbage` rows directly with bounded retry; the outbox is not a processing-run owner or a version catalog.

Remove `DishRow`, `BusinessRow` and their relations. Preserve `ImportBatch`, `ImportWindowClaim` and all other row models for non-partition datasets. Existing `ImportDataset` values may remain because historical migration SQL and non-partition code use the enum, but application code must reject `business` / `dishes` from `ImportBatch` creation.

---

## 3. Implementation tasks

### Task 1: Freeze partition domain contracts and real-scale acceptance oracles

**Files:**

- Create: `packages/domain/src/structured-partitions.ts`
- Create: `packages/domain/src/structured-partitions.test.ts`
- Modify: `packages/domain/src/structured-registry.ts`
- Modify: `packages/domain/src/structured-registry.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `scripts/profile-partition-source.ts`
- Create: `scripts/profile-partition-source.test.ts`

- [ ] **Step 1: Add RED tests for access mode and identity normalization**

Assert that `business` / `dishes` registries expose `accessMode: "partition_extract"`, the four other datasets expose `accessMode: "row_query"`, merchant IDs preserve leading zeroes, missing IDs fall back to normalized names, and blank ID plus blank name fails.

Run:

```bash
npx vitest run packages/domain/src/structured-partitions.test.ts packages/domain/src/structured-registry.test.ts
```

Expected: FAIL because partition contracts do not exist.

- [ ] **Step 2: Implement exact types and error codes**

Export `PARTITION_DATASETS`, `PartitionDatasetName`, `normalizeEnterpriseIdentity`, `partitionStoreIdentity`, `PartitionManifestRequest`, `PartitionManifest`, and stable codes:

```text
PARTITION_UPLOAD_SESSION_REQUIRED
PARTITION_UPLOAD_EXPIRED
PARTITION_UPLOAD_INCOMPLETE
PARTITION_SOURCE_CHECKSUM_MISMATCH
PARTITION_SOURCE_DATE_OUT_OF_RANGE
PARTITION_STORE_IDENTITY_MISSING
PARTITION_STORE_IDENTITY_CONFLICT
PARTITION_LIMIT_EXCEEDED
PARTITION_MANIFEST_TOO_LARGE
DATASET_REQUIRES_PARTITION_EXTRACT
```

- [ ] **Step 3: Add a read-only source profiler**

`profile-partition-source.ts` accepts an absolute local path and dataset, streams it through the production parser, and prints only safe metrics: byte size, total rows, date min/max, distinct stores, partition count, estimated canonical bytes and peak RSS. It must never print cell contents or write output beside the source.

- [ ] **Step 4: Record real-input baseline outside git**

Run the profiler against at least:

```text
/Users/xiaoyuyin/Desktop/MAIJIA_MANAGEMENT_SKILLS/documents/raw_exports/maijia_dishes_20260328_20260625.xlsx
/Users/xiaoyuyin/Desktop/MAIJIA_MANAGEMENT_SKILLS/documents/raw_exports/maijia_business_20250626_20260625.xlsx
```

Write metrics under ignored `.data/partition-migration/baseline/`, then delete them after transcribing aggregate timing/size evidence into the PR description. Do not commit the exports or profiler output.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run packages/domain/src/structured-partitions.test.ts packages/domain/src/structured-registry.test.ts scripts/profile-partition-source.test.ts
git add packages/domain/src/structured-partitions.ts packages/domain/src/structured-partitions.test.ts packages/domain/src/structured-registry.ts packages/domain/src/structured-registry.test.ts packages/domain/src/index.ts scripts/profile-partition-source.ts scripts/profile-partition-source.test.ts
git commit -m "feat(domain): define business dishes partition contracts"
```

### Task 2: Build streaming canonical partition generation

**Files:**

- Modify: `packages/structured-ingestion/src/index.ts`
- Modify: `packages/structured-ingestion/src/index.test.ts`
- Modify: `packages/structured-ingestion/src/xlsx-stream.ts`
- Modify: `packages/structured-ingestion/src/xlsx-stream.test.ts`
- Create: `packages/structured-ingestion/src/partition-export.ts`
- Create: `packages/structured-ingestion/src/partition-export.test.ts`

- [ ] **Step 1: Write RED canonical-byte tests**

Cover fixed Chinese header order, UTF-8/no BOM/LF/final newline, CSV quoting, blank nullable cells, leading-zero merchant IDs, numeric/date formatting, summary-row exclusion, two stores across two dates, fallback store names, source-order preservation and deterministic SHA.

- [ ] **Step 2: Write RED whole-file rejection tests**

Cover one invalid row after several valid partitions, store identity conflict, source limits, max partitions, an XLSX failure after earlier sheets, and cancellation. Assert zero publishable candidates and an empty temp directory after the caller invokes cleanup.

- [ ] **Step 3: Replace all-row buffering for partition datasets**

Add an async row iterator for CSV and XLSX. Keep the existing buffered `parseStructuredFile` for the four row-query datasets. `exportStructuredPartitions` must spool to a caller-supplied temp directory, bound open file handles with an LRU of 32, and return only file paths plus metadata—not all row payloads.

Target interface:

```ts
export async function exportStructuredPartitions(input: {
  dataset: "business" | "dishes";
  sourcePath: string;
  outputDirectory: string;
  limits: StructuredPartitionLimits;
  signal?: AbortSignal;
}): Promise<{
  totalRowCount: bigint;
  partitions: Array<{
    storeKey: string;
    merchantId: string | null;
    storeName: string;
    businessDate: string;
    rowCount: bigint;
    filePath: string;
    byteSize: bigint;
    checksumSha256: string;
  }>;
}>;
```

- [ ] **Step 4: Measure bounded memory**

Run the 231,257,837-byte dishes workbook and assert the process completes without holding the source or canonical output in one Buffer. Record peak RSS and temp-disk high-water mark. An RSS increase greater than 512 MiB is a failed gate requiring parser work, not a limit increase.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run packages/structured-ingestion/src/index.test.ts packages/structured-ingestion/src/xlsx-stream.test.ts packages/structured-ingestion/src/partition-export.test.ts
git add packages/structured-ingestion/src
git commit -m "feat(ingestion): stream canonical daily store partitions"
```

### Task 3: Apply the destructive schema migration and repositories

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260915_business_dishes_oss_partitions/migration.sql`
- Modify: `apps/api/src/structured-imports.ts`
- Modify: `apps/api/src/structured-imports.test.ts`
- Create: `apps/api/src/structured-partitions.ts`
- Create: `apps/api/src/structured-partitions.test.ts`
- Modify: `apps/worker/src/worker-persistence.test.ts`

- [ ] **Step 1: Write repository RED tests against local MySQL**

Prove unique identity includes organization and enterprise; identical-content no-op; same bytes plus confidentiality change; different-content replacement; sorted multi-key atomic rollback; concurrent last-successful-commit wins; clearance filtering before counts; and garbage outbox insertion.

- [ ] **Step 2: Write one-way SQL**

The migration must, in this order:

1. delete QA `business` / `dishes` import batches, claims, processing runs and source documents using exact dataset predicates;
2. drop `dish_rows` and `business_rows`;
3. remove their Prisma relations;
4. create the three target tables/enums/indexes;
5. generalize `processing_runs` owner fields and add the exactly-one-owner `CHECK`;
6. preserve every non-business/dishes document, import batch and row table.

There is no data copy or down migration.

- [ ] **Step 3: Split row-import and partition repositories**

`createPrismaStructuredImportRepository` must reject the two partition datasets before reservation. Add `createPrismaStructuredPartitionRepository` with `reserveUpload`, `queueCompletedUpload`, `findJobForStatus`, `publishSourceAtomically`, `listReadableManifestRows`, `enqueueGarbage` and terminal-job retention methods.

- [ ] **Step 4: Reset and verify local schema**

```bash
docker compose up -d mysql
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npx prisma migrate reset --force --config packages/db/prisma.config.ts
npx vitest run apps/api/src/structured-imports.test.ts apps/api/src/structured-partitions.test.ts apps/worker/src/worker-persistence.test.ts
```

Expected: all partition tests pass; non-partition structured tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma apps/api/src/structured-imports.ts apps/api/src/structured-imports.test.ts apps/api/src/structured-partitions.ts apps/api/src/structured-partitions.test.ts apps/worker/src/worker-persistence.test.ts
git commit -m "feat(db): replace business dishes rows with partition catalog"
```

### Task 4: Add OSS multipart sessions and immutable partition objects

**Files:**

- Modify: `packages/storage/src/storage-adapter.ts`
- Modify: `packages/storage/src/object-key.ts`
- Create: `packages/storage/src/object-key.test.ts`
- Modify: `packages/storage/src/aliyun-oss-storage.ts`
- Modify: `packages/storage/src/aliyun-oss-storage.test.ts`
- Modify: `packages/storage/src/aliyun-oss-storage.integration.test.ts`
- Modify: `packages/storage/src/local-storage.ts`
- Modify: `packages/storage/src/local-storage.test.ts`

- [ ] **Step 1: Add RED adapter contract tests**

Test multipart create/presign/complete/abort, stream-to-file download, stat/hash, immutable partition put, temporary-source deletion and idempotent deletion. Assert pre-signed URLs and OSS credentials never enter loggable return metadata.

- [ ] **Step 2: Extend the adapter without buffering**

Add `createMultipartUpload`, `createUploadPartUrl`, `completeMultipartUpload`, `abortMultipartUpload`, and `downloadObjectToFile`. Remove `bodyToBuffer` from the partition path; keep existing behavior only where small current documents still depend on it.

- [ ] **Step 3: Define opaque keys**

```text
structured-import-staging/{orgId}/{jobId}/source
structured-partitions/{orgId}/{jobId}/{partitionId}.csv
```

Enterprise/store names never appear in keys. Partition objects are immutable; replacement always writes a new key before pointer publication.

- [ ] **Step 4: Run local and real OSS focused tests**

```bash
npx vitest run packages/storage/src/object-key.test.ts packages/storage/src/local-storage.test.ts packages/storage/src/aliyun-oss-storage.test.ts
set -a; source .env; set +a; RUN_OSS_INTEGRATION=1 npx vitest run packages/storage/src/aliyun-oss-storage.integration.test.ts
```

Clean the test prefix immediately after the integration test.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src
git commit -m "feat(storage): support multipart partition transfers"
```

### Task 5: Implement upload-session HTTP API and partition worker publication

**Files:**

- Create: `apps/api/src/routes/structured-partitions/routes.ts`
- Create: `apps/api/src/routes/structured-partitions/routes.test.ts`
- Create: `apps/api/src/routes/structured-partitions/workflow.ts`
- Create: `apps/api/src/routes/structured-partitions/workflow.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/app-context.ts`
- Modify: `apps/api/src/config/runtime-limits.ts`
- Modify: `apps/api/src/config/runtime-limits.test.ts`
- Modify: `apps/worker/src/config/runtime-limits.ts`
- Modify: `apps/worker/src/config/runtime-limits.test.ts`
- Create: `apps/worker/src/partition-import.ts`
- Create: `apps/worker/src/partition-import.test.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/worker.test.ts`

- [ ] **Step 1: Add RED route tests**

Cover create, part-URL paging, complete, abort, expiry, byte/checksum mismatch, idempotent replay, same key/different fingerprint, disabled account, invalid confidentiality, wrong organization, and rejection of direct multipart `business` / `dishes` on `/v1/structured/imports`.

- [ ] **Step 2: Add RED worker tests**

Cover all-or-nothing multi-partition publication, retryable storage failure, deterministic validation rejection, DB rollback, post-commit old-object garbage enqueue, candidate cleanup after failed commit, source deletion at every terminal state, and retained source during a scheduled retry.

- [ ] **Step 3: Register canonical endpoints**

```text
POST   /v1/structured/partition-uploads
GET    /v1/structured/partition-uploads/:jobId/parts?afterPartNumber=N
POST   /v1/structured/partition-uploads/:jobId/complete
DELETE /v1/structured/partition-uploads/:jobId
GET    /v1/structured/partition-imports/:jobId
```

Create/parts/complete responses may contain pre-signed upload transport only for the authenticated launcher. Audit logs include IDs/counts/timing but never URLs, ETags, object keys or cell data.

Add and document these typed runtime settings with the defaults from section 1.4:

```text
PARTITION_IMPORT_MAX_SOURCE_BYTES=2147483648
PARTITION_IMPORT_MAX_ROWS=5000000
PARTITION_IMPORT_MAX_PARTITIONS=10000
PARTITION_IMPORT_MAX_CANONICAL_BYTES=8589934592
PARTITION_IMPORT_WORK_DIR=/var/lib/enterprise-hub/partition-work
PARTITION_IMPORT_MIN_FREE_BYTES=12884901888
PARTITION_UPLOAD_PART_BYTES=16777216
PARTITION_UPLOAD_SESSION_TTL_SECONDS=86400
PARTITION_IMPORT_JOB_RETENTION_DAYS=30
PARTITION_MANIFEST_MAX_PARTITIONS=10000
PARTITION_MANIFEST_URL_TTL_SECONDS=900
```

- [ ] **Step 4: Implement worker flow with `try/finally` cleanup**

```text
download temporary source to work dir
stream validate + canonicalize all partitions
upload/HEAD every new candidate object
publish all partition pointers in one DB transaction
delete source + local work dir
delete unused candidates
process garbage outbox with bounded retry
```

Set job `published` only after the DB commit. If source/candidate cleanup fails after commit, publication remains successful and cleanup is retried from `StorageGarbage`.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run apps/api/src/routes/structured-partitions apps/api/src/config/runtime-limits.test.ts apps/worker/src/partition-import.test.ts apps/worker/src/worker.test.ts apps/worker/src/config/runtime-limits.test.ts
git add apps/api/src apps/worker/src
git commit -m "feat: ingest business dishes as atomic OSS partitions"
```

### Task 6: Replace row queries with authorized manifests

**Files:**

- Modify: `packages/domain/src/structured-query.ts`
- Modify: `packages/domain/src/structured-query.test.ts`
- Modify: `packages/domain/src/structured-coverage.ts`
- Modify: `packages/domain/src/structured-coverage.test.ts`
- Modify: `apps/api/src/routes/structured-query.ts`
- Modify: `apps/api/src/routes/structured-query.test.ts`
- Modify: `apps/api/src/structured-query.ts`
- Modify: `apps/api/src/structured-query.prisma.integration.test.ts`
- Modify: `apps/api/src/structured-coverage.ts`
- Modify: `apps/api/src/structured-coverage.test.ts`
- Create: `apps/api/src/routes/structured-partitions/manifest.test.ts`

- [ ] **Step 1: Write RED removal and authorization tests**

Assert that row query compilation for `business` / `dishes` returns `DATASET_REQUIRES_PARTITION_EXTRACT` without SQL execution; no generated SQL names the dropped tables; registry discovery declares partition extract; and coverage/manifests filter clearance before count/date/store metadata.

- [ ] **Step 2: Add manifest endpoint**

```text
POST /v1/structured/partition-manifests
```

Validate exact dataset/enterprise/date/store inputs, select current authorized rows with the compound index, generate 15-minute URLs only after authorization, and return the fixed response from section 1.5. Use strings for BigInt-derived JSON counts after `Number.MAX_SAFE_INTEGER`; the normal response remains numeric while safe.

- [ ] **Step 3: Retain coverage without row scans**

`describe_structured_dataset_coverage` for `business` / `dishes` reads only `structured_partitions`, returning available min/max dates, distinct store metadata, partition count and total row count. It does not expose source document/import batch IDs for these datasets.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run packages/domain/src/structured-query.test.ts packages/domain/src/structured-coverage.test.ts apps/api/src/routes/structured-query.test.ts apps/api/src/structured-query.prisma.integration.test.ts apps/api/src/structured-coverage.test.ts apps/api/src/routes/structured-partitions/manifest.test.ts
git add packages/domain/src apps/api/src
git commit -m "feat(api): serve authorized business dishes manifests"
```

### Task 7: Update MCP contracts and thin API adapters

**Files:**

- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`
- Modify: `apps/api/src/mcp/action-tools.ts`
- Modify: `apps/api/src/mcp/action-tools.test.ts`
- Modify: `apps/api/src/mcp/read-tools.ts`
- Modify: `apps/api/src/mcp/read-tools.test.ts`
- Modify: `apps/api/src/mcp/tool-handlers.ts`
- Modify: `apps/api/src/mcp/http.test.ts`

- [ ] **Step 1: Add RED tool-contract tests**

Keep outward `upload_structured_dataset` for all datasets. Add `get_partition_import_status` with `partitionImportJobId`, and add `download_structured_partitions` with the request from section 1.5. Server-side MCP returns the status/manifest envelopes; API handlers only delegate to HTTP. `query_structured_dataset` still accepts the dataset enum so it can return the stable migration error for these two datasets.

- [ ] **Step 2: Remove inline business/dishes payload behavior**

The remote upload handler returns `PARTITION_UPLOAD_SESSION_REQUIRED` for inline `business` / `dishes`; official launcher path mode handles their upload session. Other structured datasets retain current Base64/path behavior and 50 MiB limit.

- [ ] **Step 3: Prove thin-adapter and non-enumeration behavior**

Tests must compare direct HTTP and MCP success/error bodies, ensure URLs are not logged, and ensure lower-clearance calls cannot distinguish absent from hidden partitions.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run packages/mcp-contract/src/index.test.ts apps/api/src/mcp/action-tools.test.ts apps/api/src/mcp/read-tools.test.ts apps/api/src/mcp/http.test.ts
git add packages/mcp-contract/src apps/api/src/mcp
git commit -m "feat(mcp): expose partition upload and download contracts"
```

### Task 8: Implement one-call launcher upload/download and bump 0.4.0

**Files:**

- Modify: `apps/mcp-launcher/package.json`
- Modify: `apps/mcp-launcher/src/oauth-client.ts`
- Modify: `apps/mcp-launcher/src/server.ts`
- Modify: `apps/mcp-launcher/src/index.test.ts`
- Modify: `apps/mcp-launcher/src/packaging.verify.ts`
- Modify: `apps/mcp-launcher/src/launcher.ts`
- Modify: `apps/mcp-launcher/src/launcher.test.ts`
- Modify: `apps/mcp-launcher/src/local-file.ts`
- Modify: `apps/mcp-launcher/src/local-file.test.ts`
- Modify: `apps/mcp-launcher/src/session.ts`
- Modify: `apps/mcp-launcher/src/session.test.ts`
- Create: `apps/mcp-launcher/src/partition-transfer.ts`
- Create: `apps/mcp-launcher/src/partition-transfer.test.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Add RED upload tests**

Use a sparse fake file larger than the old 50 MiB limit. Assert streaming hash/read, 16 MiB part boundaries, concurrency <=4, retry of transient part failure without re-emitting tool input, abort cleanup, cancellation, same idempotency replay, and a compact outward result containing only job/status metadata.

- [ ] **Step 2: Add RED download tests**

Assert concurrency <=6, URL consumption without outward exposure, path traversal-safe filenames, byte/SHA verification, all-or-nothing directory cleanup, URL-expiry retry by refreshing a manifest once, sanitized local `manifest.json`, and 24-hour stale directory cleanup.

- [ ] **Step 3: Implement direct byte transport**

For `business` / `dishes` with `file.encoding="path"`, do not call `readFile`, `toString("base64")`, or construct a full multipart request Buffer. Stream file ranges to pre-signed URLs and complete the upload session. For `download_structured_partitions`, consume the remote manifest internally and return local paths.

- [ ] **Step 4: Bump every launcher alignment assertion to 0.4.0**

Set package, `LAUNCHER_VERSION`, MCP server version, packaging verification and lockfile to `0.4.0`. Do not update server recommended metadata or skills yet.

- [ ] **Step 5: Verify release boundary and commit**

```bash
npx vitest run apps/mcp-launcher/src/partition-transfer.test.ts apps/mcp-launcher/src/local-file.test.ts apps/mcp-launcher/src/launcher.test.ts apps/mcp-launcher/src/index.test.ts
npm --workspace enterprise-hub-mcp-launcher run build
npm --workspace enterprise-hub-mcp-launcher run test:packaging
npm run audit:production
git add apps/mcp-launcher package-lock.json
git commit -m "feat(launcher): stream partition datasets without model bytes"
```

### Task 9: Update cleanup, integration and real-scale gates

**Files:**

- Modify: `scripts/staging-upload-domain-cleanup.ts`
- Modify: `scripts/staging-upload-domain-cleanup.test.ts`
- Modify: `scripts/purge-data.ts`
- Modify: `scripts/purge-data.test.ts`
- Modify: `scripts/test-integration.ts`
- Modify: `scripts/test-mcp-local.ts`
- Modify: `scripts/official-manual-acceptance.ts`
- Modify: `scripts/manual-test-fixtures.test.ts`
- Create: `scripts/partition-scale-acceptance.ts`
- Create: `scripts/partition-scale-acceptance.test.ts`

- [ ] **Step 1: Add RED cleanup tests**

Prove exact deletion of partition catalog rows, referenced objects, staging source objects, jobs, processing runs and garbage outbox rows without large interactive transactions. Preserve employees, auth, skills, retrieval config, non-target documents and the four non-partition structured datasets.

- [ ] **Step 2: Replace row-based smoke expectations**

Local integration and MCP smoke must upload a business/dishes file by launcher path, poll one job, inspect partition counts in MySQL only as operator evidence, download a manifest locally, verify hashes, and clean all run-scoped state.

- [ ] **Step 3: Add an opt-in real-scale acceptance**

`partition-scale-acceptance.ts` accepts explicit local source paths and performs the normal launcher/MCP flow—never direct DB import or caller-side splitting. It records safe metrics:

```text
source bytes, source rows, partitions, upload duration/throughput,
worker duration/peak RSS/temp disk, DB rows written, manifest latency,
download duration/throughput, outward MCP call count, cleanup duration/residue
```

Required report acceptance uploads the real `maijia_dishes_20250701_20250928.xlsx` (about 200 MB) and `maijia_business_20250626_20260625.xlsx` (about 118 MB), then requests `2025-09-07` through `2025-09-13`; both files cover that period. Also run the parser/partition memory gate from Task 2 against the 231 MB dishes workbook. The flow must show one outward upload call per source, one status polling sequence per job, one download call per contiguous required dataset window (overlapping/adjacent windows coalesce; separated current/prior-year ranges do not bridge unused months), zero `dish_rows`/`business_rows`, and zero residue after cleanup.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run scripts/staging-upload-domain-cleanup.test.ts scripts/purge-data.test.ts scripts/manual-test-fixtures.test.ts scripts/partition-scale-acceptance.test.ts
MYSQL_PORT=3307 npm run test:integration
MYSQL_PORT=3307 npm run test:mcp
git add scripts
git commit -m "test: cover partition lifecycle at realistic scale"
```

### Task 10: Publish launcher 0.4.0 before advertising it

**Files:**

- Modify only if release verification finds a defect: launcher files from Task 8

- [x] **Step 1: Finish human review of the launcher diff**

Do not publish from an unreviewed moving tree. Ensure the implementation PR identifies the exact commit intended for the release tag.

- [x] **Step 2: Stage and publish using the repository launcher release workflow**

Create the `mcp-launcher-v0.4.0` tag from the reviewed commit, run the required macOS and Windows native acceptance, approve staged publish, and wait at least three minutes between checks of an unchanged workflow.

- [x] **Step 3: Independently verify npm**

In a new temporary directory, install exact `enterprise-hub-mcp-launcher@0.4.0`, verify CLI version, package integrity, tool schemas, no unexpected files and zero production audit findings. Delete the temp directory.

- [x] **Step 4: Only now update recommendation metadata**

Proceed to Task 11 only after the public package is fetchable and verified. A failed publication blocks cutover; it does not justify documenting an unavailable version.

### Task 11: Synchronize API docs and all three skills

**Files in this repository:**

- Modify: `apps/api/src/auth/http-contract.ts`
- Modify: `apps/api/src/auth/http-contract.test.ts`
- Modify: `skills/enterprise-hub-mcp/SKILL.md`
- Modify: `docs/implementation/api-contract.md`
- Modify: `docs/implementation/implementation-plan.md`
- Modify: `docs/implementation/env-inventory.md`
- Modify: `docs/implementation/official-user-install-and-login.md`
- Modify: `docs/implementation/official-manual-acceptance.md`
- Modify: `docs/context/CONTEXT.md`
- Modify: `docs/context/use-cases.md`
- Modify: `CONTEXT.md`

**Files in standalone `enterprise-hub-mcp-skill`:**

- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `README.zh.md`

**Files in `YinXiaoyu-1998/maijia-business-analyses-smedc`:**

- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Replace: `scripts/build_query_plan.py`
- Replace: `scripts/assemble_query_bundle.py`
- Create: `scripts/load_partition_extract.py`
- Modify: `scripts/report_common.py`
- Modify: `scripts/run_business_report.py`
- Modify: `scripts/run_weekly_report.py`
- Modify: `scripts/run_monthly_report.py`
- Modify: `tests/test_build_query_plan.py`
- Modify: `tests/test_assemble_query_bundle.py`
- Modify: `tests/test_skill_contract.py`
- Create: `tests/test_partition_extract.py`
- Create: `tests/test_extract_cleanup.py`

- [x] **Step 1: Update server recommendation to 0.4.0**

Keep minimum version unchanged only if the old launcher can still authenticate and use unaffected tools; the new partition tools themselves must return a clear update-required error to older launchers. This is capability gating, not a row-query compatibility path.

- [x] **Step 2: Sync the dual-homed Enterprise Hub skill**

Start from the newest copy; the currently checked-out standalone repository may not be on `main`, so fetch, compare timestamps/commits, branch independently, and make repo-local and standalone skill content byte-identical. Teach one natural upload call and one local partition download call; do not teach manual chunking, Base64 emission, direct HTTP, OSS URLs, or dataset-specific file rewriting.

- [x] **Step 3: Rewrite the Maijia report skill data path**

Use `get_partition_import_status` while uploads process, use `download_structured_partitions` for `business` / `dishes`, retain controlled query only for `dish_catalog`, merge local CSV rows into the existing internal fact model, and delete extract directories in `finally`. Durable report/facts/provenance stay; launcher scratch does not.

The skill test must inspect a forced report exception and prove the extract directory was deleted while the pre-existing run directory and unrelated files remained.

- [x] **Step 4: Open independent skill PRs**

Open one PR for `enterprise-hub-mcp-skill` and one for `maijia-business-analyses-smedc`. Each describes its dependency on Enterprise Hub 0.4.0/cutover. Do not copy either repository into this PR.

- [x] **Step 5: Verify docs/skills and commit the main-repo sync**

```bash
npx vitest run apps/api/src/auth/http-contract.test.ts
npx prettier --check CONTEXT.md docs skills/enterprise-hub-mcp/SKILL.md
diff -u skills/enterprise-hub-mcp/SKILL.md /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill/SKILL.md
git add apps/api/src/auth docs CONTEXT.md skills/enterprise-hub-mcp/SKILL.md
git commit -m "docs: switch business dishes clients to partition extracts"
```

### Task 12: Direct staging cutover and end-to-end proof

**Files:**

- Modify: `docs/implementation/staging-readiness.md`
- Modify: `docs/implementation/progress.md`
- Modify: `docs/implementation/agent-handoffs.md` only for actual implementation-agent handoffs

- [ ] **Step 1: Run final repository gates once**

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run audit:production
npm run build:release
MYSQL_PORT=3307 npm run test:integration
MYSQL_PORT=3307 npm run test:mcp
npm run test:phase3:golden
npm run test:phase3:perf
```

- [ ] **Step 2: Clean local test resources**

Remove run-scoped `.data` content, compose containers/volumes/networks and clean inactive worktrees. Verify with `docker ps -a`, `docker volume ls`, `docker network ls`, and `git worktree list`.

- [ ] **Step 3: Execute one quiesced staging hard cutover**

1. Confirm no real users/data and record the exact pre-cutover QA counts.
2. Pause API/worker writes.
3. Run the exact scoped cleanup in dry-run mode and review counts.
4. Hard-delete old business/dishes source documents, batches, claims, rows and OSS source objects.
5. Deploy the migration/API/worker/launcher-compatible server via the canonical `main` workflow.
6. Verify migration, health, readiness, empty partition catalog and absence of old tables.
7. Resume API/worker.

Do not attempt database rollback after the destructive migration. Recovery is forward-fix plus re-upload of QA sources.

- [ ] **Step 4: Run normal-user real-scale acceptance**

Create a fresh synthetic account, use new visible Codex tasks with ordinary natural-language prompts, upload `maijia_dishes_20250701_20250928.xlsx` and `maijia_business_20250626_20260625.xlsx` through launcher 0.4.0, create the `2025-09-07` through `2025-09-13` weekly report with `maijia-business-analyses-smedc`, and collect safe metrics. Controller access is verification/cleanup only.

- [ ] **Step 5: Prove zero residue and merge synchronized skill PRs**

Delete all synthetic accounts, job/catalog rows, staging/canonical objects and local extract directories created by acceptance. Confirm zero run-scoped residue. Merge the standalone Enterprise Hub skill and Maijia report skill PRs only after staging accepts the new flow, then update `/Users/xiaoyuyin/.agents/skills` from their merged `main` branches.

- [ ] **Step 6: Record final evidence**

Update progress/readiness with deployed commit/tag, launcher version, aggregate scale metrics, report result and cleanup evidence. Do not add scratch ledgers, raw exports, generated reports or execution transcripts to the implementation PR.

---

## 4. Definition of done

- `dish_rows` and `business_rows` do not exist in Prisma or MySQL.
- Direct row/detail/aggregate queries for `business` / `dishes` are removed and return the stable partition-extract guidance error.
- One large local file produces one outward upload tool call and one job; model context contains no file bytes, URLs, ETags or OSS keys.
- Each source file either publishes every produced partition or publishes none.
- The unique key includes organization, normalized enterprise, dataset, store identity and business date.
- Same bytes deduplicate; newer metadata may replace confidentiality; different bytes replace current state with no readable gap and no retained old version.
- Original source and every local/server temp artifact is deleted at terminal completion; stale artifacts have bounded cleanup.
- Manifest queries scan only indexed partition metadata, enforce authorization before counts/links, and launcher downloads/verifies all files atomically.
- `maijia-business-analyses-smedc` generates diagnosis/weekly/monthly reports from local extracts and always deletes launcher scratch.
- The 200 MB dishes and 118 MB business report sources pass the normal launcher/MCP flow; the 231 MB dishes source also passes the bounded-memory parser/partition gate, with latency, DB-row and cleanup evidence recorded.
- Other structured datasets retain their existing import/query behavior.
- Launcher 0.4.0 is published and verified before server metadata and skills advertise it.
- Main repository and both external skill PRs pass their gates, staging acceptance passes, and all synthetic/test residue is gone.
