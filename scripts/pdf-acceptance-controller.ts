import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@smedc/storage";
import { createPrismaAuthOperatorRepository } from "../apps/api/src/auth/prisma-auth-operator-repository.js";
import {
  AUTH_LIFETIMES_MS,
  generateOpaqueSecret,
  hashOpaqueSecret
} from "../apps/api/src/auth/primitives.js";
import {
  createPrismaPdfEvidenceAttemptRepository,
  pdfCandidateIdentity,
  reconcilePdfEvidenceAttempt,
  type PdfEvidenceAttempt
} from "../apps/worker/src/evidence-artifacts.js";
import {
  cleanupPdfAcceptanceRun,
  preparePdfAcceptanceCleanup,
  parsePdfAcceptanceArgs,
  PDF_ACCOUNTS,
  pdfAccountEmail,
  pdfObjectPrefixes,
  validatePdfAcceptanceManifest,
  type PdfAcceptanceArgs,
  type PdfAcceptanceInventory,
  type PdfAcceptanceManifest
} from "./pdf-acceptance-support.js";

export async function dispatchAcceptanceProfile(
  args: string[],
  d: { pdf(args: PdfAcceptanceArgs): Promise<void>; legacy(): Promise<void> }
) {
  const pdf = parsePdfAcceptanceArgs(args);
  if (pdf) await d.pdf(pdf);
  else await d.legacy();
}
export async function readPdfManifest(file: string, runId: string) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 4 * 1024 * 1024 ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("PDF manifest must be a bounded private regular file owned by this operator.");
  const manifest = validatePdfAcceptanceManifest(JSON.parse(await readFile(file, "utf8")));
  if (manifest.runId !== runId) throw new Error("PDF manifest run ID mismatch.");
  return manifest;
}
export async function writePdfManifest(file: string, m: PdfAcceptanceManifest) {
  validatePdfAcceptanceManifest(m);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(m, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
    const dir = await open(path.dirname(file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
export interface PdfExternalResources {
  storage: StorageAdapter;
  collection: string;
  listPoints(orgIds: string[], pointIds: string[]): Promise<PdfAcceptanceInventory["points"]>;
  deletePoints(pointIds: string[], collection: string): Promise<void>;
}
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const pointIds = (v: unknown): string[] => {
  if (!Array.isArray(v) || !v.every((id) => typeof id === "string") || new Set(v).size !== v.length)
    throw new Error("Invalid authoritative PDF point list.");
  return v;
};

export async function setupPdfAcceptanceRun(
  prisma: PrismaClient,
  m: PdfAcceptanceManifest,
  save: (m: PdfAcceptanceManifest) => Promise<void>
) {
  validatePdfAcceptanceManifest(m);
  if (m.phase !== "setup" || m.documentIds.length)
    throw new Error("PDF setup cannot reuse a completed/uploaded run.");
  await save(m); // Recovery seed precedes DB creation.
  await prisma.$transaction(async (tx) => {
    for (const [index, id] of m.orgIds.entries()) {
      const existing = await tx.organization.findUnique({ where: { id } });
      const name = `PDF acceptance ${m.runId} ${index === 0 ? "a" : "b"}`;
      if (existing && existing.name !== name)
        throw new Error("PDF organization already exists with different ownership.");
      if (!existing) await tx.organization.create({ data: { id, name } });
    }
  });
  const repository = createPrismaAuthOperatorRepository(prisma);
  for (const account of PDF_ACCOUNTS) {
    const email = pdfAccountEmail(m.runId, account);
    const orgId = m.orgIds[account.startsWith("a-") ? 0 : 1];
    const role = account === "a-admin" ? "admin" : "employee";
    const clearance = account === "a-admin" ? 0 : 3;
    let employee = await prisma.employee.findUnique({ where: { email } });
    if (
      employee &&
      (employee.orgId !== orgId || employee.role !== role || employee.clearance !== clearance)
    )
      throw new Error("PDF setup account ownership mismatch.");
    if (!employee) {
      // Reuse official operator onboarding. No setup URL/secret is returned or persisted.
      // Human setup is subsequently issued with the official reset-password operator command.
      const now = new Date();
      const result = await repository.onboard({
        orgId,
        normalizedEmail: email,
        displayName: `PDF acceptance ${m.runId} ${account}`,
        role,
        clearance,
        grantTokenHash: hashOpaqueSecret(generateOpaqueSecret("eh_ps_")),
        grantExpiresAt: new Date(now.getTime() + AUTH_LIFETIMES_MS.passwordSetupGrant),
        now
      });
      employee = await prisma.employee.findUniqueOrThrow({ where: { id: result.employeeId } });
    }
    if (!m.employeeIds.includes(employee.id)) m.employeeIds.push(employee.id);
    await save(m);
  }
  const employees = await prisma.employee.findMany({ where: { orgId: { in: m.orgIds } } });
  if (
    !sameSet(
      employees.map((e) => e.id),
      m.employeeIds
    )
  )
    throw new Error("Unregistered account in PDF setup organizations.");
}

async function dbResources(prisma: PrismaClient, m: PdfAcceptanceManifest) {
  const docs = await prisma.document.findMany({
    where: { OR: [{ orgId: { in: m.orgIds } }, { id: { in: m.documentIds } }] },
    include: { indexes: true, chunks: true, processingRuns: true }
  });
  const attempts = await prisma.pdfEvidenceAttempt.findMany({
    where: { OR: [{ orgId: { in: m.orgIds } }, { id: { in: m.attemptIds } }] }
  });
  const expectedKeys = [
    ...new Set([...docs.map((d) => d.storageObjectKey), ...attempts.map((a) => a.parsedObjectKey)])
  ];
  const expectedPoints = [
    ...new Set([
      ...docs.flatMap((d) =>
        d.chunks.map((c) => c.qdrantPointId).filter((id): id is string => id !== null)
      ),
      ...attempts.flatMap((a) => pointIds(a.pointIds))
    ])
  ];
  return { docs, attempts, expectedKeys, expectedPoints };
}
export async function registerPdfDocument(
  prisma: PrismaClient,
  m: PdfAcceptanceManifest,
  documentId: string,
  e: PdfExternalResources,
  save: (m: PdfAcceptanceManifest) => Promise<void>
) {
  if (!["setup", "registered"].includes(m.phase))
    throw new Error("PDF run is closed for registration.");
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  if (
    !m.orgIds.includes(doc.orgId) ||
    !m.employeeIds.includes(doc.uploaderId) ||
    doc.fileType !== "pdf" ||
    doc.sourceSystem !== `pdf_acceptance_${m.runId}`
  )
    throw new Error("PDF document registration ownership mismatch.");
  if (!m.documentIds.includes(documentId)) m.documentIds.push(documentId);
  const r = await dbResources(prisma, m);
  r.docs = r.docs.filter((d) => m.documentIds.includes(d.id));
  r.attempts = r.attempts.filter((a) => m.documentIds.includes(a.documentId));
  r.expectedKeys = [
    ...new Set([
      ...r.docs.map((d) => d.storageObjectKey),
      ...r.attempts.map((a) => a.parsedObjectKey)
    ])
  ];
  r.expectedPoints = [
    ...new Set([
      ...r.docs.flatMap((d) =>
        d.chunks.map((c) => c.qdrantPointId).filter((id): id is string => id !== null)
      ),
      ...r.attempts.flatMap((a) => pointIds(a.pointIds))
    ])
  ];
  if (
    r.docs.some((d) => d.indexes.some((i) => i.qdrantCollection !== e.collection)) ||
    r.attempts.some((a) => a.collection !== e.collection)
  )
    throw new Error("PDF collection ownership mismatch.");
  m.collection = e.collection;
  m.objectKeys = r.expectedKeys;
  m.pointIds = r.expectedPoints;
  m.attemptIds = r.attempts.map((a) => a.id);
  m.phase = "registered";
  await save(m);
}

export async function inventoryPdfAcceptanceRun(
  prisma: PrismaClient,
  m: PdfAcceptanceManifest,
  e: PdfExternalResources
): Promise<PdfAcceptanceInventory> {
  if (!e.storage.listObjectKeys) throw new Error("PDF cleanup requires bounded storage inventory.");
  if (m.collection && m.collection !== e.collection)
    throw new Error("PDF collection does not match configured runtime.");
  const r = await dbResources(prisma, m);
  const orgs = await prisma.organization.findMany({
    where: { id: { in: m.orgIds } },
    select: { id: true, name: true }
  });
  if (orgs.length === 1)
    throw new Error("Missing dedicated PDF organization; ownership unavailable.");
  const employees = await prisma.employee.findMany({
    where: { OR: [{ orgId: { in: m.orgIds } }, { id: { in: m.employeeIds } }] },
    select: { id: true, orgId: true, email: true, role: true, clearance: true }
  });
  const unexpected: string[] = [];
  const where = { orgId: { in: m.orgIds } };
  const counts = await Promise.all([
    prisma.importBatch.count({ where }),
    prisma.partitionImportJob.count({ where }),
    prisma.structuredPartition.count({ where }),
    prisma.vipRow.count({ where }),
    prisma.dishCatalogRow.count({ where }),
    prisma.deliveryLedgerRow.count({ where }),
    prisma.supplierCatalogRow.count({ where }),
    prisma.quarantineCertificate.count({ where }),
    prisma.skillEntry.count({ where }),
    prisma.storageGarbage.count({
      where: {
        OR: pdfObjectPrefixes(m.orgIds).map((prefix) => ({ objectKey: { startsWith: prefix } }))
      }
    })
  ]);
  if (counts.some((n) => n > 0)) unexpected.push("non-PDF resource");
  const orphanRuns = await prisma.processingRun.count({
    where: {
      orgId: { in: m.orgIds },
      OR: [{ documentId: null }, { documentId: { notIn: m.documentIds } }]
    }
  });
  if (orphanRuns) unexpected.push("unregistered processing run");
  // Never trust client-added resource lists, even if its private manifest claims cleanup phase.
  if (r.docs.length || r.attempts.length) {
    if (
      !sameSet(m.objectKeys, r.expectedKeys) ||
      !sameSet(m.pointIds, r.expectedPoints) ||
      !sameSet(
        m.attemptIds,
        r.attempts.map((a) => a.id)
      )
    )
      unexpected.push("resource manifest mismatch; register after terminal processing");
  } else if (orgs.length && (m.objectKeys.length || m.pointIds.length || m.attemptIds.length))
    unexpected.push("missing authoritative ownership");
  const objects = (
    await Promise.all(pdfObjectPrefixes(m.orgIds).map((p) => e.storage.listObjectKeys!(p)))
  ).flat();
  const points = await e.listPoints(m.orgIds, m.pointIds);
  if (!r.docs.length && !r.attempts.length && (objects.length || points.length))
    unexpected.push("missing authoritative external ownership");
  for (const doc of r.docs) {
    if (!doc.storageObjectKey.startsWith(`org/${doc.orgId}/documents/${doc.id}/original/`))
      unexpected.push("original object ownership mismatch");
  }
  return {
    orgs,
    employees,
    documents: r.docs,
    attempts: r.attempts.map((a) => ({
      id: a.id,
      orgId: a.orgId,
      documentId: a.documentId,
      settled: a.acceptanceRunId === m.runId
    })),
    objectKeys: objects,
    points,
    unexpected
  };
}

export async function preventPdfAcceptanceClaims(prisma: PrismaClient, m: PdfAcceptanceManifest) {
  await prisma.$transaction(async (tx) => {
    for (const id of m.orgIds)
      await tx.$queryRaw(Prisma.sql`SELECT id FROM organizations WHERE id=${id} FOR UPDATE`);
    for (const id of m.documentIds)
      await tx.$queryRaw(Prisma.sql`SELECT id FROM documents WHERE id=${id} FOR UPDATE`);
    const runs = await tx.processingRun.findMany({
      where: { orgId: { in: m.orgIds }, documentId: { in: m.documentIds } }
    });
    for (const run of runs) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM processing_runs WHERE id=${run.id} FOR UPDATE`);
      const current = await tx.processingRun.findUniqueOrThrow({ where: { id: run.id } });
      if (current.status === "running")
        throw new Error(
          "PDF processing has not settled; retain run recovery state and retry after its worker finishes."
        );
    }
    const attempts = await tx.pdfEvidenceAttempt.findMany({ where: { orgId: { in: m.orgIds } } });
    for (const snapshot of attempts) {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM pdf_evidence_attempts WHERE id=${snapshot.id} FOR UPDATE`
      );
      const a = await tx.pdfEvidenceAttempt.findUniqueOrThrow({ where: { id: snapshot.id } });
      if (
        !m.attemptIds.includes(a.id) ||
        !m.documentIds.includes(a.documentId) ||
        a.collection !== m.collection ||
        !m.objectKeys.includes(a.parsedObjectKey) ||
        pointIds(a.pointIds).some((id) => !m.pointIds.includes(id))
      )
        throw new Error("PDF cleanup proof resource ownership mismatch.");
      if (a.acceptanceRunId && a.acceptanceRunId !== m.runId)
        throw new Error("PDF attempt already belongs to another cleanup proof.");
      const doc = await tx.document.findUniqueOrThrow({ where: { id: a.documentId } });
      const run = await tx.processingRun.findUnique({ where: { id: a.runId } });
      if (
        doc.orgId !== a.orgId ||
        doc.contentVersion !== a.contentVersion ||
        !m.employeeIds.includes(doc.uploaderId)
      )
        throw new Error("PDF proof document ownership changed.");
      if (doc.checksumSha256) {
        const identity = pdfCandidateIdentity(
          {
            id: a.runId,
            orgId: a.orgId,
            documentId: a.documentId,
            attemptNumber: a.attemptNumber,
            document: { contentVersion: a.contentVersion }
          } as never,
          doc.checksumSha256,
          a.parserFingerprint,
          a.retrievalConfigVersion
        );
        if (
          identity.id !== a.id ||
          identity.generation !== a.generation ||
          identity.parsedObjectKey !== a.parsedObjectKey
        )
          throw new Error("PDF proof attempt identity changed.");
      }
      if (a.acceptanceRunId === m.runId) {
        if (
          !run ||
          run.orgId !== a.orgId ||
          run.documentId !== a.documentId ||
          run.status !== "succeeded" ||
          run.attemptNumber !== a.attemptNumber ||
          !doc.checksumSha256
        )
          throw new Error("PDF persisted proof processing identity changed.");
        continue;
      }
      const index = await tx.documentIndex.findFirst({
        where: { documentId: a.documentId, parsedObjectKey: a.parsedObjectKey },
        include: { chunks: true, retrievalConfig: true }
      });
      // A failure/timeout, expired lease, recovery state or elapsed time cannot establish settlement.
      if (
        a.state !== "active" ||
        doc.status !== "active" ||
        !run ||
        run.status !== "succeeded" ||
        run.orgId !== a.orgId ||
        run.documentId !== a.documentId ||
        run.attemptNumber !== a.attemptNumber ||
        !index ||
        index.status !== "ready"
      )
        continue;
      if (
        doc.orgId !== a.orgId ||
        doc.contentVersion !== a.contentVersion ||
        index.orgId !== a.orgId ||
        index.contentVersion !== a.contentVersion ||
        index.parserFingerprint !== a.parserFingerprint ||
        index.qdrantCollection !== a.collection ||
        index.retrievalConfig.version !== a.retrievalConfigVersion ||
        !doc.checksumSha256 ||
        index.indexedChunkCount !== pointIds(a.pointIds).length ||
        !sameSet(
          index.chunks.map((c) => c.qdrantPointId).filter((id): id is string => id !== null),
          pointIds(a.pointIds)
        )
      )
        throw new Error("PDF successful publication does not match its complete cleanup proof.");
      const update = await tx.pdfEvidenceAttempt.updateMany({
        where: {
          id: a.id,
          acceptanceRunId: null,
          state: "active",
          generation: a.generation,
          parsedObjectKey: a.parsedObjectKey
        },
        data: { acceptanceRunId: m.runId }
      });
      if (update.count !== 1) throw new Error("PDF cleanup proof changed concurrently.");
    }
    await tx.employee.updateMany({
      where: { id: { in: m.employeeIds }, orgId: { in: m.orgIds } },
      data: { disabled: true }
    });
    await tx.processingRun.updateMany({
      where: {
        orgId: { in: m.orgIds },
        documentId: { in: m.documentIds },
        status: { in: ["queued", "retry_scheduled"] }
      },
      data: { status: "failed", errorCode: "PDF_ACCEPTANCE_CLEANUP", finishedAt: new Date() }
    });
  });
}
export async function cleanupPrismaPdfAcceptanceRun(
  prisma: PrismaClient,
  m: PdfAcceptanceManifest,
  e: PdfExternalResources,
  save: (m: PdfAcceptanceManifest) => Promise<void>,
  prepareOnly = false
) {
  const repository = createPrismaPdfEvidenceAttemptRepository(prisma);
  return (prepareOnly ? preparePdfAcceptanceCleanup : cleanupPdfAcceptanceRun)(m, {
    inventory: () => inventoryPdfAcceptanceRun(prisma, m, e),
    save,
    preventClaims: () => preventPdfAcceptanceClaims(prisma, m),
    detach: async () => {
      await prisma.$transaction(async (tx) => {
        await tx.document.updateMany({
          where: { id: { in: m.documentIds }, orgId: { in: m.orgIds } },
          data: { status: "archived", archivedAt: new Date() }
        });
        await tx.documentChunk.deleteMany({
          where: { documentId: { in: m.documentIds }, document: { orgId: { in: m.orgIds } } }
        });
        await tx.documentIndex.deleteMany({
          where: { documentId: { in: m.documentIds }, orgId: { in: m.orgIds } }
        });
      });
    },
    reconcile: async () => {
      const rows = await prisma.pdfEvidenceAttempt.findMany({
        where: { id: { in: m.attemptIds }, orgId: { in: m.orgIds } }
      });
      for (const row of rows) {
        const result = await reconcilePdfEvidenceAttempt({
          attempt: { ...row, pointIds: pointIds(row.pointIds) } as PdfEvidenceAttempt,
          repository,
          storage: e.storage,
          qdrantWriter: {
            deleteEvidencePoints: (input) => e.deletePoints(input.pointIds, input.collection)
          }
        });
        if (result !== "cleaned")
          throw new Error("PDF attempt remains owned/live; recovery required.");
      }
    },
    deleteObjects: async (keys) => {
      for (const key of keys) await e.storage.deleteObject(key);
    },
    deletePoints: e.deletePoints,
    removeRows: async () => {
      await prisma.$transaction(async (tx) => {
        const attempts = await tx.pdfEvidenceAttempt.findMany({
          where: { id: { in: m.attemptIds } }
        });
        if (
          attempts.some(
            (a) =>
              a.acceptanceRunId !== m.runId || a.state !== "cleaned" || !m.orgIds.includes(a.orgId)
          )
        )
          throw new Error("Missing authoritative PDF settlement proof; recovery required.");
        await tx.document.deleteMany({
          where: { id: { in: m.documentIds }, orgId: { in: m.orgIds } }
        });
        // Exact synthetic org ownership was checked twice; reject non-PDF rows before this phase.
        await tx.oAuthAccessToken.deleteMany({
          where: { orgId: { in: m.orgIds }, employeeId: { in: m.employeeIds } }
        });
        await tx.authSecurityEvent.deleteMany({ where: { orgId: { in: m.orgIds } } });
        await tx.deviceAuthorization.deleteMany({
          where: { orgId: { in: m.orgIds }, employeeId: { in: m.employeeIds } }
        });
        await tx.authSession.deleteMany({
          where: { orgId: { in: m.orgIds }, employeeId: { in: m.employeeIds } }
        });
        await tx.loginIdentity.deleteMany({
          where: { orgId: { in: m.orgIds }, employeeId: { in: m.employeeIds } }
        });
        await tx.auditLog.deleteMany({ where: { orgId: { in: m.orgIds } } });
        await tx.employee.deleteMany({
          where: { orgId: { in: m.orgIds }, id: { in: m.employeeIds } }
        });
        await tx.pdfEvidenceAttempt.deleteMany({
          where: {
            id: { in: m.attemptIds },
            orgId: { in: m.orgIds },
            acceptanceRunId: m.runId,
            state: "cleaned"
          }
        });
        for (const [index, id] of m.orgIds.entries())
          await tx.organization.deleteMany({
            where: { id, name: `PDF acceptance ${m.runId} ${index === 0 ? "a" : "b"}` }
          });
      });
    }
  });
}

export function createPdfQdrantResources(input: {
  url: string;
  apiKey?: string;
  collection: string;
  storage: StorageAdapter;
}): PdfExternalResources {
  const request = async (operation: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(
      `${input.url}/collections/${encodeURIComponent(input.collection)}/points${operation}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.apiKey ? { "api-key": input.apiKey } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      }
    );
    if (!response.ok) throw new Error(`PDF Qdrant operation failed: HTTP ${response.status}`);
    const result = (await response.json()) as { result: Record<string, unknown> };
    return result.result;
  };
  return {
    storage: input.storage,
    collection: input.collection,
    deletePoints: async (ids, collection) => {
      if (collection !== input.collection && ids.length)
        throw new Error("PDF Qdrant collection ownership mismatch.");
      if (ids.length) await request("/delete?wait=true", { points: ids });
    },
    listPoints: async (orgIds, ids) => {
      const rows: Array<Record<string, unknown>> = [];
      let offset: unknown;
      const offsets = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const result = await request("/scroll", {
          filter: { must: [{ key: "orgId", match: { any: orgIds } }] },
          limit: 500,
          with_payload: true,
          with_vector: false,
          ...(offset !== undefined ? { offset } : {})
        });
        if (!Array.isArray(result["points"]))
          throw new Error("PDF Qdrant inventory returned invalid data.");
        rows.push(...result["points"]);
        if (rows.length > 10000) throw new Error("PDF Qdrant inventory exceeded bound.");
        offset = result["next_page_offset"];
        if (offset === null || offset === undefined) break;
        const token = JSON.stringify(offset);
        if (offsets.has(token) || page === 19)
          throw new Error("PDF Qdrant inventory exceeded pagination bound.");
        offsets.add(token);
      }
      if (ids.length) {
        const exact = (await request("", {
          ids,
          with_payload: true,
          with_vector: false
        })) as unknown;
        if (!Array.isArray(exact))
          throw new Error("PDF Qdrant exact inventory returned invalid data.");
        rows.push(...exact);
      }
      const unique = new Map<string, PdfAcceptanceInventory["points"][number]>();
      for (const row of rows) {
        const payload = row["payload"] as Record<string, unknown>;
        if (
          typeof row["id"] !== "string" ||
          typeof payload?.["orgId"] !== "string" ||
          typeof payload["documentId"] !== "string"
        )
          throw new Error("PDF Qdrant point ownership unavailable.");
        unique.set(row["id"], {
          id: row["id"],
          orgId: payload["orgId"],
          documentId: payload["documentId"],
          collection: input.collection
        });
      }
      return [...unique.values()];
    }
  };
}
