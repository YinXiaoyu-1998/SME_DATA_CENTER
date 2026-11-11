import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "./adapter.js";

const run = process.env["RUN_DEPARTMENT_PRECHECK_INTEGRATION"] === "1";
const suite = run ? describe : describe.skip;
const url = process.env["DATABASE_URL"] ?? "";
if (run) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "Department name migration tests require a disposable loopback integration database"
    );
}

// Execute the real migration file so the test covers the guard that ships to production.
const migrationSql = await readFile(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../prisma/migrations/20261111120000_department_name_unique/migration.sql"
  ),
  "utf8"
);
const statements = migrationSql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

suite("department name uniqueness migration", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const orgId = `dept_precheck_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const enterpriseKey = "synthetic";

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic Precheck" } });
    await prisma.businessEnterpriseIdentity.create({
      data: { orgId, enterpriseKey, enterpriseName: "Synthetic Precheck" }
    });
    // Simulate pre-migration data that the byte-exact legacy index tolerated: names that
    // differ only by case are duplicates under the department name column collation.
    await prisma.$executeRawUnsafe(
      "ALTER TABLE `business_departments` DROP INDEX `business_departments_org_enterprise_name_uq`"
    );
    for (const name of ["Coke", "coke"])
      await prisma.businessDepartment.create({
        data: { orgId, enterpriseKey, departmentId: randomUUID(), name }
      });
  });

  afterAll(async () => {
    await prisma.businessDepartment.deleteMany({ where: { orgId } });
    // Restore the post-migration invariant so a shared disposable database is left usable.
    await prisma.$executeRawUnsafe(
      "ALTER TABLE `business_departments` ADD UNIQUE INDEX `business_departments_org_enterprise_name_uq` (`org_id`, `enterprise_key`, `name`)"
    );
    await prisma.businessEnterpriseIdentity.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("aborts on existing duplicates without trimming, renaming or deleting rows", async () => {
    const failure = await prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            "DROP TEMPORARY TABLE IF EXISTS `_business_departments_name_guard`"
          );
          for (const statement of statements) await tx.$executeRawUnsafe(statement);
        },
        { timeout: 30_000 }
      )
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("_business_departments_name_guard");
    const rows = await prisma.businessDepartment.findMany({
      where: { orgId },
      orderBy: { departmentId: "asc" }
    });
    expect(rows.map((row) => row.name).sort()).toEqual(["Coke", "coke"]);
    expect(rows).toHaveLength(2);
  });
});
