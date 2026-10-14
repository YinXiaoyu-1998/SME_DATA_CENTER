import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseAdapter, lookupShelfLives, upsertShelfLifeCatalog } from "@smedc/db";
import type { StructuredParseResult } from "@smedc/structured-ingestion";
import { createPrismaProcessingWorkerRepository } from "../apps/worker/src/worker.js";
import { createOwnedIntegrationDatabase } from "./test-integration-support.js";
import { importShelfLifeCatalog } from "./shelf-life-catalog-support.js";

describe.skipIf(process.env["RUN_SHELF_LIFE_CATALOG_INTEGRATION"] !== "1")(
  "enterprise shelf-life catalog",
  () => {
    let database: Awaited<ReturnType<typeof createOwnedIntegrationDatabase>>;
    let prisma: PrismaClient;
    let directory: string;
    let employeeId: string;
    const orgId = "catalog-target";
    const otherId = "catalog-other";
    const entries = [
      { itemName: "Juice", shelfLife: "12月" },
      { itemName: "juice", shelfLife: "24月" },
      { itemName: "Ｊuice", shelfLife: "36月" },
      { itemName: "Juice ", shelfLife: "见包装" }
    ];
    const command = { orgId, orgName: "Synthetic", execute: true, operator: "test-operator" };

    beforeAll(async () => {
      const port = process.env["MYSQL_PORT"] ?? "3307";
      database = await createOwnedIntegrationDatabase(
        process.env["DATABASE_URL"] ?? `mysql://smedc:smedc_local_password@127.0.0.1:${port}/smedc`,
        port
      );
      execFileSync(
        "node_modules/.bin/prisma",
        ["migrate", "deploy", "--config", "packages/db/prisma.config.ts"],
        { env: { ...process.env, DATABASE_URL: database.databaseUrl }, stdio: "pipe" }
      );
      prisma = new PrismaClient({ adapter: createDatabaseAdapter(database.databaseUrl) });
      directory = mkdtempSync(join(tmpdir(), "smedc-catalog-test-"));
      writeFileSync(
        join(directory, "catalog.csv"),
        "\uFEFF物品名,保质期\n" +
          entries.map((entry) => `${entry.itemName},${entry.shelfLife}`).join("\n")
      );
      for (const id of [orgId, otherId])
        await prisma.organization.create({ data: { id, name: "Synthetic" } });
      employeeId = (
        await prisma.employee.create({
          data: {
            orgId,
            email: "catalog@example.invalid",
            displayName: "Fixture",
            role: "admin",
            clearance: 3
          }
        })
      ).id;
    }, 60000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await database?.cleanup();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it("previews and merges exact tenant entries through the real CLI, preserving unrelated records", async () => {
      await prisma.$transaction((tx) =>
        upsertShelfLifeCatalog(tx, otherId, [{ itemName: "Juice", shelfLife: "other tenant" }])
      );
      const run = (execute: boolean) =>
        JSON.parse(
          execFileSync(
            "node_modules/.bin/tsx",
            [
              "scripts/shelf-life-catalog.ts",
              "--org-id",
              orgId,
              "--org-name",
              "Synthetic",
              "--input",
              join(directory, "catalog.csv"),
              ...(execute ? ["--execute", "--operator", "test-operator"] : [])
            ],
            { env: { ...process.env, DATABASE_URL: database.databaseUrl }, encoding: "utf8" }
          )
        );
      expect(run(false)).toMatchObject({ mode: "dry-run", inserted: 4, updated: 0, unchanged: 0 });
      expect(await prisma.shelfLifeCatalogEntry.count({ where: { orgId } })).toBe(0);
      expect(await prisma.auditLog.count()).toBe(0);
      expect(run(true)).toMatchObject({ inserted: 4, updated: 0, unchanged: 0 });
      expect(run(true)).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
      expect(await prisma.auditLog.count()).toBe(4);
      expect(
        await prisma.$transaction((tx) =>
          lookupShelfLives(tx, orgId, [...entries.map((entry) => entry.itemName), "JUICE"])
        )
      ).toEqual(new Map(entries.map((entry) => [entry.itemName, entry.shelfLife])));
      expect(
        await prisma.$transaction((tx) => lookupShelfLives(tx, otherId, ["Juice", "juice"]))
      ).toEqual(new Map([["Juice", "other tenant"]]));
      await expect(
        importShelfLifeCatalog(prisma, { ...command, orgName: "Wrong" }, entries)
      ).rejects.toThrow("mismatch");
      expect(await prisma.processingRun.count()).toBe(0);
      expect(await prisma.ledgerPdfPartition.count()).toBe(0);
    });

    it("rolls back catalog mutations and their audit if the transaction fails", async () => {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_catalog_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic audit failure'`);
      try {
        await expect(
          importShelfLifeCatalog(prisma, command, [
            { itemName: "Juice", shelfLife: "rollback" },
            { itemName: "New", shelfLife: "rollback" }
          ])
        ).rejects.toThrow();
      } finally {
        await prisma.$executeRawUnsafe("DROP TRIGGER reject_catalog_audit");
      }
      expect(await prisma.shelfLifeCatalogEntry.count({ where: { orgId } })).toBe(4);
      expect(await prisma.$transaction((tx) => lookupShelfLives(tx, orgId, ["Juice"]))).toEqual(
        new Map([["Juice", "12月"]])
      );
      expect(await prisma.auditLog.count()).toBe(4);
    });

    async function receipt(suffix: string, stale = false) {
      const now = new Date();
      const document = await prisma.document.create({
        data: {
          orgId,
          title: "Synthetic receipt",
          documentType: "structured_dataset",
          documentKind: "structured",
          fileType: "csv",
          status: "processing",
          storageObjectKey: "synthetic",
          uploaderId: employeeId
        }
      });
      const batch = await prisma.importBatch.create({
        data: {
          orgId,
          sourceDocumentId: document.id,
          dataset: "delivery_ledger",
          status: "applying",
          idempotencyKey: suffix,
          requestFingerprint: suffix
        }
      });
      const run = await prisma.processingRun.create({
        data: {
          orgId,
          documentId: document.id,
          jobKey: suffix,
          jobType: "structured_import",
          status: "running",
          attemptNumber: 1,
          lockedBy: "catalog-worker",
          lockedUntil: new Date(now.getTime() + (stale ? -1000 : 120000))
        }
      });
      const result: StructuredParseResult = {
        sheetSummary: [
          { sheetIndex: 0, name: "Receipt", hidden: false, headerRowNumber: 1, dataRowCount: 5 }
        ],
        ignoredSheets: [],
        validationErrors: [],
        validationErrorCount: 0,
        validationErrorsTruncated: false,
        rows: [...entries.map((entry) => entry.itemName), "JUICE"].map((itemName, index) => ({
          sourceSheetIndex: 0,
          sourceSheetName: "Receipt",
          sourceRowNumber: index + 2,
          payload: {
            item_name: itemName,
            receipt_id: suffix,
            store_name: "Store",
            purchase_date: "2026-10-01",
            purchase_quantity: "1",
            shelf_life: null
          }
        }))
      };
      const repository = createPrismaProcessingWorkerRepository(database.databaseUrl);
      try {
        const completion = repository.completeStructuredImport!({
          runId: run.id,
          documentId: document.id,
          importBatchId: batch.id,
          dataset: "delivery_ledger",
          workerId: "catalog-worker",
          attemptNumber: 1,
          now,
          batchInsertSize: 2,
          result
        });
        if (stale) {
          await expect(completion).rejects.toThrow();
          expect(await prisma.deliveryLedgerRow.count({ where: { importBatchId: batch.id } })).toBe(
            0
          );
          expect(
            (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).status
          ).toBe("running");
        } else await completion;
        expect(result.rows.every((row) => row.payload["shelf_life"] === null)).toBe(true);
        return batch.id;
      } finally {
        await repository.disconnect?.();
      }
    }

    it("fills exact matches on real worker publication, leaves misses empty, and snapshots later catalog changes", async () => {
      const first = await receipt("first");
      const rows = async (id: string) =>
        (
          await prisma.deliveryLedgerRow.findMany({
            where: { importBatchId: id },
            orderBy: { sourceRowNumber: "asc" }
          })
        ).map((row) => row.payload as Prisma.JsonObject);
      expect((await rows(first)).map((row) => row["shelf_life"])).toEqual([
        "12月",
        "24月",
        "36月",
        "见包装",
        null
      ]);
      expect((await rows(first))[0]).toMatchObject({
        purchase_quantity: "1",
        receipt_id: "first",
        store_name: "Store",
        purchase_date: "2026-10-01"
      });
      expect(
        await importShelfLifeCatalog(prisma, command, [{ itemName: "Juice", shelfLife: "新值" }])
      ).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
      const second = await receipt("second");
      expect((await rows(first))[0]!["shelf_life"]).toBe("12月");
      expect((await rows(second)).map((row) => row["shelf_life"])).toEqual([
        "新值",
        "24月",
        "36月",
        "见包装",
        null
      ]);
      expect(await prisma.shelfLifeCatalogEntry.count({ where: { orgId } })).toBe(4);
      const revision = (await prisma.ledgerPdfPartition.findFirstOrThrow({ where: { orgId } }))
        .dataRevision;
      await receipt("stale", true);
      expect(
        (await prisma.ledgerPdfPartition.findFirstOrThrow({ where: { orgId } })).dataRevision
      ).toBe(revision);
    });
  }
);
