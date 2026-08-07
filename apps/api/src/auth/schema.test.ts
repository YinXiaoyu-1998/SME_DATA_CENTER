import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const schemaUrl = new URL("../../../../packages/db/prisma/schema.prisma", import.meta.url);
const migrationUrl = new URL(
  "../../../../packages/db/prisma/migrations/20260724190000_official_auth_core/migration.sql",
  import.meta.url
);

describe("official auth schema", () => {
  it("defines every auth model and removes the legacy AccessToken model", async () => {
    const schema = await readFile(schemaUrl, "utf8");

    for (const model of [
      "LoginIdentity",
      "PasswordSetupGrant",
      "PasswordSetupSession",
      "OAuthAuthorizationTransaction",
      "OAuthAuthorizationCode",
      "DeviceAuthorization",
      "AuthSession",
      "DurableCredential",
      "OAuthAccessToken",
      "AuthSecurityEvent"
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(schema).not.toContain("model AccessToken {");
  });

  it("guards the legacy access-token drop with an empty-table SQL preflight", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("legacy_access_tokens_must_be_empty_before_official_auth_cutover");
    expect(migration).toContain("INSERT INTO `_legacy_access_tokens_empty_guard`");
    expect(migration).not.toContain("PREPARE legacy_access_token_guard");
    expect(migration).toContain("DROP TABLE `access_tokens`");
    expect(migration.indexOf("INSERT INTO `_legacy_access_tokens_empty_guard`")).toBeLessThan(
      migration.indexOf("DROP TABLE `access_tokens`")
    );
  });

  it("uses exact binary collation for the application-normalized login email", async () => {
    const schema = await readFile(schemaUrl, "utf8");
    const migration = await readFile(migrationUrl, "utf8");

    expect(schema).toContain("stored with the exact utf8mb4_bin migration collation");
    expect(migration).toMatch(
      /`normalized_email` VARCHAR\(320\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/
    );
  });

  it("uses unique indexed SHA-256 hash columns and explicit employee/organization foreign keys", async () => {
    const schema = await readFile(schemaUrl, "utf8");

    expect(schema.match(/tokenHash\s+String\s+@unique/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(schema).toContain("credentialHash String");
    expect(schema).toContain("codeHash");
    expect(schema).toContain("transactionHash");
    expect(schema).toMatch(/organization\s+Organization/);
    expect(schema).toMatch(/employee\s+Employee/);
  });
});
