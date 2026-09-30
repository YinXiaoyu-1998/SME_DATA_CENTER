import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const schemaUrl = new URL("../../../../packages/db/prisma/schema.prisma", import.meta.url);
const migrationUrl = new URL(
  "../../../../packages/db/prisma/migrations/20260724190000_official_auth_core/migration.sql",
  import.meta.url
);
const legacyOAuthDropMigrationUrl = new URL(
  "../../../../packages/db/prisma/migrations/20260926090000_remove_legacy_authorization_code/migration.sql",
  import.meta.url
);

describe("official auth schema", () => {
  it("defines every auth model and removes the legacy AccessToken model", async () => {
    const schema = await readFile(schemaUrl, "utf8");

    for (const model of [
      "LoginIdentity",
      "PasswordSetupGrant",
      "PasswordSetupSession",
      "DeviceAuthorization",
      "AuthSession",
      "DurableCredential",
      "OAuthAccessToken",
      "AuthSecurityEvent"
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(schema).not.toContain("model OAuthAuthorizationTransaction {");
    expect(schema).not.toContain("model OAuthAuthorizationCode {");
    expect(schema).not.toContain("enum OAuthTransactionStatus {");
    expect(schema).not.toContain("model AccessToken {");
  });

  it("drops the unused authorization-code tables in dependency order", async () => {
    const migration = await readFile(legacyOAuthDropMigrationUrl, "utf8").catch(() => "");

    expect(migration).toContain("DROP TABLE `oauth_authorization_codes`");
    expect(migration).toContain("DROP TABLE `oauth_authorization_transactions`");
    expect(migration.indexOf("oauth_authorization_codes")).toBeLessThan(
      migration.indexOf("oauth_authorization_transactions")
    );
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
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toMatch(
      /`normalized_email` VARCHAR\(320\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/
    );
  });

  it("uses unique indexed SHA-256 hash columns and explicit employee/organization foreign keys", async () => {
    const schema = await readFile(schemaUrl, "utf8");

    expect(schema.match(/tokenHash\s+String\s+@unique/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(schema).toContain("credentialHash String");
    expect(schema).not.toContain("transactionHash");
    expect(schema).toMatch(/organization\s+Organization/);
    expect(schema).toMatch(/employee\s+Employee/);
  });
});
