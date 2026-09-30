import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
const url = process.env["DATABASE_URL"] ?? "";
(process.env["RUN_PDF_RELEASE_PRISMA_INTEGRATION"] === "1" ? describe : describe.skip)(
  "exact PDF job parking on owned local MySQL",
  () => {
    it("parks only unfinished PDF runs, preserves original times on repeat, and releases only owned attempts", async () => {
      const local = url === "mysql://smedc:smedc_local_password@127.0.0.1:13307/smedc";
      const ci =
        process.env["CI"] === "true" &&
        process.env["COMPOSE_PROJECT_NAME"] === "sme_data_center_ci" &&
        url === "mysql://smedc:smedc_local_password@127.0.0.1:3307/smedc";
      if (!local && !ci) throw new Error("Dedicated owned local PDF DB required.");
      const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) });
      const orgId = `pdf-park-${randomUUID().slice(0, 8)}`;
      const employeeId = `pp_${randomUUID().slice(0, 16)}`;
      const directory = await mkdtemp(join(tmpdir(), "smedc-pdf-park-"));
      const original = new Date("2026-01-02T03:04:05.678Z");
      const invoke = (command: string) =>
        execFileSync(
          process.execPath,
          ["--import", "tsx", "scripts/pdf-release.ts", command, directory],
          { env: process.env, stdio: "pipe" }
        );
      try {
        await prisma.organization.create({ data: { id: orgId, name: "Synthetic parking" } });
        await prisma.employee.create({
          data: {
            id: employeeId,
            orgId,
            email: `${orgId}@example.invalid`,
            displayName: "Synthetic",
            role: "employee",
            clearance: 0
          }
        });
        const fixture = async (
          label: string,
          fileType: "pdf" | "md",
          status: "queued" | "running" | "succeeded" = "queued"
        ) => {
          const id = `ppd_${label}_${randomUUID().slice(0, 8)}`;
          await prisma.document.create({
            data: {
              id,
              orgId,
              uploaderId: employeeId,
              documentType: "raw_material",
              documentKind: "evidence",
              title: "Synthetic",
              status: "pending_processing",
              fileType,
              storageObjectKey: `synthetic/${id}`,
              originalFileName: `${id}.${fileType}`,
              checksumSha256: "a".repeat(64),
              confidentialityLevel: 0
            }
          });
          return prisma.processingRun.create({
            data: {
              orgId,
              documentId: id,
              jobType: "evidence_document_index",
              jobKey: `park:${id}`,
              availableAt: original,
              status
            }
          });
        };
        const queued = await fixture("queued", "pdf");
        const running = await fixture("running", "pdf", "running");
        const finished = await fixture("finished", "pdf", "succeeded");
        const general = await fixture("general", "md");
        invoke("park");
        const manifest = JSON.parse(await readFile(join(directory, "parked-runs.json"), "utf8"));
        expect(manifest.runs.find((run: { id: string }) => run.id === queued.id).availableAt).toBe(
          "2026-01-02T03:04:05.678Z"
        );
        expect(
          (
            await prisma.processingRun.findUniqueOrThrow({ where: { id: queued.id } })
          ).availableAt.getUTCFullYear()
        ).toBe(9999);
        expect(
          (await prisma.processingRun.findUniqueOrThrow({ where: { id: general.id } })).availableAt
        ).toEqual(original);
        expect(
          (await prisma.processingRun.findUniqueOrThrow({ where: { id: finished.id } })).availableAt
        ).toEqual(original);
        invoke("park");
        expect(
          JSON.parse(await readFile(join(directory, "parked-runs.json"), "utf8")).runs.find(
            (run: { id: string }) => run.id === queued.id
          ).availableAt
        ).toBe("2026-01-02T03:04:05.678Z");
        await prisma.processingRun.update({
          where: { id: running.id },
          data: { attemptNumber: 2 }
        });
        expect(() => invoke("restore")).toThrow(/ownership changed/);
        expect(
          JSON.parse(await readFile(join(directory, "parked-runs.json"), "utf8")).runs
        ).toHaveLength(1);
        await prisma.processingRun.update({
          where: { id: running.id },
          data: { availableAt: original }
        });
        invoke("restore");
        expect(
          (await prisma.processingRun.findUniqueOrThrow({ where: { id: queued.id } })).availableAt
        ).toEqual(original);
        expect(
          (await prisma.processingRun.findUniqueOrThrow({ where: { id: running.id } }))
            .attemptNumber
        ).toBe(2);
        await expect(readFile(join(directory, "parked-runs.json"))).rejects.toMatchObject({
          code: "ENOENT"
        });
      } finally {
        // Restore any write-ahead records before deleting only this test's fixtures.
        try {
          await prisma.processingRun.updateMany({
            where: { orgId, availableAt: new Date("9999-01-01T00:00:00.000Z") },
            data: { availableAt: original }
          });
          invoke("restore");
        } finally {
          await prisma.pdfEvidenceAttempt.deleteMany({ where: { orgId } });
          await prisma.processingRun.deleteMany({ where: { orgId } });
          await prisma.document.deleteMany({ where: { orgId } });
          await prisma.employee.deleteMany({ where: { id: employeeId } });
          await prisma.organization.deleteMany({ where: { id: orgId } });
          await prisma.$disconnect();
          await rm(directory, { recursive: true, force: true });
        }
      }
    }, 30_000);
  }
);
