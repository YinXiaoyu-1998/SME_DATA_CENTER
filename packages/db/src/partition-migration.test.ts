import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../prisma/migrations/20260915102000_business_dishes_oss_partitions/migration.sql",
  import.meta.url
);

describe("business and dishes partition migration", () => {
  it("does not request a storage engine disabled by staging RDS", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).not.toMatch(/ENGINE\s*=\s*MEMORY/i);
  });
});
