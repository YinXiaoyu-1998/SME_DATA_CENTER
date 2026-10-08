import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";

export function integrationDatabasePlan(baseUrl: string, mysqlPort: string) {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("Integration database must use an explicit loopback MySQL URL.");
  }
  assert(
    base.protocol === "mysql:" &&
      ["localhost", "127.0.0.1"].includes(base.hostname) &&
      /^[1-9]\d{0,4}$/.test(mysqlPort) &&
      Number(mysqlPort) <= 65535 &&
      (base.port || "3306") === mysqlPort &&
      base.search === "" &&
      base.hash === "" &&
      /^\/[a-zA-Z0-9_]+$/.test(base.pathname),
    "Integration database URL must match the loopback MYSQL_PORT without overrides."
  );
  const schema = `smedc_integration_${randomUUID().replaceAll("-", "")}`;
  const database = new URL(base);
  database.pathname = `/${schema}`;
  return { schema, databaseUrl: database.href, baseUrl: base.href };
}

export async function createOwnedIntegrationDatabase(baseUrl: string, mysqlPort: string) {
  const plan = integrationDatabasePlan(baseUrl, mysqlPort);
  const connect = () => new PrismaClient({ adapter: createDatabaseAdapter(plan.baseUrl) });
  const prisma = connect();
  try {
    // No IF NOT EXISTS: only a successful new CREATE establishes ownership.
    await prisma.$executeRawUnsafe(`CREATE DATABASE \`${plan.schema}\``);
  } finally {
    await prisma.$disconnect();
  }
  let owned = true;
  return {
    schema: plan.schema,
    databaseUrl: plan.databaseUrl,
    async cleanup() {
      if (!owned) return;
      const cleanup = connect();
      try {
        await cleanup.$executeRawUnsafe(`DROP DATABASE \`${plan.schema}\``);
        owned = false;
      } finally {
        await cleanup.$disconnect();
      }
    }
  };
}
