import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadApiEnv } from "./env.js";

const originalDatabaseUrl = process.env["DATABASE_URL"];
const originalCursorSecret = process.env["CURSOR_SIGNING_SECRET"];
const tempDirs: string[] = [];

afterEach(async () => {
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("CURSOR_SIGNING_SECRET", originalCursorSecret);

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadApiEnv", () => {
  it("loads API environment variables from a local .env file without overriding existing values", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-api-env-"));
    tempDirs.push(tempDir);
    await writeFile(
      path.join(tempDir, ".env"),
      [
        "DATABASE_URL=mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub",
        "CURSOR_SIGNING_SECRET=from-dotenv"
      ].join("\n")
    );

    delete process.env["DATABASE_URL"];
    process.env["CURSOR_SIGNING_SECRET"] = "from-shell";

    loadApiEnv(tempDir);

    expect(process.env["DATABASE_URL"]).toBe(
      "mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub"
    );
    expect(process.env["CURSOR_SIGNING_SECRET"]).toBe("from-shell");
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
