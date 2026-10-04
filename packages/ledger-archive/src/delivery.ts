import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@smedc/storage";
import { createPrismaLedgerArtifactAccess } from "./access.js";
import { createPrismaLedgerArchiveRepository } from "./repository.js";
import { reduceLedgerRequestStatus } from "./service.js";
import { ledgerScopeDates, parseLedgerScope, LEDGER_SCOPE_MAX_PARTITIONS } from "./scope.js";
import { ledgerStoreNameHash } from "./keys.js";
import { readableLedgerPartitionHints } from "./changes.js";
import {
  readLedgerSourceMetadata,
  readReadableLedgerSourceMetadataBatch,
  LEDGER_METADATA_BATCH_SIZE,
  type LedgerSourceMetadata
} from "./source-reader.js";
import {
  findReadableCurrentSupplierCatalog,
  findSupplierCatalogMatches,
  nullableValue
} from "./supplier-values.js";
import type {
  LedgerPartitionKey,
  LedgerScope,
  LedgerSourceRef,
  LedgerRequestRef
} from "./types.js";

export type LedgerDeliveryEmployee = {
  id: string;
  orgId: string;
  clearance: number;
  disabled: boolean;
  role: "admin" | "employee";
};
export type LedgerCoverageScope = Omit<LedgerScope, "storeNames"> & { storeNames?: string[] };
export type LedgerPdfFact = {
  key: LedgerPartitionKey;
  status: "ready" | "pending" | "stale" | "missing";
  entry: LedgerBundleEntry | null;
};
export type LedgerBundleEntry = {
  key: LedgerPartitionKey;
  partitionId: string;
  generation: number;
  dataRevision: number;
  sourceFingerprint: string;
  objectKey: string;
  checksumSha256: string;
  byteSize: number;
  sources: LedgerSourceRef[];
};
export type LedgerBundleManifest = { version: 1; scope: LedgerScope; entries: LedgerBundleEntry[] };
export type LedgerBundleLease = { runId: string; lockedBy: string; attemptNumber: number };
export type LedgerBundleRecord = {
  requestId: string;
  orgId: string;
  employeeId: string;
  status: string;
  manifest: LedgerBundleManifest;
  zipObjectKey: string | null;
  zipExpiresAt: Date | null;
  errorCode: string | null;
};
export interface LedgerDeliveryRepository {
  currentEmployee(employee: LedgerDeliveryEmployee): Promise<LedgerDeliveryEmployee | null>;
  facts(employee: LedgerDeliveryEmployee, scope: LedgerCoverageScope): Promise<LedgerPdfFact[]>;
  reserveBundle(input: {
    employee: LedgerDeliveryEmployee;
    manifest: LedgerBundleManifest;
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<{ requestId: string; status: string }>;
  request(
    employee: LedgerDeliveryEmployee,
    requestId: string
  ): Promise<{
    kind: "refresh" | "download";
    status: string;
    scope: LedgerCoverageScope;
    allowEmptyRequest?: boolean;
    visibleEmptyKeys?: LedgerPartitionKey[];
    items: {
      key: LedgerPartitionKey;
      status: "queued" | "running" | "succeeded" | "empty" | "superseded" | "failed";
      errorCode?: string | null;
      latestRequest?: LedgerRequestRef | null;
    }[];
    bundle: LedgerBundleRecord | null;
  } | null>;
}
export class LedgerDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new LedgerDeliveryError(code);
};
export function ledgerBundleFingerprint(
  employee: LedgerDeliveryEmployee,
  scope: LedgerScope
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "download",
        employee.orgId,
        employee.id,
        scope.storeNames,
        ledgerScopeDates(scope)
      ])
    )
    .digest("hex");
}
function partitionIdentity(key: LedgerPartitionKey): string {
  return JSON.stringify([key.orgId, key.storeName, key.purchaseDate]);
}
export function ledgerBundleEntriesEqual(a: LedgerBundleEntry[], b: LedgerBundleEntry[]): boolean {
  const canonical = (entries: LedgerBundleEntry[]) =>
    entries.map((e) => [
      partitionIdentity(e.key),
      e.partitionId,
      e.generation,
      e.dataRevision,
      e.sourceFingerprint,
      e.objectKey,
      e.checksumSha256,
      e.byteSize,
      e.sources.map((s) => [s.sourceDocumentId, s.kind, s.confidentialityLevel, s.checksumSha256])
    ]);
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** The captured identities are immutable; only their published generations may advance. */
export function capturedLedgerBundleEntries(
  entries: LedgerBundleEntry[],
  captured: LedgerBundleEntry[]
): LedgerBundleEntry[] {
  const byKey = new Map(entries.map((e) => [partitionIdentity(e.key), e]));
  if (byKey.size !== entries.length) return fail("LEDGER_PDF_UNAVAILABLE");
  return captured.map((original) => {
    const current = byKey.get(partitionIdentity(original.key));
    if (!current || current.partitionId !== original.partitionId)
      return fail("LEDGER_PDF_UNAVAILABLE");
    return current;
  });
}
export function readyCapturedLedgerBundleEntries(
  facts: LedgerPdfFact[],
  captured: LedgerBundleEntry[]
): LedgerBundleEntry[] {
  const selected = captured.map((entry) => {
    const fact = facts.find((f) => partitionIdentity(f.key) === partitionIdentity(entry.key));
    if (!fact) return fail("LEDGER_PDF_UNAVAILABLE");
    return fact;
  });
  if (selected.some((f) => f.status !== "ready" || !f.entry))
    return fail("LEDGER_PDF_BUNDLE_STALE");
  return capturedLedgerBundleEntries(readyLedgerBundleEntries(selected), captured);
}
const safeItemErrors = new Set([
  "LEDGER_LIMIT_EXCEEDED",
  "LEDGER_IMAGE_INVALID",
  "LEDGER_CERTIFICATE_INVALID",
  "LEDGER_RENDER_ABORTED",
  "LEDGER_RENDER_TIMEOUT",
  "LEDGER_RENDER_FAILED",
  "LEDGER_PDF_INVALID",
  "LEDGER_SOURCE_CHANGED",
  "LEDGER_UPLOAD_VERIFICATION_FAILED",
  "LEDGER_STORAGE_UNSUPPORTED",
  "LEDGER_GENERATION_FAILED"
]);
const publicErrorCode = (code?: string | null) =>
  code ? (safeItemErrors.has(code) ? code : "LEDGER_GENERATION_FAILED") : undefined;

export function readyLedgerBundleEntries(facts: LedgerPdfFact[]): LedgerBundleEntry[] {
  if (!facts.length) return fail("LEDGER_PDF_UNAVAILABLE");
  if (facts.some((f) => f.status !== "ready" || !f.entry)) return fail("LEDGER_PDF_NOT_READY");
  if (facts.length > 5000) return fail("LEDGER_SCOPE_LIMIT_EXCEEDED");
  const entries = facts.map((f) => f.entry!);
  if (entries.reduce((sum, e) => sum + e.byteSize, 0) > 1024 ** 3)
    return fail("LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED");
  return entries;
}
export function createLedgerPdfDelivery({
  repository,
  storage,
  cursorSecret,
  now = () => new Date()
}: {
  repository: LedgerDeliveryRepository;
  storage: StorageAdapter;
  cursorSecret: string;
  now?: () => Date;
}) {
  const encryptionKey = createHash("sha256").update(cursorSecret).digest();
  async function employee(input: LedgerDeliveryEmployee) {
    const current = await repository.currentEmployee(input);
    if (!current) return fail("LEDGER_PDF_UNAVAILABLE");
    return current;
  }
  function page<T>(values: T[], binding: object, cursor?: string) {
    let offset = 0;
    const context = JSON.stringify(binding);
    if (cursor) {
      try {
        const data = Buffer.from(cursor, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, data.subarray(0, 12));
        decipher.setAuthTag(data.subarray(12, 28));
        decipher.setAAD(Buffer.from(context));
        const decoded = JSON.parse(
          Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()
        ) as { offset: number; expires: number };
        if (
          !Number.isSafeInteger(decoded.offset) ||
          decoded.offset < 0 ||
          decoded.expires <= now().getTime()
        )
          throw new Error();
        offset = decoded.offset;
      } catch {
        return fail("LEDGER_CURSOR_INVALID");
      }
    }
    let nextCursor: string | null = null;
    if (offset + 200 < values.length) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify({ offset: offset + 200, expires: now().getTime() + 900000 })),
        cipher.final()
      ]);
      nextCursor = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
    }
    return { partitions: values.slice(offset, offset + 200), nextCursor };
  }
  const publicFact = (fact: LedgerPdfFact) => ({
    storeName: fact.key.storeName,
    purchaseDate: fact.key.purchaseDate,
    status: fact.status
  });
  return {
    async coverage(input: {
      employee: LedgerDeliveryEmployee;
      scope: LedgerCoverageScope;
      cursor?: string;
    }) {
      const current = await employee(input.employee);
      const facts = await repository.facts(current, input.scope);
      return {
        scope: input.scope,
        ...page(
          facts.map(publicFact),
          {
            orgId: current.orgId,
            employeeId: current.id,
            clearance: current.clearance,
            scope: input.scope
          },
          input.cursor
        )
      };
    },
    async requestLedgerBundle(input: {
      employee: LedgerDeliveryEmployee;
      scope: LedgerScope;
      idempotencyKey: string;
    }) {
      const current = await employee(input.employee);
      const scope = parseLedgerScope(input.scope);
      const entries = readyLedgerBundleEntries(await repository.facts(current, scope));
      return repository.reserveBundle({
        employee: current,
        manifest: { version: 1, scope, entries },
        idempotencyKey: input.idempotencyKey,
        fingerprint: ledgerBundleFingerprint(current, scope)
      });
    },
    async status(input: { employee: LedgerDeliveryEmployee; requestId: string; cursor?: string }) {
      const current = await employee(input.employee);
      const request = await repository.request(current, input.requestId);
      if (!request) return fail("LEDGER_PDF_UNAVAILABLE");
      const facts = await repository.facts(current, request.scope);
      const visible = new Set(
        [...facts.map((f) => f.key), ...(request.visibleEmptyKeys ?? [])].map(partitionIdentity)
      );
      const items = request.items.filter((item) => visible.has(partitionIdentity(item.key)));
      if (request.kind === "refresh" && !items.length && !request.allowEmptyRequest)
        return fail("LEDGER_PDF_UNAVAILABLE");
      const bundleFacts = request.bundle
        ? request.bundle.manifest.entries.map((e) => {
            const fact = facts.find((f) => partitionIdentity(f.key) === partitionIdentity(e.key));
            if (!fact) return fail("LEDGER_PDF_UNAVAILABLE");
            return fact;
          })
        : facts;
      const partitions: {
        storeName: string;
        purchaseDate: string;
        status: string;
        errorCode?: string;
        latestRequest?: LedgerRequestRef;
      }[] =
        request.kind === "download"
          ? bundleFacts.map(publicFact)
          : items.map((i) => ({
              storeName: i.key.storeName,
              purchaseDate: i.key.purchaseDate,
              status: i.status,
              ...(publicErrorCode(i.errorCode) ? { errorCode: publicErrorCode(i.errorCode) } : {}),
              ...(i.latestRequest ? { latestRequest: i.latestRequest } : {})
            }));
      const status =
        request.kind === "download"
          ? request.status
          : items.length
            ? reduceLedgerRequestStatus(items.map((i) => i.status))
            : request.status;
      return {
        requestId: input.requestId,
        status,
        ...page(
          partitions,
          {
            orgId: current.orgId,
            employeeId: current.id,
            clearance: current.clearance,
            requestId: input.requestId
          },
          input.cursor
        )
      };
    },
    async issueLedgerBundleUrl(input: { employee: LedgerDeliveryEmployee; requestId: string }) {
      const current = await employee(input.employee);
      const request = await repository.request(current, input.requestId);
      const bundle = request?.bundle;
      if (!bundle) return fail("LEDGER_PDF_UNAVAILABLE");
      if (
        bundle.status !== "succeeded" ||
        !bundle.zipObjectKey ||
        !bundle.zipExpiresAt ||
        bundle.zipExpiresAt <= now()
      )
        return fail(
          bundle.status === "succeeded" ||
            (bundle.status === "failed" && bundle.errorCode === "LEDGER_PDF_BUNDLE_STALE")
            ? "LEDGER_PDF_BUNDLE_STALE"
            : "LEDGER_PDF_NOT_READY"
        );
      const facts = await repository.facts(current, bundle.manifest.scope);
      if (!facts.length) return fail("LEDGER_PDF_UNAVAILABLE");
      const entries = readyCapturedLedgerBundleEntries(facts, bundle.manifest.entries);
      if (!ledgerBundleEntriesEqual(entries, bundle.manifest.entries))
        return fail("LEDGER_PDF_BUNDLE_STALE");
      if ((await storage.headObject(bundle.zipObjectKey)).state !== "found")
        return fail("LEDGER_PDF_BUNDLE_STALE");
      const expiresInSeconds = Math.min(
        900,
        Math.floor((bundle.zipExpiresAt.getTime() - now().getTime()) / 1000)
      );
      if (expiresInSeconds < 1) return fail("LEDGER_PDF_BUNDLE_STALE");
      const downloadUrl = await storage.createDownloadUrl(bundle.zipObjectKey, {
        expiresInSeconds,
        downloadFileName: "台账.zip"
      });
      // Recheck after signing so concurrent account/source changes cannot issue a new usable response.
      const fresh = await employee(current);
      const freshFacts = await repository.facts(fresh, bundle.manifest.scope);
      if (!freshFacts.length) return fail("LEDGER_PDF_UNAVAILABLE");
      const latest = readyCapturedLedgerBundleEntries(freshFacts, bundle.manifest.entries);
      if (!ledgerBundleEntriesEqual(latest, bundle.manifest.entries))
        return fail("LEDGER_PDF_BUNDLE_STALE");
      return {
        requestId: input.requestId,
        downloadUrl,
        expiresAt: new Date(
          Math.min(now().getTime() + expiresInSeconds * 1000, bundle.zipExpiresAt.getTime())
        ).toISOString()
      };
    }
  };
}

export function parseLedgerBundleManifest(value: Prisma.JsonValue): LedgerBundleManifest {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    value["version"] !== 1 ||
    !Array.isArray(value["entries"])
  )
    return fail("LEDGER_BUNDLE_MANIFEST_INVALID");
  const scope = parseLedgerScope(value["scope"]);
  const entries = value["entries"].map((raw) => {
    if (!raw || Array.isArray(raw) || typeof raw !== "object")
      return fail("LEDGER_BUNDLE_MANIFEST_INVALID");
    const entry = raw as unknown as LedgerBundleEntry;
    if (
      !entry.key ||
      typeof entry.key.orgId !== "string" ||
      typeof entry.key.storeName !== "string" ||
      !ledgerScopeDates(scope).includes(entry.key.purchaseDate) ||
      !scope.storeNames.includes(entry.key.storeName) ||
      typeof entry.partitionId !== "string" ||
      !Number.isSafeInteger(entry.generation) ||
      entry.generation < 1 ||
      !Number.isSafeInteger(entry.dataRevision) ||
      entry.dataRevision < 0 ||
      typeof entry.objectKey !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry.checksumSha256) ||
      !/^[a-f0-9]{64}$/i.test(entry.sourceFingerprint) ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize <= 0 ||
      !Array.isArray(entry.sources) ||
      !entry.sources.length ||
      entry.sources.some(
        (s) =>
          !s ||
          typeof s.sourceDocumentId !== "string" ||
          !["ledger", "supplier", "certificate"].includes(s.kind) ||
          !Number.isInteger(s.confidentialityLevel) ||
          s.confidentialityLevel < 0 ||
          !/^[a-f0-9]{64}$/i.test(s.checksumSha256)
      )
    )
      return fail("LEDGER_BUNDLE_MANIFEST_INVALID");
    return entry;
  });
  if (
    !entries.length ||
    entries.length > 5000 ||
    new Set(entries.map((e) => partitionIdentity(e.key))).size !== entries.length
  )
    return fail("LEDGER_BUNDLE_MANIFEST_INVALID");
  return { version: 1, scope, entries };
}

export function createPrismaLedgerDeliveryRepository({
  prisma,
  storage,
  objectKeyPrefix = ""
}: {
  prisma: PrismaClient;
  storage: StorageAdapter;
  objectKeyPrefix?: string;
}): LedgerDeliveryRepository {
  const archive = createPrismaLedgerArchiveRepository({ prisma, objectKeyPrefix });
  const access = createPrismaLedgerArtifactAccess({ prisma });
  async function currentEmployee(employee: LedgerDeliveryEmployee) {
    if (employee.disabled) return null;
    const current = await prisma.employee.findFirst({
      where: { id: employee.id, orgId: employee.orgId, disabled: false }
    });
    return current
      ? {
          ...employee,
          role: current.role,
          clearance: Math.min(employee.clearance, current.clearance)
        }
      : null;
  }
  async function readFact(
    tx: Prisma.TransactionClient,
    key: LedgerPartitionKey,
    employee: LedgerDeliveryEmployee,
    preloaded?: LedgerSourceMetadata
  ): Promise<LedgerPdfFact | null> {
    if (!preloaded && !(await readableLedgerPartitionHints(tx, employee.id, [key])).length)
      return null;
    const metadata = preloaded ?? (await readLedgerSourceMetadata(tx, key));
    if (!metadata.rowCount) return null;
    const partition = await tx.ledgerPdfPartition.findUnique({
      where: {
        orgId_storeNameHash_purchaseDate: {
          orgId: key.orgId,
          storeNameHash: ledgerStoreNameHash(key.storeName),
          purchaseDate: new Date(key.purchaseDate + "T00:00:00Z")
        }
      },
      include: { sources: true }
    });
    if (partition && partition.storeName !== key.storeName)
      return fail("LEDGER_STORE_HASH_COLLISION");
    let sources = metadata.sources;
    const ready =
      partition &&
      partition.publishedGeneration !== null &&
      partition.publishedGeneration > 0 &&
      partition.publishedDataRevision === partition.dataRevision &&
      partition.publishedSourceFingerprint === metadata.sourceFingerprint &&
      partition.currentObjectKey &&
      partition.checksumSha256 &&
      partition.byteSize;
    if (ready)
      sources = partition.sources
        .map((s) => ({
          sourceDocumentId: s.sourceDocumentId,
          kind: s.kind,
          confidentialityLevel: s.confidentialityLevel,
          checksumSha256: s.checksumSha256
        }))
        .sort(
          (a, b) =>
            a.sourceDocumentId.localeCompare(b.sourceDocumentId) || a.kind.localeCompare(b.kind)
        );
    else {
      const names = await tx.$queryRaw<{ supplierName: string | null }[]>(
        Prisma.sql`SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.supplier_name')) AS supplierName FROM delivery_ledger_rows r JOIN documents d ON d.id=r.source_document_id AND d.org_id=r.org_id JOIN import_batches b ON b.id=r.import_batch_id AND b.org_id=r.org_id WHERE r.org_id=${key.orgId} AND d.status='active' AND d.archived_at IS NULL AND b.status='applied' AND b.archived_at IS NULL AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.store_name')) AS BINARY)=CAST(${key.storeName} AS BINARY) AND JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.purchase_date'))=${key.purchaseDate} LIMIT 10001`
      );
      const supplierNames = names.flatMap((n) =>
        nullableValue(n.supplierName) === null ? [] : [String(n.supplierName)]
      );
      const catalog = supplierNames.length
        ? await findReadableCurrentSupplierCatalog(tx, { orgId: key.orgId })
        : null;
      if (catalog) {
        const matches = await findSupplierCatalogMatches(
          tx,
          catalog.id,
          catalog.source_document_id,
          supplierNames,
          ["supplier_unit_address", "supplier_contact_phone"],
          key.orgId
        );
        const counts = new Map<unknown, number>();
        for (const match of matches)
          counts.set(match["supplier_name"], (counts.get(match["supplier_name"]) ?? 0) + 1);
        const used = matches.some(
          (m) =>
            counts.get(m["supplier_name"]) === 1 &&
            (nullableValue(m["unit_address"]) !== null ||
              nullableValue(m["contact_phone"]) !== null)
        );
        if (used) {
          const source = await tx.document.findFirstOrThrow({
            where: { orgId: key.orgId, id: catalog.source_document_id }
          });
          sources = [
            ...sources,
            {
              sourceDocumentId: source.id,
              kind: "supplier",
              confidentialityLevel: source.confidentialityLevel,
              checksumSha256: source.checksumSha256!
            }
          ];
        }
      }
    }
    // Bind checks to the same metadata transaction while checking the live account separately.
    if (
      !(await access.canReadLedgerArtifact({ employee, orgId: key.orgId, sources })) ||
      !(await access.sourcesAreCurrent({ orgId: key.orgId, sources, tx }))
    )
      return null;
    if (!ready)
      return {
        key,
        status: partition?.currentObjectKey
          ? "stale"
          : partition?.requestedGeneration
            ? "pending"
            : "missing",
        entry: null
      };
    const object = await storage.headObject(partition.currentObjectKey!);
    if (
      object.state !== "found" ||
      object.size !== Number(partition.byteSize) ||
      object.hash !== partition.checksumSha256
    )
      return { key, status: "missing", entry: null };
    return {
      key,
      status: "ready",
      entry: {
        key,
        partitionId: partition.id,
        generation: partition.publishedGeneration!,
        dataRevision: partition.dataRevision,
        sourceFingerprint: metadata.sourceFingerprint,
        objectKey: partition.currentObjectKey!,
        checksumSha256: partition.checksumSha256!,
        byteSize: Number(partition.byteSize),
        sources
      }
    };
  }
  return {
    currentEmployee,
    async facts(employee, scope) {
      const dates = ledgerScopeDates(
        parseLedgerScope({ ...scope, storeNames: scope.storeNames ?? ["__date_validation__"] })
      );
      const facts: LedgerPdfFact[] = [];
      let cursor: string | undefined;
      do {
        const page = await archive.listPartitionKeys({
          orgId: employee.orgId,
          ...(scope.storeNames ? { scope: parseLedgerScope(scope) } : {}),
          ...(cursor ? { cursor } : {})
        });
        const keys = page.keys.filter((k) => dates.includes(k.purchaseDate));
        for (let offset = 0; offset < keys.length; offset += LEDGER_METADATA_BATCH_SIZE) {
          const batch = keys.slice(offset, offset + LEDGER_METADATA_BATCH_SIZE);
          const results = await prisma.$transaction(
            async (tx) => {
              if (batch.length === 1) return [await readFact(tx, batch[0]!, employee)];
              const metadata = await readReadableLedgerSourceMetadataBatch(tx, employee, batch);
              const visible = batch.filter((key) => metadata.has(key));
              const results: (LedgerPdfFact | null)[] = [];
              for (let index = 0; index < visible.length; index += 4) {
                // Drain every check before ending the transaction, including on failure.
                const checks = await Promise.allSettled(
                  visible
                    .slice(index, index + 4)
                    .map((key) => readFact(tx, key, employee, metadata.get(key)!))
                );
                for (const check of checks) {
                  if (check.status === "rejected") throw check.reason;
                  results.push(check.value);
                }
              }
              return results;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 }
          );
          for (const fact of results) if (fact) facts.push(fact);
          if (facts.length > LEDGER_SCOPE_MAX_PARTITIONS)
            return fail("LEDGER_SCOPE_LIMIT_EXCEEDED");
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return facts;
    },
    async reserveBundle({ employee, manifest, idempotencyKey, fingerprint }) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM organizations WHERE id=${employee.orgId} FOR UPDATE`
        );
        const existing = await tx.ledgerArtifactRequest.findUnique({
          where: { orgId_idempotencyKey: { orgId: employee.orgId, idempotencyKey } }
        });
        if (existing) {
          if (existing.requestFingerprint !== fingerprint)
            return fail("LEDGER_IDEMPOTENCY_CONFLICT");
          return { requestId: existing.id, status: existing.status };
        }
        const request = await tx.ledgerArtifactRequest.create({
          data: {
            orgId: employee.orgId,
            kind: "download",
            actorKind: "employee",
            actorEmployeeId: employee.id,
            idempotencyKey,
            requestFingerprint: fingerprint,
            scope: manifest as unknown as Prisma.InputJsonValue
          }
        });
        await tx.processingRun.create({
          data: {
            orgId: employee.orgId,
            jobType: "ledger_pdf_bundle",
            jobKey: `ledger-bundle:${request.id}`,
            ledgerArtifactRequestId: request.id
          }
        });
        return { requestId: request.id, status: request.status };
      });
    },
    async request(employee, requestId) {
      const request = await prisma.ledgerArtifactRequest.findFirst({
        where: { orgId: employee.orgId, id: requestId },
        include: { items: { include: { partition: true } } }
      });
      if (
        !request ||
        request.actorKind !== "employee" ||
        (request.actorEmployeeId !== employee.id &&
          (employee.role !== "admin" || request.kind === "download"))
      )
        return null;
      const manifest =
        request.kind === "download" ? parseLedgerBundleManifest(request.scope) : null;
      const scope = manifest?.scope ?? parseLedgerScope(request.scope);
      const visibleEmptyKeys: LedgerPartitionKey[] = [];
      const items = [];
      for (const i of request.items) {
        const key = {
          orgId: employee.orgId,
          storeName: i.partition.storeName,
          purchaseDate: i.partition.purchaseDate.toISOString().slice(0, 10)
        };
        if (i.status === "empty" && request.actorEmployeeId === employee.id) {
          const empty = await prisma.$transaction(
            async (tx) => {
              const metadata = await readLedgerSourceMetadata(tx, key);
              const pointer = await tx.ledgerPdfPartition.findUnique({
                where: { id: i.partitionId },
                include: { sources: true }
              });
              return (
                metadata.rowCount === 0 &&
                metadata.sources.length === 0 &&
                pointer &&
                pointer.rowCount === 0 &&
                pointer.currentObjectKey === null &&
                pointer.sources.length === 0 &&
                pointer.publishedGeneration !== null &&
                pointer.publishedGeneration >= i.generation &&
                pointer.publishedDataRevision === pointer.dataRevision &&
                pointer.publishedSourceFingerprint === metadata.sourceFingerprint
              );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 }
          );
          if (empty) visibleEmptyKeys.push(key);
        }
        let latestRequest: LedgerRequestRef | null = null;
        if (
          i.status === "superseded" &&
          (await prisma.$transaction((tx) => readFact(tx, key, employee)))
        ) {
          const latest = await prisma.ledgerArtifactRequestItem.findFirst({
            where: {
              orgId: employee.orgId,
              partitionId: i.partitionId,
              generation: { gt: i.generation },
              request: { actorKind: "employee", actorEmployeeId: employee.id, kind: "refresh" }
            },
            orderBy: { generation: "desc" },
            select: { requestId: true, status: true }
          });
          if (latest) latestRequest = { requestId: latest.requestId, status: latest.status };
        }
        items.push({
          key,
          status: i.status,
          errorCode: publicErrorCode(i.errorCode),
          latestRequest
        });
      }
      return {
        kind: request.kind,
        allowEmptyRequest:
          request.kind === "refresh" &&
          request.actorEmployeeId === employee.id &&
          request.items.length === 0,
        visibleEmptyKeys,
        status: request.status,
        scope,
        items,
        bundle: manifest
          ? {
              requestId: request.id,
              orgId: request.orgId,
              employeeId: request.actorEmployeeId!,
              status: request.status,
              manifest,
              zipObjectKey: request.zipObjectKey,
              zipExpiresAt: request.zipExpiresAt,
              errorCode: request.errorCode
            }
          : null
      };
    }
  };
}
export type LedgerPdfDelivery = ReturnType<typeof createLedgerPdfDelivery>;
