import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "@smedc/db";
import { createPrismaLedgerArchiveRepository } from "./repository.js";
import { createLedgerArchiveService } from "./service.js";
import { ledgerStoreNameHash } from "./keys.js";
import { parseLedgerCliArgs, runLedgerCli } from "../../../scripts/ledger-pdf-support.js";

const enabled = process.env["RUN_LEDGER_PRISMA_INTEGRATION"] === "1";
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (enabled) {
  const url = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("ledger_test"))
    throw new Error("Local synthetic ledger_test database required");
}

(enabled ? describe : describe.skip)("durable ledger archive requests", () => {
  const orgId = `ledger_test_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `${orgId}_other`;
  const pagedOrgId = `${orgId}_paged`;
  let first: PrismaClient;
  let second: PrismaClient;
  let service: ReturnType<typeof createLedgerArchiveService>;
  let competing: ReturnType<typeof createLedgerArchiveService>;
  const actor = { kind: "operator" as const, label: "synthetic-ops" };
  const key = { orgId, storeName: "Synthetic a/b", purchaseDate: "2024-02-29" };

  beforeAll(async () => {
    first = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
    second = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
    service = createLedgerArchiveService(createPrismaLedgerArchiveRepository({ prisma: first }));
    competing = createLedgerArchiveService(createPrismaLedgerArchiveRepository({ prisma: second }));
    await first.organization.createMany({
      data: [
        { id: orgId, name: "Synthetic ledger test" },
        { id: otherOrgId, name: "Other synthetic ledger test" },
        { id: pagedOrgId, name: "Paged synthetic ledger test" }
      ]
    });
  });
  afterAll(async () => {
    const where = { orgId: { in: [orgId, otherOrgId, pagedOrgId] } };
    await first.auditLog.deleteMany({ where });
    await first.processingRun.deleteMany({ where });
    await first.ledgerPdfSource.deleteMany({ where });
    await first.ledgerArtifactRequestItem.deleteMany({ where });
    await first.ledgerArtifactRequest.updateMany({ where, data: { retryOfRequestId: null } });
    await first.ledgerArtifactRequest.deleteMany({ where });
    await first.ledgerPdfPartition.deleteMany({ where });
    await first.deliveryLedgerRow.deleteMany({ where });
    await first.importBatch.deleteMany({ where });
    await first.document.deleteMany({ where });
    await first.employee.deleteMany({ where });
    await first.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId, pagedOrgId] } } });
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  });

  it("durable paged developer CLI resumes one request across two clients and dry-run writes zero", async () => {
    const orgId = pagedOrgId;
    await first.ledgerPdfPartition.createMany({
      data: Array.from({ length: 205 }, (_, index) => {
        const storeName = `Paged synthetic ${String(index).padStart(3, "0")}`;
        return {
          orgId,
          storeName,
          storeNameHash: ledgerStoreNameHash(storeName),
          purchaseDate: new Date("2024-02-29T00:00:00Z")
        };
      })
    });
    const uploader = await first.employee.create({
      data: {
        orgId,
        email: `${orgId}@example.invalid`,
        displayName: "Paged fixture uploader",
        role: "admin",
        clearance: 3
      }
    });
    const source = await first.document.create({
      data: {
        orgId,
        uploaderId: uploader.id,
        title: "Paged synthetic source",
        documentType: "structured_dataset",
        documentKind: "structured",
        status: "active",
        storageObjectKey: `synthetic/${orgId}/source.xlsx`
      }
    });
    const batch = await first.importBatch.create({
      data: {
        orgId,
        sourceDocumentId: source.id,
        dataset: "delivery_ledger",
        status: "applied",
        idempotencyKey: "paged-source",
        requestFingerprint: "f".repeat(64)
      }
    });
    await first.deliveryLedgerRow.create({
      data: {
        orgId,
        sourceDocumentId: source.id,
        importBatchId: batch.id,
        sourceRowNumber: 1,
        payload: { store_name: "Paged unindexed", purchase_date: "2020-01-01", amount: "12.34" }
      }
    });
    const counts = () =>
      Promise.all([
        first.ledgerPdfPartition.count({ where: { orgId } }),
        first.ledgerArtifactRequest.count({ where: { orgId } }),
        first.ledgerArtifactRequestItem.count({ where: { orgId } }),
        first.processingRun.count({ where: { orgId } }),
        first.auditLog.count({ where: { orgId } })
      ]);
    const before = await counts();
    const original = await first.deliveryLedgerRow.findMany({ where: { orgId } });
    const output: unknown[] = [];
    await runLedgerCli(
      parseLedgerCliArgs(["refresh", "--org-id", orgId, "--all-stores", "--all-dates"]),
      { archive: service, now: () => new Date(), output: (value) => output.push(value) }
    );
    expect(output.at(-1)).toMatchObject({ mode: "dry-run", partitionCount: 206, storeCount: 206 });
    expect(await counts()).toEqual(before);
    const image = process.env["LEDGER_CLI_TEST_IMAGE"];
    if (image) {
      const containerUrl = new URL(databaseUrl);
      containerUrl.hostname = "host.docker.internal";
      const result = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--env",
          "DATABASE_URL",
          "--env",
          "STORAGE_DRIVER=local",
          "--env",
          "LOCAL_STORAGE_ROOT=/tmp/smedc-ledger-cli-unused",
          image,
          "node",
          "dist/release/ledger-pdf.js",
          "refresh",
          "--org-id",
          orgId,
          "--all-stores",
          "--all-dates",
          "--allow-remote"
        ],
        { encoding: "utf8", env: { ...process.env, DATABASE_URL: containerUrl.href } }
      );
      expect(result).toContain('"partitionCount":206');
      expect(result).toContain('"mode":"dry-run"');
      expect(await counts()).toEqual(before);
    }
    const selection = { storeNames: null, dates: null };
    const input = { orgId, actor, idempotencyKey: "paged-resume", selection };
    const repo1 = createPrismaLedgerArchiveRepository({ prisma: first });
    const repo2 = createPrismaLedgerArchiveRepository({ prisma: second });
    const root = await repo1.beginInternalRefresh!({
      ...input,
      requestFingerprint: createHash("sha256")
        .update(JSON.stringify({ kind: "internal_refresh", orgId, actor, selection }))
        .digest("hex")
    });
    expect((await service.getRequestStatus({ orgId, requestId: root.requestId }))?.status).toBe(
      "queued"
    );
    const page = await repo1.listPartitionKeys({ orgId });
    expect(page.keys).toHaveLength(200);
    const append = { orgId, requestId: root.requestId, expectedCursor: null, ...page };
    const [one, two] = await Promise.all([
      repo1.appendInternalRefreshPage!(append),
      repo2.appendInternalRefreshPage!(append)
    ]);
    expect(one.cursor).toBe(two.cursor);
    expect(
      await first.ledgerArtifactRequestItem.count({ where: { orgId, requestId: root.requestId } })
    ).toBe(200);
    await first.ledgerArtifactRequestItem.updateMany({
      where: { orgId, requestId: root.requestId },
      data: { status: "succeeded" }
    });
    expect((await service.getRequestStatus({ orgId, requestId: root.requestId }))?.status).toBe(
      "running"
    );
    const [resumed, competingResume] = await Promise.all([
      service.requestAllPartitions(input),
      competing.requestAllPartitions(input)
    ]);
    expect(resumed.requestId).toBe(root.requestId);
    if (image) {
      const containerUrl = new URL(databaseUrl);
      containerUrl.hostname = "host.docker.internal";
      const result = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--env",
          "DATABASE_URL",
          image,
          "node",
          "dist/release/ledger-pdf.js",
          "status",
          "--org-id",
          orgId,
          "--request-id",
          root.requestId,
          "--allow-remote"
        ],
        { encoding: "utf8", env: { ...process.env, DATABASE_URL: containerUrl.href } }
      );
      expect(result).toContain(`"requestId":"${root.requestId}"`);
      expect(result).toContain('"command":"status"');
    }

    expect(competingResume.requestId).toBe(root.requestId);
    expect(await first.ledgerArtifactRequest.count({ where: { orgId } })).toBe(1);
    expect(await first.ledgerArtifactRequestItem.count({ where: { orgId } })).toBe(206);
    expect(await first.processingRun.count({ where: { orgId } })).toBe(206);
    expect(await first.deliveryLedgerRow.findMany({ where: { orgId } })).toEqual(original);
    const audit = await first.auditLog.findFirstOrThrow({ where: { orgId } });
    expect(audit.actorEmployeeId).toBeNull();
    expect(audit.metadata).toMatchObject({
      actor: { kind: "operator", label: "synthetic-ops" },
      scope: { selection }
    });
    await expect(
      service.requestAllPartitions({
        ...input,
        selection: { storeNames: ["Different"], dates: null }
      })
    ).rejects.toThrow("LEDGER_IDEMPOTENCY_CONFLICT");
    const failed = await first.ledgerArtifactRequestItem.findFirstOrThrow({
      where: { orgId, requestId: root.requestId }
    });
    await first.ledgerArtifactRequestItem.update({
      where: { id: failed.id },
      data: { status: "failed" }
    });
    const retry = await service.retryFailedRequest({
      orgId,
      requestId: root.requestId,
      actor,
      idempotencyKey: "paged-retry"
    });
    expect(await service.getRequestStatus({ orgId, requestId: retry.requestId })).toMatchObject({
      retryOfRequestId: root.requestId,
      items: [{ partitionId: failed.partitionId }]
    });
    expect(
      await first.ledgerArtifactRequestItem.count({ where: { orgId, requestId: retry.requestId } })
    ).toBe(1);
  }, 30_000);

  it("reserves one idempotent request across two connections and keeps generations monotonic", async () => {
    const input = { key, actor, idempotencyKey: "concurrent-key", onlyIfNeeded: false };
    const [one, two] = await Promise.all([
      service.requestPartitionRefresh(input),
      competing.requestPartitionRefresh(input)
    ]);
    expect(one?.requestId).toBe(two?.requestId);
    expect(await first.ledgerArtifactRequest.count({ where: { orgId } })).toBe(1);
    expect(await first.ledgerArtifactRequestItem.count({ where: { orgId } })).toBe(1);
    expect(await first.document.count({ where: { orgId } })).toBe(0);
    const jobs = await first.processingRun.findMany({ where: { orgId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      documentId: null,
      priority: 10,
      jobType: "ledger_pdf_generate"
    });
    await expect(
      competing.requestPartitionRefresh({ ...input, key: { ...key, storeName: "Different" } })
    ).rejects.toThrow("LEDGER_IDEMPOTENCY_CONFLICT");
    await expect(
      competing.requestPartitionRefresh({
        ...input,
        actor: { kind: "operator", label: "other-operator" }
      })
    ).rejects.toThrow("LEDGER_IDEMPOTENCY_CONFLICT");
    const [next, last] = await Promise.all([
      service.requestPartitionRefresh({ ...input, idempotencyKey: "next-key" }),
      competing.requestPartitionRefresh({ ...input, idempotencyKey: "last-key" })
    ]);
    const generations = await first.ledgerArtifactRequestItem.findMany({
      where: { orgId },
      orderBy: { generation: "asc" }
    });
    expect(generations.map((item) => item.generation)).toEqual([1, 2, 3]);
    expect(new Set([one?.requestId, next?.requestId, last?.requestId]).size).toBe(3);
    const other = await service.requestPartitionRefresh({
      ...input,
      key: { ...key, orgId: otherOrgId }
    });
    expect(other?.requestId).not.toBe(one?.requestId);
    expect(
      await service.getRequestStatus({ orgId: otherOrgId, requestId: one!.requestId })
    ).toBeNull();
  });

  it("rejects prefixed UTF-8 paths before any durable reservation, including direct repository use", async () => {
    const repository = createPrismaLedgerArchiveRepository({
      prisma: first,
      objectKeyPrefix: `/${"中".repeat(180)}/`
    });
    const prefixedService = createLedgerArchiveService(repository);
    expect(repository.objectKeyPrefix).toBe("中".repeat(180));
    const counts = () =>
      Promise.all([
        first.ledgerPdfPartition.count({ where: { orgId } }),
        first.ledgerArtifactRequest.count({ where: { orgId } }),
        first.ledgerArtifactRequestItem.count({ where: { orgId } }),
        first.processingRun.count({ where: { orgId } }),
        first.auditLog.count({ where: { orgId } })
      ]);
    const before = await counts();
    const oversizedKey = { ...key, storeName: "a".repeat(512) };
    const scope = { storeNames: [oversizedKey.storeName], dates: [key.purchaseDate] };
    await expect(prefixedService.previewRefresh({ orgId, scope })).rejects.toThrow(
      "LEDGER_OBJECT_KEY_TOO_LONG"
    );
    await expect(
      prefixedService.requestRefresh({ orgId, scope, actor, idempotencyKey: "oversize-public" })
    ).rejects.toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
    await expect(
      repository.reserveRefresh({
        orgId,
        scope,
        keys: [oversizedKey],
        actor,
        idempotencyKey: "oversize-direct",
        requestFingerprint: "b".repeat(64)
      })
    ).rejects.toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
    expect(await counts()).toEqual(before);
  });

  it("keeps case-sensitive idempotency keys distinct", async () => {
    const upper = await service.requestPartitionRefresh({
      key,
      actor,
      idempotencyKey: "Case-Key",
      onlyIfNeeded: false
    });
    const lower = await service.requestPartitionRefresh({
      key,
      actor,
      idempotencyKey: "case-key",
      onlyIfNeeded: false
    });
    expect(lower?.requestId).not.toBe(upper?.requestId);
    const padded = await service.requestPartitionRefresh({
      key,
      actor,
      idempotencyKey: "case-key ",
      onlyIfNeeded: false
    });
    expect(padded?.requestId).not.toBe(lower?.requestId);
  });

  it("dry-run reads existing indexes without creating any records; empty scope queues no jobs", async () => {
    const before = await Promise.all([
      first.ledgerPdfPartition.count(),
      first.ledgerArtifactRequest.count(),
      first.processingRun.count(),
      first.auditLog.count()
    ]);
    const scope = { storeNames: [key.storeName], dates: [key.purchaseDate] };
    expect(await service.previewRefresh({ orgId, scope })).toMatchObject({
      partitionCount: 1,
      estimatedTaskCount: 1
    });
    expect(
      await Promise.all([
        first.ledgerPdfPartition.count(),
        first.ledgerArtifactRequest.count(),
        first.processingRun.count(),
        first.auditLog.count()
      ])
    ).toEqual(before);
    const empty = await service.requestRefresh({
      orgId,
      actor,
      idempotencyKey: "empty-scope",
      scope: { storeNames: ["Absent synthetic store"], dates: [key.purchaseDate] }
    });
    expect(empty?.status).toBe("succeeded");
    expect(await first.processingRun.count()).toBe(before[2]);
    expect((await service.getRequestStatus({ orgId, requestId: empty!.requestId }))?.items).toEqual(
      []
    );
  });

  it("reuses a matching in-flight generation and skips a published current revision", async () => {
    const partition = await first.ledgerPdfPartition.findFirstOrThrow({ where: { orgId } });
    const latest = await first.ledgerArtifactRequestItem.findFirstOrThrow({
      where: { orgId, partitionId: partition.id },
      orderBy: { generation: "desc" }
    });
    const requestCount = await first.ledgerArtifactRequest.count({ where: { orgId } });
    const reused = await service.requestPartitionRefresh({
      key,
      actor,
      idempotencyKey: "revision-guard",
      onlyIfNeeded: true
    });
    expect(reused?.requestId).toBe(latest.requestId);
    expect(await first.ledgerArtifactRequest.count({ where: { orgId } })).toBe(requestCount);
    await first.ledgerArtifactRequestItem.update({
      where: { id: latest.id },
      data: { status: "succeeded" }
    });
    await first.processingRun.updateMany({
      where: { ledgerArtifactRequestItemId: latest.id },
      data: { status: "succeeded" }
    });
    await first.ledgerPdfPartition.update({
      where: { id: partition.id },
      data: {
        currentObjectKey: `synthetic/${orgId}/current.pdf`,
        publishedDataRevision: partition.dataRevision,
        publishedGeneration: partition.requestedGeneration,
        checksumSha256: "a".repeat(64),
        byteSize: 10n,
        rowCount: 1,
        certificateCount: 0,
        templateVersion: "food-purchase-ledger-cn-v2",
        generatedAt: new Date()
      }
    });
    expect(
      await service.requestPartitionRefresh({
        key,
        actor,
        idempotencyKey: "healthy-revision",
        onlyIfNeeded: true
      })
    ).toBeNull();
    expect(await first.ledgerArtifactRequest.count({ where: { orgId } })).toBe(requestCount);
    expect(
      (await first.ledgerPdfPartition.findUniqueOrThrow({ where: { id: partition.id } }))
        .requestedGeneration
    ).toBe(partition.requestedGeneration);
    await first.ledgerPdfPartition.update({
      where: { id: partition.id },
      data: { currentObjectKey: null }
    });
  });

  it("discovers facts without an index and enforces org foreign keys", async () => {
    const employee = await first.employee.create({
      data: {
        orgId,
        email: `${orgId}@example.invalid`,
        displayName: "Synthetic fixture uploader",
        role: "admin",
        clearance: 3
      }
    });
    const document = await first.document.create({
      data: {
        orgId,
        uploaderId: employee.id,
        title: "Synthetic ledger source",
        documentType: "structured_dataset",
        documentKind: "structured",
        status: "active",
        storageObjectKey: `synthetic/${orgId}/fixture.xlsx`
      }
    });
    const batch = await first.importBatch.create({
      data: {
        orgId,
        sourceDocumentId: document.id,
        dataset: "delivery_ledger",
        status: "applied",
        idempotencyKey: "synthetic-fact",
        requestFingerprint: "f".repeat(64)
      }
    });
    await first.deliveryLedgerRow.createMany({
      data: ["Synthetic Unindexed", "synthetic unindexed", "Synthetic Unindexed "].map(
        (storeName, index) => ({
          orgId,
          sourceDocumentId: document.id,
          importBatchId: batch.id,
          sourceRowNumber: index + 1,
          payload: {
            store_name: storeName,
            purchase_date: key.purchaseDate,
            receipt_id: `synthetic-${index}`
          }
        })
      )
    });
    const scope = { storeNames: ["Synthetic Unindexed"], dates: [key.purchaseDate] };
    expect(await service.previewRefresh({ orgId, scope })).toMatchObject({
      partitionCount: 1,
      keys: [{ orgId, storeName: "Synthetic Unindexed", purchaseDate: key.purchaseDate }]
    });
    expect(
      await service.previewRefresh({
        orgId,
        scope: { ...scope, storeNames: ["Synthetic Unindexed "] }
      })
    ).toMatchObject({ partitionCount: 1 });
    expect(
      await service.previewRefresh({
        orgId,
        scope: { ...scope, storeNames: ["Synthetic Unindexed", "Synthetic Unindexed "] }
      })
    ).toMatchObject({ partitionCount: 2 });
    expect(await service.previewRefresh({ orgId: otherOrgId, scope })).toMatchObject({
      partitionCount: 0
    });
    expect(
      await first.ledgerPdfPartition.count({ where: { orgId, storeName: "Synthetic Unindexed" } })
    ).toBe(0);
    const otherPartition = await first.ledgerPdfPartition.findFirstOrThrow({
      where: { orgId: otherOrgId }
    });
    await expect(
      first.ledgerPdfSource.create({
        data: {
          orgId: otherOrgId,
          partitionId: otherPartition.id,
          sourceDocumentId: document.id,
          kind: "ledger",
          confidentialityLevel: 0,
          checksumSha256: "a".repeat(64)
        }
      })
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      service.requestRefresh({
        orgId: otherOrgId,
        actor: { kind: "employee", employeeId: employee.id },
        idempotencyKey: "wrong-org-actor",
        scope: { storeNames: [key.storeName], dates: [key.purchaseDate] }
      })
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("links superseded status to the latest request and retries only failed items", async () => {
    const items = await first.ledgerArtifactRequestItem.findMany({
      where: { orgId, partition: { storeName: key.storeName } },
      orderBy: { generation: "asc" }
    });
    await first.ledgerArtifactRequestItem.update({
      where: { id: items[0]!.id },
      data: { status: "superseded" }
    });
    await first.ledgerArtifactRequestItem.update({
      where: { id: items[1]!.id },
      data: { status: "failed", errorCode: "LEDGER_RENDER_FAILED" }
    });
    const superseded = await service.getRequestStatus({ orgId, requestId: items[0]!.requestId });
    expect(superseded).toMatchObject({
      status: "failed",
      items: [{ status: "superseded", latestRequest: { requestId: items.at(-1)!.requestId } }]
    });
    const retry = await service.retryFailed({
      orgId,
      requestId: items[1]!.requestId,
      actor,
      idempotencyKey: "retry-failed"
    });
    const result = await service.getRequestStatus({ orgId, requestId: retry!.requestId });
    expect(result).toMatchObject({
      retryOfRequestId: items[1]!.requestId,
      items: [{ generation: items.length + 1 }]
    });
    await first.ledgerArtifactRequestItem.update({
      where: { id: result!.items[0]!.itemId },
      data: { status: "empty" }
    });
    expect((await service.getRequestStatus({ orgId, requestId: retry!.requestId }))?.status).toBe(
      "succeeded"
    );
  });
});
