import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "@smedc/db";
import { createOwnedIntegrationDatabase } from "./test-integration-support.js";
import { updateLedgerShelfLife } from "./ledger-shelf-life-support.js";

describe.skipIf(process.env["RUN_LEDGER_SHELF_LIFE_INTEGRATION"] !== "1")(
  "shelf-life database maintenance",
  () => {
    let database: Awaited<ReturnType<typeof createOwnedIntegrationDatabase>>;
    let prisma: PrismaClient;
    let targetId: string;
    let otherId: string;
    let fixtureDirectory: string;
    const orgId = "shelf-life-target";
    const mappings = [
      { itemName: "加多宝", shelfLife: "24月" },
      { itemName: "Juice", shelfLife: "12月" }
    ];
    const command = { orgId, orgName: "Synthetic", execute: false, operator: "test-operator" };

    beforeAll(async () => {
      const port = process.env["MYSQL_PORT"] ?? "3307";
      database = await createOwnedIntegrationDatabase(
        process.env["DATABASE_URL"] ?? `mysql://smedc:smedc_local_password@127.0.0.1:${port}/smedc`,
        port
      );
      execFileSync(
        "node_modules/.bin/prisma",
        ["migrate", "deploy", "--config", "packages/db/prisma.config.ts"],
        {
          env: { ...process.env, DATABASE_URL: database.databaseUrl },
          stdio: "pipe"
        }
      );
      prisma = new PrismaClient({ adapter: createDatabaseAdapter(database.databaseUrl) });
      fixtureDirectory = mkdtempSync(join(tmpdir(), "smedc-shelf-life-test-"));
      writeFileSync(join(fixtureDirectory, "mapping.json"), JSON.stringify(mappings));
      for (const org of [orgId, "shelf-life-other"]) {
        await prisma.organization.create({ data: { id: org, name: "Synthetic" } });
        const employee = await prisma.employee.create({
          data: {
            orgId: org,
            email: `${org}@example.invalid`,
            displayName: "Fixture",
            role: "admin",
            clearance: 3
          }
        });
        for (const mode of ["active", "archived", "pending"] as const) {
          const document = await prisma.document.create({
            data: {
              orgId: org,
              title: "Synthetic receipt",
              documentType: "structured_dataset",
              documentKind: "structured",
              fileType: "xlsx",
              status: mode === "archived" ? "archived" : "active",
              archivedAt: mode === "archived" ? new Date() : null,
              storageObjectKey: "synthetic",
              uploaderId: employee.id
            }
          });
          const batch = await prisma.importBatch.create({
            data: {
              orgId: org,
              sourceDocumentId: document.id,
              dataset: "delivery_ledger",
              idempotencyKey: randomUUID(),
              requestFingerprint: "fixture",
              status: mode === "pending" ? "pending" : "applied"
            }
          });
          const names =
            mode === "active"
              ? ["加多宝", "加多宝", "加多宝 ", "Juice", "juice", "Ｊuice", "Other"]
              : ["加多宝"];
          for (const [index, itemName] of names.entries()) {
            const row = await prisma.deliveryLedgerRow.create({
              data: {
                orgId: org,
                sourceDocumentId: document.id,
                importBatchId: batch.id,
                sourceRowNumber: index + 1,
                payload: {
                  item_name: itemName,
                  shelf_life: index === 1 ? "24月" : null,
                  store_name: "Store",
                  purchase_date: "2026-10-01",
                  purchase_quantity: "1",
                  receipt_id: "fixture"
                }
              }
            });
            if (index === 0 && mode === "active") {
              if (org === orgId) targetId = row.id;
              else otherId = row.id;
            }
          }
        }
      }
    }, 60000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await database?.cleanup();
      if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
    });

    it("previews then updates only exact active tenant matches, with audit and one revision per partition", async () => {
      const runCli = (execute: boolean) =>
        JSON.parse(
          execFileSync(
            "node_modules/.bin/tsx",
            [
              "scripts/ledger-shelf-life.ts",
              "--org-id",
              orgId,
              "--org-name",
              "Synthetic",
              "--input",
              join(fixtureDirectory, "mapping.json"),
              ...(execute ? ["--execute", "--operator", "test-operator"] : [])
            ],
            { env: { ...process.env, DATABASE_URL: database.databaseUrl }, encoding: "utf8" }
          )
        );
      expect(runCli(false)).toMatchObject({
        totalRows: 7,
        matchedRows: 3,
        changedRows: 2,
        updatedRows: 0,
        affectedPartitions: 1
      });
      expect(await prisma.auditLog.count()).toBe(0);
      expect(await prisma.ledgerPdfPartition.count()).toBe(0);
      expect(
        (await prisma.deliveryLedgerRow.findUniqueOrThrow({ where: { id: targetId } })).payload
      ).toMatchObject({ shelf_life: null });
      expect(runCli(true)).toMatchObject({
        totalRows: 7,
        matchedRows: 3,
        changedRows: 2,
        updatedRows: 2,
        affectedPartitions: 1
      });
      const updated = (
        await prisma.deliveryLedgerRow.findUniqueOrThrow({ where: { id: targetId } })
      ).payload;
      expect(updated).toMatchObject({
        item_name: "加多宝",
        shelf_life: "24月",
        purchase_quantity: "1"
      });
      expect(
        (await prisma.deliveryLedgerRow.findUniqueOrThrow({ where: { id: otherId } })).payload
      ).toMatchObject({ shelf_life: null });
      expect(
        await prisma.auditLog.findMany({ select: { targetId: true, metadata: true } })
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetId,
            metadata: expect.objectContaining({
              before: null,
              after: "24月",
              operator: "test-operator"
            })
          })
        ])
      );
      expect(await prisma.auditLog.count()).toBe(2);
      expect((await prisma.ledgerPdfPartition.findFirstOrThrow()).dataRevision).toBe(1);
      expect(await prisma.processingRun.count()).toBe(0);
      expect(await prisma.ledgerArtifactRequest.count()).toBe(0);
      const unchanged = await prisma.deliveryLedgerRow.findMany({
        where: { orgId },
        select: { payload: true }
      });
      expect(
        unchanged.filter((r) => (r.payload as Prisma.JsonObject)["shelf_life"] === null)
      ).toHaveLength(6);
      expect(
        await updateLedgerShelfLife(prisma, { ...command, execute: true }, mappings)
      ).toMatchObject({
        matchedRows: 3,
        changedRows: 0,
        updatedRows: 0,
        affectedPartitions: 0
      });
      expect(await prisma.auditLog.count()).toBe(2);
      expect((await prisma.ledgerPdfPartition.findFirstOrThrow()).dataRevision).toBe(1);
    });

    it("refuses a mismatched organization name before changes", async () => {
      await expect(
        updateLedgerShelfLife(prisma, { ...command, orgName: "Wrong", execute: true }, mappings)
      ).rejects.toThrow();
      expect(await prisma.auditLog.count()).toBe(2);
    });

    it("rolls back row updates and audits if partition publication fails", async () => {
      const partition = await prisma.ledgerPdfPartition.findFirstOrThrow();
      await prisma.ledgerPdfPartition.update({
        where: { id: partition.id },
        data: { storeName: "Hash collision fixture" }
      });
      await expect(
        updateLedgerShelfLife(prisma, { ...command, execute: true }, [
          { itemName: "加多宝", shelfLife: "36月" }
        ])
      ).rejects.toThrow();
      expect(
        (await prisma.deliveryLedgerRow.findUniqueOrThrow({ where: { id: targetId } })).payload
      ).toMatchObject({ shelf_life: "24月" });
      expect(await prisma.auditLog.count()).toBe(2);
      expect((await prisma.ledgerPdfPartition.findFirstOrThrow()).dataRevision).toBe(1);
    });
  }
);
