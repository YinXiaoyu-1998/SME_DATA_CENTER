import { Readable } from "node:stream";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { AuthorizationSnapshot } from "@smedc/domain";
import { canReadLedgerPdf, currentLedgerAuthorization } from "./pdf-authorization.js";
import type { StorageAdapter } from "@smedc/storage";
import { createPrismaLedgerArtifactAccess } from "./access.js";
import { createPrismaLedgerArchiveRepository } from "./repository.js";
import { reduceLedgerRequestStatus } from "./service.js";
import {
  ledgerScopeDates,
  parseLedgerScope,
  LEDGER_SCOPE_MAX_PARTITIONS,
  LEDGER_PAGE_SIZE
} from "./scope.js";
import { ledgerStoreNameHash } from "./keys.js";
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

export const LEDGER_BUNDLE_LIMITS = {
  files: LEDGER_SCOPE_MAX_PARTITIONS,
  bytes: 1073741824,
  deadlineMs: 600000,
  retentionMs: 86400000
} as const;

function ledgerStoreFileSegment(storeName: string): string {
  // Percent itself is escaped, making the segment reversible and preventing collisions/traversal.
  const store = [...storeName]
    .map((character, index, characters) =>
      '%./\\<>:"|?*'.includes(character) ||
      character.codePointAt(0)! < 32 ||
      character.codePointAt(0) === 127 ||
      (character === " " && index === characters.length - 1)
        ? `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`
        : character
    )
    .join("");
  return store;
}
export function ledgerPdfFileName(selection: LedgerPdfSelectionItem): string {
  return `食品经营单位进货台帐_${ledgerStoreFileSegment(selection.storeName)}_${selection.purchaseDate}.pdf`;
}
export function ledgerBundleEntryName(entry: LedgerBundleEntry): string {
  return `${ledgerStoreFileSegment(entry.key.storeName)}/${entry.key.purchaseDate}/${ledgerPdfFileName(entry.key)}`;
}

export type LedgerDeliveryEmployee = {
  id: string;
  orgId: string;
  clearance: number;
  disabled: boolean;
  role: "admin" | "employee";
  authorization?: AuthorizationSnapshot;
};
export type LedgerCoverageScope = Omit<LedgerScope, "storeNames"> & { storeNames?: string[] };
export type LedgerPdfSelectionItem = Pick<LedgerPartitionKey, "storeName" | "purchaseDate">;
export type LedgerBrowserCoverageInput = {
  employee: LedgerDeliveryEmployee;
  cursor?: string;
} & (
  | { scope: LedgerCoverageScope; selection?: never }
  | { selection: LedgerPdfSelectionItem[]; scope?: never }
);
export type LedgerBrowserCoverageItem = LedgerPdfSelectionItem & {
  status: LedgerPdfFact["status"];
  byteSize: number | null;
};
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
  commitDownloadIssue?<T>(employee: LedgerDeliveryEmployee, result: T): Promise<T>;
  facts(
    employee: LedgerDeliveryEmployee,
    scope: LedgerCoverageScope,
    options?: { requireComplete?: boolean; selection?: LedgerPdfSelectionItem[] }
  ): Promise<LedgerPdfFact[]>;
  auditDenied?(employee: LedgerDeliveryEmployee, requestId: string, code: string): Promise<void>;
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
    rebuildRequired?: boolean;
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
/** Canonicalize identities without normalizing names or expanding their Cartesian product. */
function parseSelection(value: unknown): LedgerPdfSelectionItem[] {
  if (!Array.isArray(value) || !value.length) return fail("LEDGER_SCOPE_INVALID");
  const items = value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return fail("LEDGER_SCOPE_INVALID");
    const fields = item as Record<string, unknown>;
    if (
      Object.keys(fields).some((key) => !["storeName", "purchaseDate"].includes(key)) ||
      typeof fields.storeName !== "string" ||
      Buffer.from(fields.storeName).toString("utf8") !== fields.storeName
    )
      return fail("LEDGER_SCOPE_INVALID");
    parseLedgerScope({ storeNames: [fields.storeName], dates: [fields.purchaseDate] });
    return { storeName: fields.storeName, purchaseDate: fields.purchaseDate as string };
  });
  const unique = [
    ...new Map(
      items.map((item) => [JSON.stringify([item.storeName, item.purchaseDate]), item])
    ).entries()
  ]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);
  if (unique.length > LEDGER_SCOPE_MAX_PARTITIONS) return fail("LEDGER_SCOPE_LIMIT_EXCEEDED");
  selectionScope(unique);
  return unique;
}
function selectionScope(selection: LedgerPdfSelectionItem[]): LedgerScope {
  return parseLedgerScope({
    storeNames: selection.map((item) => item.storeName),
    dates: selection.map((item) => item.purchaseDate)
  });
}
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
      e.sources.map((s) => [
        s.sourceDocumentId,
        s.kind,
        s.checksumSha256,
        s.contentVersion ?? null,
        s.businessContentVersion ?? null
      ])
    ]);
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** Both identity and content references are immutable after acceptance. */
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
    if (!ledgerBundleEntriesEqual([current], [original])) return fail("LEDGER_PDF_BUNDLE_STALE");
    return original;
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
  if (
    facts.some(
      (f) =>
        f.status !== "ready" ||
        !f.entry ||
        !Number.isSafeInteger(f.entry.byteSize) ||
        f.entry.byteSize <= 0
    )
  )
    return fail("LEDGER_PDF_NOT_READY");
  if (facts.length > LEDGER_BUNDLE_LIMITS.files) return fail("LEDGER_SCOPE_LIMIT_EXCEEDED");
  const entries = facts.map((f) => f.entry!);
  if (entries.reduce((sum, e) => sum + e.byteSize, 0) > LEDGER_BUNDLE_LIMITS.bytes)
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
    if (offset + LEDGER_PAGE_SIZE < values.length) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([
        cipher.update(
          JSON.stringify({ offset: offset + LEDGER_PAGE_SIZE, expires: now().getTime() + 900000 })
        ),
        cipher.final()
      ]);
      nextCursor = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
    }
    return { partitions: values.slice(offset, offset + LEDGER_PAGE_SIZE), nextCursor };
  }
  async function selectedFacts(
    current: LedgerDeliveryEmployee,
    selection: LedgerPdfSelectionItem[],
    requireComplete = false
  ) {
    const facts = await repository.facts(current, selectionScope(selection), {
      selection,
      requireComplete
    });
    const byKey = new Map(facts.map((fact) => [partitionIdentity(fact.key), fact]));
    const selected = selection.flatMap((item) => {
      const fact = byKey.get(partitionIdentity({ ...item, orgId: current.orgId }));
      return fact ? [fact] : [];
    });
    if (requireComplete && selected.length !== selection.length)
      return fail("LEDGER_PDF_UNAVAILABLE");
    return selected;
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
            authorizationVersion: current.authorization?.authorizationVersion,
            scope: input.scope
          },
          input.cursor
        )
      };
    },
    async coverageForBrowser(
      input: LedgerBrowserCoverageInput
    ): Promise<{ partitions: LedgerBrowserCoverageItem[]; nextCursor: string | null }> {
      if ((input.scope === undefined) === (input.selection === undefined))
        return fail("LEDGER_SCOPE_INVALID");
      const current = await employee(input.employee);
      const selection = input.selection === undefined ? undefined : parseSelection(input.selection);
      const facts = selection
        ? await selectedFacts(current, selection)
        : await repository.facts(current, input.scope!);
      return page(
        facts.map((fact) => ({
          ...publicFact(fact),
          byteSize:
            fact.status === "ready" &&
            Number.isSafeInteger(fact.entry?.byteSize) &&
            fact.entry!.byteSize > 0
              ? fact.entry!.byteSize
              : null
        })),
        {
          browser: true,
          orgId: current.orgId,
          employeeId: current.id,
          clearance: current.clearance,
          authorizationVersion: current.authorization?.authorizationVersion,
          scope: input.scope,
          selection
        },
        input.cursor
      );
    },
    async openLedgerPdf(input: {
      employee: LedgerDeliveryEmployee;
      selection: LedgerPdfSelectionItem;
    }): Promise<{ stream: Readable; fileName: string; byteSize: number }> {
      const current = await employee(input.employee);
      const selection = parseSelection([input.selection]);
      const facts = await selectedFacts(current, selection, true);
      const entry = facts[0]!.entry;
      if (
        facts[0]!.status !== "ready" ||
        !entry ||
        !Number.isSafeInteger(entry.byteSize) ||
        entry.byteSize <= 0
      )
        return fail("LEDGER_PDF_NOT_READY");
      const source = (await storage.getObjectStream(entry.objectKey)) as Readable;
      let sourceError: Error | undefined;
      source.on("error", (error: Error) => {
        sourceError = error;
      });
      try {
        const fresh = await employee(current);
        const freshFacts = await selectedFacts(fresh, selection, true);
        readyCapturedLedgerBundleEntries(freshFacts, [entry]);
        if (sourceError) throw sourceError;
        if (repository.commitDownloadIssue) await repository.commitDownloadIssue(fresh, undefined);
        const stream = Readable.from(
          (async function* () {
            const hash = createHash("sha256");
            let bytes = 0;
            try {
              for await (const chunk of source) {
                const buffer = Buffer.from(chunk as Uint8Array);
                bytes += buffer.length;
                if (bytes > entry.byteSize) return fail("LEDGER_PDF_BUNDLE_STALE");
                hash.update(buffer);
                yield buffer;
              }
              if (bytes !== entry.byteSize || hash.digest("hex") !== entry.checksumSha256)
                return fail("LEDGER_PDF_BUNDLE_STALE");
            } finally {
              source.destroy();
            }
          })()
        );
        stream.once("close", () => source.destroy());
        return { stream, fileName: ledgerPdfFileName(selection[0]!), byteSize: entry.byteSize };
      } catch (error) {
        source.destroy();
        throw error;
      }
    },
    async requestSelectedLedgerBundle(input: {
      employee: LedgerDeliveryEmployee;
      selection: LedgerPdfSelectionItem[];
      idempotencyKey: string;
    }) {
      const current = await employee(input.employee);
      const selection = parseSelection(input.selection);
      const entries = readyLedgerBundleEntries(await selectedFacts(current, selection, true));
      return repository.reserveBundle({
        employee: current,
        manifest: { version: 1, scope: selectionScope(selection), entries },
        idempotencyKey: input.idempotencyKey,
        fingerprint: createHash("sha256")
          .update(JSON.stringify(["download-selection", current.orgId, current.id, selection]))
          .digest("hex")
      });
    },
    async requestLedgerBundle(input: {
      employee: LedgerDeliveryEmployee;
      scope: LedgerScope;
      idempotencyKey: string;
    }) {
      const current = await employee(input.employee);
      const scope = parseLedgerScope(input.scope);
      const entries = readyLedgerBundleEntries(
        await repository.facts(current, scope, { requireComplete: true })
      );
      return repository.reserveBundle({
        employee: current,
        manifest: { version: 1, scope, entries },
        idempotencyKey: input.idempotencyKey,
        fingerprint: ledgerBundleFingerprint(current, scope)
      });
    },
    async status(input: {
      employee: LedgerDeliveryEmployee;
      requestId: string;
      cursor?: string;
      downloadOnly?: boolean;
    }) {
      const current = await employee(input.employee);
      const request = await repository.request(current, input.requestId);
      // Browser callers cannot inherit the legacy admin refresh-status exception.
      if (!request || (input.downloadOnly && request.kind !== "download"))
        return fail("LEDGER_PDF_UNAVAILABLE");
      const items = request.items;
      const partitions: {
        storeName: string;
        purchaseDate: string;
        status: string;
        errorCode?: string;
        latestRequest?: LedgerRequestRef;
      }[] =
        request.kind === "download"
          ? (request.bundle?.manifest.entries ?? []).map((e) => ({
              storeName: e.key.storeName,
              purchaseDate: e.key.purchaseDate,
              status: request.status
            }))
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
        ...(request.rebuildRequired ? { errorCode: "LEDGER_DOWNLOAD_REBUILD_REQUIRED" } : {}),
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
      try {
        const current = await employee(input.employee);
        const request = await repository.request(current, input.requestId);
        const bundle = request?.bundle;
        if (request?.rebuildRequired) return fail("LEDGER_DOWNLOAD_REBUILD_REQUIRED");
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
        const selection = bundle.manifest.entries.map(({ key: { storeName, purchaseDate } }) => ({
          storeName,
          purchaseDate
        }));
        const facts = await selectedFacts(current, selection);
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
        if (
          current.authorization &&
          (fresh.authorization?.authorizationVersion !==
            current.authorization.authorizationVersion ||
            fresh.authorization?.mode !== current.authorization.mode)
        )
          return fail("AUTHORIZATION_VERSION_CONFLICT");
        const freshFacts = await selectedFacts(fresh, selection);
        if (!freshFacts.length) return fail("LEDGER_PDF_UNAVAILABLE");
        const latest = readyCapturedLedgerBundleEntries(freshFacts, bundle.manifest.entries);
        if (!ledgerBundleEntriesEqual(latest, bundle.manifest.entries))
          return fail("LEDGER_PDF_BUNDLE_STALE");
        const result = {
          requestId: input.requestId,
          downloadUrl,
          expiresAt: new Date(
            Math.min(now().getTime() + expiresInSeconds * 1000, bundle.zipExpiresAt.getTime())
          ).toISOString()
        };
        return repository.commitDownloadIssue
          ? repository.commitDownloadIssue(current, result)
          : result;
      } catch (cause) {
        if (cause instanceof LedgerDeliveryError && cause.code === "LEDGER_PDF_UNAVAILABLE")
          await repository.auditDenied?.(input.employee, input.requestId, cause.code);
        throw cause;
      }
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
    entries.length > LEDGER_BUNDLE_LIMITS.files ||
    new Set(entries.map((e) => partitionIdentity(e.key))).size !== entries.length
  )
    return fail("LEDGER_BUNDLE_MANIFEST_INVALID");
  return { version: 1, scope, entries };
}

/** Internal worker check: fixed IDs and content, independent of requester grants. */
export async function ledgerBundleContentCurrent(
  tx: Prisma.TransactionClient,
  orgId: string,
  entries: LedgerBundleEntry[]
): Promise<boolean> {
  if (!entries.length || entries.some((e) => e.key.orgId !== orgId)) return false;
  await tx.$queryRaw(
    Prisma.sql`SELECT org_id FROM business_authorization_states WHERE org_id=${orgId} FOR SHARE`
  );
  const ids = entries.map((e) => e.partitionId);
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM ledger_pdf_partitions WHERE org_id=${orgId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`
  );
  const pointers = await tx.ledgerPdfPartition.findMany({ where: { orgId, id: { in: ids } } });
  const byId = new Map(pointers.map((p) => [p.id, p]));
  for (const entry of entries) {
    const p = byId.get(entry.partitionId);
    if (
      !p ||
      p.orgId !== entry.key.orgId ||
      p.storeName !== entry.key.storeName ||
      p.purchaseDate.toISOString().slice(0, 10) !== entry.key.purchaseDate ||
      p.currentObjectKey !== entry.objectKey ||
      p.publishedGeneration !== entry.generation ||
      p.dataRevision !== entry.dataRevision ||
      p.publishedDataRevision !== entry.dataRevision ||
      p.publishedSourceFingerprint !== entry.sourceFingerprint ||
      p.checksumSha256 !== entry.checksumSha256 ||
      Number(p.byteSize) !== entry.byteSize
    )
      return false;
    const metadata = await readLedgerSourceMetadata(tx, entry.key);
    if (metadata.sourceFingerprint !== entry.sourceFingerprint) return false;
  }
  return createPrismaLedgerArtifactAccess({ prisma: tx }).sourcesAreCurrent({
    orgId,
    sources: [
      ...new Map(
        entries
          .flatMap((e) => e.sources)
          .map((source) => [
            JSON.stringify([
              source.sourceDocumentId,
              source.kind,
              source.checksumSha256,
              source.contentVersion,
              source.businessContentVersion
            ]),
            source
          ])
      ).values()
    ],
    tx
  });
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
    if (!current) return null;
    const authorization = await currentLedgerAuthorization(prisma, employee.id, employee.orgId);
    return authorization.disabled
      ? null
      : {
          ...employee,
          role: authorization.role,
          clearance: authorization.clearance,
          disabled: authorization.disabled,
          authorization
        };
  }
  async function readFact(
    tx: Prisma.TransactionClient,
    key: LedgerPartitionKey,
    employee: LedgerDeliveryEmployee,
    preloaded?: LedgerSourceMetadata
  ): Promise<LedgerPdfFact | null> {
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
    const authorization =
      employee.authorization ?? (await currentLedgerAuthorization(tx, employee.id, key.orgId));
    if (
      !(await canReadLedgerPdf(
        tx,
        authorization,
        key,
        metadata.sources,
        partition?.id,
        partition?.confidentialityLevel
      ))
    )
      return null;
    let sources = metadata.sources;
    const ready =
      partition &&
      partition.publishedGeneration !== null &&
      partition.publishedGeneration > 0 &&
      partition.publishedDataRevision === partition.dataRevision &&
      partition.publishedSourceFingerprint === metadata.sourceFingerprint &&
      partition.currentObjectKey &&
      partition.checksumSha256 &&
      Number.isSafeInteger(Number(partition.byteSize)) &&
      Number(partition.byteSize) > 0;
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
      !(await canReadLedgerPdf(
        tx,
        authorization,
        key,
        sources,
        partition?.id,
        partition?.confidentialityLevel
      )) ||
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
    async commitDownloadIssue(employee, result) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT org_id FROM business_authorization_states WHERE org_id=${employee.orgId} FOR SHARE`
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM employees WHERE org_id=${employee.orgId} AND id=${employee.id} FOR SHARE`
        );
        const current = await currentLedgerAuthorization(tx, employee.id, employee.orgId);
        if (
          current.disabled ||
          current.mode === "suspended" ||
          !employee.authorization ||
          current.mode !== employee.authorization.mode ||
          current.authorizationVersion !== employee.authorization.authorizationVersion
        )
          return fail("AUTHORIZATION_VERSION_CONFLICT");
        return result;
      });
    },
    async auditDenied(employee, requestId, code) {
      await prisma.auditLog.create({
        data: {
          orgId: employee.orgId,
          actorEmployeeId: employee.id,
          action: "ledger_pdf_download.url_denied",
          targetType: "ledger_artifact_request",
          targetId: requestId,
          result: "denied",
          metadata: { code }
        }
      });
    },
    async facts(employee, scope, options) {
      if (!employee.authorization) {
        const current = await currentEmployee(employee);
        if (!current) return [];
        employee = current;
      }
      const dates = ledgerScopeDates(
        parseLedgerScope({ ...scope, storeNames: scope.storeNames ?? ["__date_validation__"] })
      );
      const facts: LedgerPdfFact[] = [];
      let cursor: string | undefined;
      do {
        const page = options?.selection
          ? {
              keys: parseSelection(options.selection).map((item) => ({
                ...item,
                orgId: employee.orgId
              })),
              nextCursor: null
            }
          : await archive.listPartitionKeys({
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
          if (options?.requireComplete && results.filter(Boolean).length !== batch.length)
            return fail("LEDGER_PDF_UNAVAILABLE");
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
        // Permission mutations serialize on this state row; recheck every captured PDF at acceptance.
        await tx.$queryRaw(
          Prisma.sql`SELECT org_id FROM business_authorization_states WHERE org_id=${employee.orgId} FOR SHARE`
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM employees WHERE org_id=${employee.orgId} AND id=${employee.id} FOR SHARE`
        );
        const authorization = await currentLedgerAuthorization(tx, employee.id, employee.orgId);
        if (authorization.disabled) return fail("LEDGER_PDF_UNAVAILABLE");
        for (const entry of manifest.entries) {
          if (
            entry.key.orgId !== employee.orgId ||
            !(await canReadLedgerPdf(
              tx,
              authorization,
              entry.key,
              entry.sources,
              entry.partitionId
            ))
          )
            return fail("LEDGER_PDF_UNAVAILABLE");
        }
        if (!(await ledgerBundleContentCurrent(tx, employee.orgId, manifest.entries)))
          return fail("LEDGER_PDF_BUNDLE_STALE");
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
      let manifest: LedgerBundleManifest | null = null;
      let rebuildRequired = false;
      if (request.kind === "download") {
        try {
          manifest = parseLedgerBundleManifest(request.scope);
        } catch (error) {
          if (
            !(error instanceof LedgerDeliveryError) ||
            error.code !== "LEDGER_BUNDLE_MANIFEST_INVALID"
          )
            throw error;
          rebuildRequired = true;
        }
      }
      const stored =
        request.scope && typeof request.scope === "object" && !Array.isArray(request.scope)
          ? request.scope
          : {};
      const scope = manifest?.scope ?? parseLedgerScope(stored["scope"] ?? request.scope);
      const items = [];
      for (const i of request.items) {
        const key = {
          orgId: employee.orgId,
          storeName: i.partition.storeName,
          purchaseDate: i.partition.purchaseDate.toISOString().slice(0, 10)
        };
        let latestRequest: LedgerRequestRef | null = null;
        if (i.status === "superseded") {
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
        ...(rebuildRequired ? { rebuildRequired: true } : {}),
        allowEmptyRequest:
          request.kind === "refresh" &&
          request.actorEmployeeId === employee.id &&
          request.items.length === 0,
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
