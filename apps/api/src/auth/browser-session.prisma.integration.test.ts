import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { BrowserSessions } from "./browser-session.js";
import { createPrismaBrowserSessionRepository } from "./prisma-browser-session.js";
import { createPrismaAuthCoreRepository } from "./prisma-auth-repository.js";
import { createPrismaAuthOperatorRepository } from "./prisma-auth-operator-repository.js";
import { AuthCore } from "./auth-core.js";
import { hashOpaqueSecret, hashPassword } from "./primitives.js";

const enabled = process.env["RUN_AUTH_INTEGRATION"] === "1";
const describeIntegration = enabled ? describe : describe.skip;
const url = process.env["DATABASE_URL"] ?? "mysql://unused:unused@127.0.0.1:3307/unused";
if (enabled && !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw new Error("Browser integration tests require loopback MySQL.");

describeIntegration("Prisma shared browser sessions", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const auth = new AuthCore(createPrismaAuthCoreRepository(prisma));
  const sessions = new BrowserSessions(createPrismaBrowserSessionRepository(prisma));
  const audit = { requestId: "browser_integration", sourceIp: "127.0.0.1", launcherVersion: null };
  const orgId = "browser-ui-test-org";
  let fingerprint: string;
  const identity = () => ({
    identityId: "browser_ui_identity",
    employeeId: "browser_ui_admin",
    orgId,
    credentialFingerprint: fingerprint
  });
  beforeAll(async () => {
    const passwordHash = await hashPassword("synthetic browser test password");
    fingerprint = hashOpaqueSecret(passwordHash);
    await prisma.organization.create({ data: { id: orgId, name: "浏览器测试企业" } });
    await prisma.employee.create({
      data: {
        id: "browser_ui_admin",
        orgId,
        email: "browser-ui@example.invalid",
        displayName: "测试管理员",
        role: "admin",
        clearance: 3
      }
    });
    await prisma.loginIdentity.create({
      data: {
        id: "browser_ui_identity",
        orgId,
        employeeId: "browser_ui_admin",
        normalizedEmail: "browser-ui@example.invalid",
        passwordHash
      }
    });
  });
  afterAll(async () => {
    await prisma.authSecurityEvent.deleteMany({ where: { orgId } });
    await prisma.passwordSetupGrant.deleteMany({ where: { identityId: "browser_ui_identity" } });
    await prisma.loginIdentity.deleteMany({ where: { orgId } });
    await prisma.employee.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });
  it("stores no browser secret and authenticates live account attributes", async () => {
    const secret = await sessions.issue(identity(), null, audit);
    expect(secret).not.toBeNull();
    const row = await prisma.browserSession.findUniqueOrThrow({
      where: { secretHash: hashOpaqueSecret(secret!) }
    });
    expect(JSON.stringify(row)).not.toContain(secret!);
    expect(await sessions.authenticate(secret)).toMatchObject({
      id: "browser_ui_admin",
      role: "admin",
      orgId
    });
    await prisma.employee.update({ where: { id: "browser_ui_admin" }, data: { role: "employee" } });
    expect(await sessions.authenticate(secret)).toMatchObject({ role: "employee" });
    await prisma.employee.update({ where: { id: "browser_ui_admin" }, data: { disabled: true } });
    expect(await sessions.authenticate(secret)).toBeNull();
    await prisma.employee.update({
      where: { id: "browser_ui_admin" },
      data: { role: "admin", disabled: false }
    });
  });
  it("rejects stale password proof and mismatched organization at session issuance", async () => {
    expect(
      await sessions.issue({ ...identity(), credentialFingerprint: "f".repeat(64) }, null, audit)
    ).toBeNull();
    expect(await sessions.issue({ ...identity(), orgId: "another-org" }, null, audit)).toBeNull();
  });
  it("revokes browser sessions when identity sessions are revoked", async () => {
    const secret = await sessions.issue(identity(), null, audit);
    await auth.revokeIdentitySessions("browser_ui_identity", "operator_revoke");
    expect(await sessions.authenticate(secret)).toBeNull();
  });
  it("revokes browser sessions as soon as an operator starts password reset", async () => {
    const secret = await sessions.issue(identity(), null, audit);
    await createPrismaAuthOperatorRepository(prisma).resetPassword({
      employeeId: "browser_ui_admin",
      grantTokenHash: "b".repeat(64),
      grantExpiresAt: new Date(Date.now() + 60_000),
      now: new Date()
    });
    expect(await sessions.authenticate(secret)).toBeNull();
  });
  it("rejects expired sessions and sessions whose password has changed", async () => {
    const expired = await sessions.issue(identity(), null, audit);
    await prisma.browserSession.update({
      where: { secretHash: hashOpaqueSecret(expired!) },
      data: { expiresAt: new Date(Date.now() - 1) }
    });
    expect(await sessions.authenticate(expired)).toBeNull();
    const changed = await sessions.issue(identity(), null, audit);
    await prisma.loginIdentity.update({
      where: { id: "browser_ui_identity" },
      data: { passwordHash: await hashPassword("changed synthetic browser password") }
    });
    expect(await sessions.authenticate(changed)).toBeNull();
  });
});
