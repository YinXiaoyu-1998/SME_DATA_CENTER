import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthCore } from "./auth-core.js";
import { createPrismaAuthCoreRepository } from "./prisma-auth-repository.js";
import { createPrismaAuthOperatorRepository } from "./prisma-auth-operator-repository.js";
import { hashOpaqueSecret } from "./primitives.js";

const runIntegration = process.env["RUN_AUTH_INTEGRATION"] === "1";
const describeIntegration = runIntegration ? describe : describe.skip;
const browserAudit = {
  requestId: "browser_request_1",
  sourceIp: "198.51.100.7",
  launcherVersion: null
};
const oauthAudit = {
  requestId: "oauth_request_1",
  sourceIp: "203.0.113.9",
  launcherVersion: "0.1.0"
};

describeIntegration("Prisma auth core repository", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(process.env["DATABASE_URL"] ?? "")
  });
  const repository = createPrismaAuthCoreRepository(prisma);
  const core = new AuthCore(repository);
  const operatorRepository = createPrismaAuthOperatorRepository(prisma);

  beforeAll(async () => {
    await prisma.organization.create({
      data: { id: "auth-test-org", name: "示例餐饮管理有限公司" }
    });
    await prisma.employee.create({
      data: {
        id: "auth_test_employee",
        orgId: "auth-test-org",
        email: "person@example.com",
        displayName: "Test Person",
        role: "employee",
        clearance: 0
      }
    });
    await prisma.loginIdentity.create({
      data: {
        id: "auth_test_identity",
        orgId: "auth-test-org",
        employeeId: "auth_test_employee",
        normalizedEmail: "person@example.com"
      }
    });
  });

  afterAll(async () => {
    await prisma.authSecurityEvent.deleteMany({ where: { orgId: "auth-test-org" } });
    await prisma.oAuthAccessToken.deleteMany({ where: { orgId: "auth-test-org" } });
    await prisma.durableCredential.deleteMany({
      where: { session: { orgId: "auth-test-org" } }
    });
    await prisma.authSession.deleteMany({ where: { orgId: "auth-test-org" } });
    await prisma.oAuthAuthorizationCode.deleteMany({ where: { orgId: "auth-test-org" } });
    await prisma.deviceAuthorization.deleteMany({
      where: { clientId: "enterprise-hub-desktop-launcher" }
    });
    await prisma.oAuthAuthorizationTransaction.deleteMany({
      where: {
        OR: [
          { identity: { orgId: "auth-test-org" } },
          {
            transactionHash: {
              in: ["5".repeat(64), "de".repeat(32)]
            }
          }
        ]
      }
    });
    await prisma.passwordSetupSession.deleteMany({
      where: { identity: { orgId: "auth-test-org" } }
    });
    await prisma.passwordSetupGrant.deleteMany({
      where: { identity: { orgId: "auth-test-org" } }
    });
    await prisma.loginIdentity.deleteMany({ where: { orgId: "auth-test-org" } });
    await prisma.employee.deleteMany({ where: { orgId: "auth-test-org" } });
    await prisma.organization.deleteMany({ where: { id: "auth-test-org" } });
    await prisma.$disconnect();
  });

  it("atomically replaces, exchanges, and consumes setup credentials", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 86_400_000);
    await repository.replacePasswordSetupGrant({
      identityId: "auth_test_identity",
      purpose: "password_reset",
      tokenHash: "1".repeat(64),
      expiresAt,
      now
    });
    await repository.replacePasswordSetupGrant({
      identityId: "auth_test_identity",
      purpose: "password_reset",
      tokenHash: "2".repeat(64),
      expiresAt,
      now
    });

    const oldGrant = await prisma.passwordSetupGrant.findUnique({
      where: { tokenHash: "1".repeat(64) }
    });
    expect(oldGrant?.revokedAt).toEqual(now);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.replacePasswordSetupGrant({
          identityId: "auth_test_identity",
          purpose: "password_reset",
          tokenHash: (40 + index).toString(16).repeat(32),
          expiresAt,
          now
        })
      )
    );
    const activeGrants = await prisma.passwordSetupGrant.findMany({
      where: {
        identityId: "auth_test_identity",
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now }
      }
    });
    expect(activeGrants).toHaveLength(1);

    const exchanges = await Promise.all([
      repository.exchangePasswordSetupGrant({
        grantTokenHash: activeGrants[0]!.tokenHash,
        sessionHash: "3".repeat(64),
        expiresAt: new Date(now.getTime() + 600_000),
        now,
        audit: browserAudit
      }),
      repository.exchangePasswordSetupGrant({
        grantTokenHash: activeGrants[0]!.tokenHash,
        sessionHash: "4".repeat(64),
        expiresAt: new Date(now.getTime() + 600_000),
        now,
        audit: browserAudit
      })
    ]);
    expect(exchanges.filter(Boolean)).toHaveLength(1);

    const activeSession = await prisma.passwordSetupSession.findFirstOrThrow();
    const durableSessionId = await repository.createSessionBundle({
      identityId: "auth_test_identity",
      employeeId: "auth_test_employee",
      orgId: "auth-test-org",
      credentialHash: "31".repeat(32),
      accessTokenHash: "32".repeat(32),
      accessTokenExpiresAt: new Date(now.getTime() + 600_000),
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      now,
      audit: oauthAudit
    });
    const consumptions = await Promise.all([
      repository.consumePasswordSetupSession({
        sessionHash: activeSession.sessionHash,
        passwordHash: "argon2id-hash",
        now,
        audit: browserAudit
      }),
      repository.consumePasswordSetupSession({
        sessionHash: activeSession.sessionHash,
        passwordHash: "argon2id-hash",
        now,
        audit: browserAudit
      })
    ]);
    expect(consumptions.sort()).toEqual([false, true]);
    expect(
      (
        await prisma.loginIdentity.findUniqueOrThrow({
          where: { id: "auth_test_identity" }
        })
      ).passwordHash
    ).toBe("argon2id-hash");
    expect(
      (await prisma.authSession.findUniqueOrThrow({ where: { id: durableSessionId } })).status
    ).toBe("revoked");
    expect(
      await prisma.authSecurityEvent.findMany({
        where: {
          orgId: "auth-test-org",
          eventType: { in: ["setup_grant_consumed", "password_setup_completed"] },
          requestId: browserAudit.requestId
        },
        select: { requestId: true, sourceIp: true, launcherVersion: true }
      })
    ).toEqual([browserAudit, browserAudit]);
  });

  it("serializes concurrent login failures and does not extend an active cooldown", async () => {
    const now = new Date("2026-07-24T12:30:00.000Z");
    await repository.resetLoginFailures("auth_test_identity");

    await Promise.all(
      Array.from({ length: 5 }, () => repository.recordLoginFailure("auth_test_identity", now))
    );

    const afterFifth = await prisma.loginIdentity.findUniqueOrThrow({
      where: { id: "auth_test_identity" }
    });
    expect(afterFifth.failedAttemptCount).toBe(5);
    expect(afterFifth.cooldownLevel).toBe(1);
    expect(afterFifth.cooldownUntil).toEqual(new Date(now.getTime() + 5 * 60_000));

    await repository.recordLoginFailure("auth_test_identity", new Date(now.getTime() + 60_000));
    const duringCooldown = await prisma.loginIdentity.findUniqueOrThrow({
      where: { id: "auth_test_identity" }
    });
    expect(duringCooldown.failedAttemptCount).toBe(5);
    expect(duringCooldown.cooldownUntil).toEqual(afterFifth.cooldownUntil);
    await repository.resetLoginFailures("auth_test_identity");
  });

  it("derives PKCE S256 from the raw verifier, rejects the wrong verifier, and redeems once", async () => {
    const verifier = "real-raw-verifier-used-only-at-the-auth-core-boundary";
    const transaction = await core.issueAuthorizationTransaction({
      clientId: "enterprise-hub-desktop-launcher",
      redirectUri: "http://127.0.0.1:32123/callback",
      state: "original-state",
      pkceChallenge: createHash("sha256").update(verifier).digest("base64url")
    });
    const completed = await core.completeAuthorizationTransaction(
      transaction.secret,
      {
        identityId: "auth_test_identity",
        employeeId: "auth_test_employee",
        orgId: "auth-test-org"
      },
      browserAudit
    );
    expect(completed).toMatchObject({
      codeId: expect.any(String),
      redirectUri: "http://127.0.0.1:32123/callback",
      state: "original-state"
    });

    await expect(
      core.redeemAuthorizationCode(
        {
          secret: completed!.code,
          clientId: "enterprise-hub-desktop-launcher",
          redirectUri: "http://127.0.0.1:32123/callback",
          verifier: "wrong-raw-verifier"
        },
        oauthAudit
      )
    ).resolves.toEqual({ status: "invalid" });

    const results = await Promise.all([
      core.redeemAuthorizationCode(
        {
          secret: completed!.code,
          clientId: "enterprise-hub-desktop-launcher",
          redirectUri: "http://127.0.0.1:32123/callback",
          verifier
        },
        oauthAudit
      ),
      core.redeemAuthorizationCode(
        {
          secret: completed!.code,
          clientId: "enterprise-hub-desktop-launcher",
          redirectUri: "http://127.0.0.1:32123/callback",
          verifier
        },
        oauthAudit
      )
    ]);
    expect(results.filter((result) => result.status === "redeemed")).toHaveLength(1);
  });

  it("issues, completes, and redeems a device authorization exactly once", async () => {
    const issued = await core.issueDeviceAuthorization({
      clientId: "enterprise-hub-desktop-launcher",
      instanceName: "agent-a",
      instanceHostname: "vps-1",
      audit: oauthAudit
    });

    const found = await core.findDeviceAuthorizationByUserCode(issued.userCode);
    expect(found).toMatchObject({
      status: "pending",
      instanceName: "agent-a",
      instanceHostname: "vps-1"
    });

    await expect(
      core.redeemDeviceAuthorization(
        issued.deviceCode,
        "enterprise-hub-desktop-launcher",
        oauthAudit
      )
    ).resolves.toEqual({ status: "authorization_pending" });

    const completed = await core.completeDeviceAuthorization(
      issued.userCode,
      {
        identityId: "auth_test_identity",
        employeeId: "auth_test_employee",
        orgId: "auth-test-org"
      },
      browserAudit
    );
    expect(completed).toBe(true);

    const redeemed = await core.redeemDeviceAuthorization(
      issued.deviceCode,
      "enterprise-hub-desktop-launcher",
      oauthAudit
    );
    expect(redeemed).toEqual({
      status: "redeemed",
      identityId: "auth_test_identity",
      employeeId: "auth_test_employee",
      orgId: "auth-test-org"
    });

    await expect(
      core.redeemDeviceAuthorization(
        issued.deviceCode,
        "enterprise-hub-desktop-launcher",
        oauthAudit
      )
    ).resolves.toEqual({ status: "invalid" });
  });

  it("revokes a prior pending device authorization when the same instance re-issues", async () => {
    const first = await core.issueDeviceAuthorization({
      clientId: "enterprise-hub-desktop-launcher",
      instanceName: "agent-a",
      instanceHostname: "vps-1",
      audit: oauthAudit
    });
    await core.issueDeviceAuthorization({
      clientId: "enterprise-hub-desktop-launcher",
      instanceName: "agent-a",
      instanceHostname: "vps-1",
      audit: oauthAudit
    });

    const firstLookup = await core.findDeviceAuthorizationByUserCode(first.userCode);
    expect(firstLookup?.status).toBe("revoked");
  });

  it("revokes the entire family when concurrent rotation replays a consumed generation", async () => {
    const now = new Date("2026-07-24T14:00:00.000Z");
    const sessionId = await repository.createSessionBundle({
      identityId: "auth_test_identity",
      employeeId: "auth_test_employee",
      orgId: "auth-test-org",
      credentialHash: "7".repeat(64),
      accessTokenHash: "70".repeat(32),
      accessTokenExpiresAt: new Date(now.getTime() + 600_000),
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      now,
      audit: oauthAudit
    });

    const results = await Promise.all([
      repository.rotateDurableCredential({
        presentedCredentialHash: "7".repeat(64),
        replacementCredentialHash: "8".repeat(64),
        accessTokenHash: "9".repeat(64),
        accessTokenExpiresAt: new Date(now.getTime() + 600_000),
        now,
        audit: oauthAudit
      }),
      repository.rotateDurableCredential({
        presentedCredentialHash: "7".repeat(64),
        replacementCredentialHash: "a".repeat(64),
        accessTokenHash: "b".repeat(64),
        accessTokenExpiresAt: new Date(now.getTime() + 600_000),
        now,
        audit: oauthAudit
      })
    ]);

    expect(results.some((result) => result.status === "replayed")).toBe(true);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe(
      "revoked"
    );
    expect(
      await prisma.durableCredential.count({
        where: { sessionId, status: "active" }
      })
    ).toBe(0);
    expect(
      await prisma.authSecurityEvent.findMany({
        where: {
          sessionId,
          eventType: { in: ["credential_replay_detected", "session_revoked"] }
        },
        select: { requestId: true, sourceIp: true, launcherVersion: true }
      })
    ).toEqual([oauthAudit, oauthAudit]);
  });

  it("records OAuth request metadata on refresh expiry and renewal failure events", async () => {
    const issuedAt = new Date("2026-07-24T14:30:00.000Z");
    const refreshAt = new Date("2026-07-24T14:32:00.000Z");
    const presentedCredential = "eh_rt_expired_refresh";
    await prisma.authSecurityEvent.deleteMany({
      where: {
        createdAt: refreshAt,
        eventType: { in: ["session_expired", "renewal_failed"] }
      }
    });
    const sessionId = await repository.createSessionBundle({
      identityId: "auth_test_identity",
      employeeId: "auth_test_employee",
      orgId: "auth-test-org",
      credentialHash: hashOpaqueSecret(presentedCredential),
      accessTokenHash: "71".repeat(32),
      accessTokenExpiresAt: new Date(issuedAt.getTime() + 600_000),
      absoluteExpiresAt: new Date(issuedAt.getTime() + 60_000),
      now: issuedAt,
      audit: oauthAudit
    });
    const refreshCore = new AuthCore(repository, () => refreshAt);

    await expect(
      refreshCore.rotateDurableCredential(presentedCredential, oauthAudit)
    ).resolves.toEqual({ status: "invalid" });

    const events = await prisma.authSecurityEvent.findMany({
      where: {
        createdAt: refreshAt,
        eventType: { in: ["session_expired", "renewal_failed"] }
      },
      select: {
        eventType: true,
        requestId: true,
        sourceIp: true,
        launcherVersion: true,
        sessionId: true
      }
    });
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          eventType: "session_expired",
          requestId: "oauth_request_1",
          sourceIp: "203.0.113.9",
          launcherVersion: "0.1.0",
          sessionId
        },
        {
          eventType: "renewal_failed",
          requestId: "oauth_request_1",
          sourceIp: "203.0.113.9",
          launcherVersion: "0.1.0",
          sessionId: null
        }
      ])
    );
  });

  it("records MCP request metadata when access-token authentication discovers session expiry", async () => {
    const issuedAt = new Date("2026-07-24T15:30:00.000Z");
    const sessionId = await repository.createSessionBundle({
      identityId: "auth_test_identity",
      employeeId: "auth_test_employee",
      orgId: "auth-test-org",
      credentialHash: "ce".repeat(32),
      accessTokenHash: "cf".repeat(32),
      accessTokenExpiresAt: new Date(issuedAt.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(issuedAt.getTime() + 60_000),
      now: issuedAt,
      audit: oauthAudit
    });
    const mcpAudit = {
      requestId: "mcp_request_1",
      sourceIp: "203.0.113.10",
      launcherVersion: "0.1.0"
    };

    await expect(
      repository.authenticateAccessToken(
        "cf".repeat(32),
        new Date(issuedAt.getTime() + 120_000),
        mcpAudit
      )
    ).resolves.toBeNull();

    expect(
      await prisma.authSecurityEvent.findFirst({
        where: { sessionId, eventType: "session_expired" },
        select: { requestId: true, sourceIp: true, launcherVersion: true }
      })
    ).toEqual(mcpAudit);
  });

  it("rechecks identity and employee disabled state on access-token authentication", async () => {
    const now = new Date("2026-07-24T15:00:00.000Z");
    await repository.createSessionBundle({
      identityId: "auth_test_identity",
      employeeId: "auth_test_employee",
      orgId: "auth-test-org",
      credentialHash: "c".repeat(64),
      accessTokenHash: "d".repeat(64),
      accessTokenExpiresAt: new Date(now.getTime() + 600_000),
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      now,
      audit: oauthAudit
    });

    expect(await repository.authenticateAccessToken("d".repeat(64), now, oauthAudit)).toMatchObject(
      {
        organizationName: "示例餐饮管理有限公司",
        displayName: "Test Person",
        identityDisabled: false,
        employeeDisabled: false,
        clearance: 0
      }
    );
    await prisma.employee.update({
      where: { id: "auth_test_employee" },
      data: { disabled: true }
    });
    expect(await repository.authenticateAccessToken("d".repeat(64), now, oauthAudit)).toMatchObject(
      {
        employeeDisabled: true
      }
    );

    await repository.createAuthorizationTransaction({
      transactionHash: "de".repeat(32),
      clientId: "enterprise-hub-desktop-launcher",
      redirectUri: "http://127.0.0.1:32124/callback",
      state: "disabled-state",
      pkceChallenge: "disabled-challenge",
      expiresAt: new Date(now.getTime() + 600_000),
      now
    });
    await expect(
      repository.consumeAuthorizationTransactionAndCreateCode({
        transactionHash: "de".repeat(32),
        identityId: "auth_test_identity",
        employeeId: "auth_test_employee",
        orgId: "auth-test-org",
        codeHash: "df".repeat(32),
        codeExpiresAt: new Date(now.getTime() + 60_000),
        now,
        audit: browserAudit
      })
    ).resolves.toBeNull();
    await prisma.employee.update({
      where: { id: "auth_test_employee" },
      data: { disabled: false }
    });
  });

  it("atomically onboards employee, identity, and link grant with explicit clearance", async () => {
    const now = new Date("2026-07-24T16:00:00.000Z");
    const onboarded = await operatorRepository.onboard({
      orgId: "auth-test-org",
      normalizedEmail: "onboarded@example.com",
      displayName: "Onboarded Person",
      role: "employee",
      clearance: 2,
      grantTokenHash: "e".repeat(64),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
      now
    });

    expect(await prisma.employee.findUnique({ where: { id: onboarded.employeeId } })).toMatchObject(
      {
        clearance: 2,
        role: "employee"
      }
    );
    expect(
      await prisma.loginIdentity.findUnique({
        where: { normalizedEmail: "onboarded@example.com" }
      })
    ).toMatchObject({ employeeId: onboarded.employeeId, id: onboarded.identityId });
    expect(
      await prisma.passwordSetupGrant.findUnique({ where: { tokenHash: "e".repeat(64) } })
    ).toMatchObject({ identityId: onboarded.identityId, purpose: "initial_setup" });

    await operatorRepository.resetPassword({
      employeeId: onboarded.employeeId,
      grantTokenHash: "0".repeat(64),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
      now
    });
    expect(
      await prisma.passwordSetupGrant.findUnique({ where: { tokenHash: "e".repeat(64) } })
    ).toMatchObject({ revokedAt: now });
    expect(
      await prisma.passwordSetupGrant.findUnique({ where: { tokenHash: "0".repeat(64) } })
    ).toMatchObject({ purpose: "password_reset" });

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        operatorRepository.resetPassword({
          employeeId: onboarded.employeeId,
          grantTokenHash: `a${index}`.padEnd(64, "a"),
          grantExpiresAt: new Date(now.getTime() + 86_400_000),
          now
        })
      )
    );
    expect(
      await prisma.passwordSetupGrant.count({
        where: {
          identityId: onboarded.identityId,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: now }
        }
      })
    ).toBe(1);
    expect(
      (
        await prisma.authSecurityEvent.findMany({
          where: { identityId: onboarded.identityId },
          select: {
            eventType: true,
            requestId: true,
            sourceIp: true,
            launcherVersion: true
          }
        })
      ).map(({ eventType }) => eventType)
    ).toEqual(expect.arrayContaining(["account_onboarded", "setup_grant_issued"]));
    const passwordResetEvents = await prisma.authSecurityEvent.findMany({
      where: {
        identityId: onboarded.identityId,
        eventType: "setup_grant_issued",
        reason: "password_reset"
      },
      select: { requestId: true, sourceIp: true, launcherVersion: true }
    });
    expect(passwordResetEvents).toHaveLength(7);
    expect(passwordResetEvents).toEqual(
      Array.from({ length: 7 }, () => ({
        requestId: null,
        sourceIp: null,
        launcherVersion: null
      }))
    );

    await expect(
      operatorRepository.onboard({
        orgId: "auth-test-org",
        normalizedEmail: "rolled-back@example.com",
        displayName: "Rolled Back",
        role: "employee",
        clearance: 1,
        grantTokenHash: "f".repeat(64),
        grantExpiresAt: new Date(now.getTime() + 86_400_000),
        now
      })
    ).rejects.toThrow("do not exist");
    expect(
      await prisma.employee.findUnique({ where: { email: "rolled-back@example.com" } })
    ).toBeNull();
  });

  it("writes credential-free lifecycle events and prunes only records older than 90 days", async () => {
    const now = new Date("2026-07-24T17:00:00.000Z");
    const sessionId = await repository.createSessionBundle({
      identityId: "auth_test_identity",
      employeeId: "auth_test_employee",
      orgId: "auth-test-org",
      credentialHash: "1a".repeat(32),
      accessTokenHash: "1b".repeat(32),
      accessTokenExpiresAt: new Date(now.getTime() + 600_000),
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      now,
      audit: oauthAudit
    });
    await repository.revokeSessionByDurableCredential("1a".repeat(32), "logout", now, oauthAudit);

    const eventTypes = (
      await prisma.authSecurityEvent.findMany({
        where: { orgId: "auth-test-org" },
        select: { eventType: true }
      })
    ).map(({ eventType }) => eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "setup_grant_issued",
        "setup_grant_consumed",
        "password_setup_completed",
        "session_created",
        "session_revoked",
        "credential_replay_detected",
        "logout"
      ])
    );
    expect(
      await prisma.authSecurityEvent.findFirst({
        where: { sessionId },
        select: {
          eventType: true,
          requestId: true,
          sourceIp: true,
          launcherVersion: true
        }
      })
    ).toMatchObject(oauthAudit);

    await repository.writeSecurityEvent({
      type: "security_policy_rejected",
      outcome: "denied",
      reason: "old-test-event",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(
      await prisma.authSecurityEvent.findFirst({
        where: { reason: "old-test-event" },
        select: { requestId: true, sourceIp: true, launcherVersion: true }
      })
    ).toEqual({ requestId: null, sourceIp: null, launcherVersion: null });
    expect(await repository.pruneSecurityEvents(new Date("2026-04-25T17:00:00.000Z"))).toBe(1);
  });

  it("keeps operator identity-session reset event metadata null", async () => {
    const now = new Date("2026-07-24T18:00:00.000Z");
    const sessionId = await repository.createSessionBundle({
      identityId: "auth_test_identity",
      employeeId: "auth_test_employee",
      orgId: "auth-test-org",
      credentialHash: "2a".repeat(32),
      accessTokenHash: "2b".repeat(32),
      accessTokenExpiresAt: new Date(now.getTime() + 600_000),
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      now
    });

    await expect(
      repository.revokeIdentitySessions("auth_test_identity", "operator_session_reset", now)
    ).resolves.toBeGreaterThanOrEqual(1);

    expect(
      await prisma.authSecurityEvent.findFirst({
        where: {
          sessionId,
          eventType: "session_revoked",
          reason: "operator_session_reset"
        },
        select: { requestId: true, sourceIp: true, launcherVersion: true }
      })
    ).toEqual({ requestId: null, sourceIp: null, launcherVersion: null });
  });

  it("stores normalized emails with exact binary semantics", async () => {
    await prisma.employee.createMany({
      data: [
        {
          id: "auth_email_ascii",
          orgId: "auth-test-org",
          email: "auth-email-ascii@example.com",
          displayName: "ASCII Email",
          role: "employee",
          clearance: 0
        },
        {
          id: "auth_email_accent",
          orgId: "auth-test-org",
          email: "auth-email-accent@example.com",
          displayName: "Accent Email",
          role: "employee",
          clearance: 0
        }
      ]
    });

    await prisma.loginIdentity.createMany({
      data: [
        {
          id: "auth_identity_ascii",
          orgId: "auth-test-org",
          employeeId: "auth_email_ascii",
          normalizedEmail: "jose@example.com"
        },
        {
          id: "auth_identity_accent",
          orgId: "auth-test-org",
          employeeId: "auth_email_accent",
          normalizedEmail: "josé@example.com"
        }
      ]
    });

    expect(
      await prisma.loginIdentity.count({
        where: { id: { in: ["auth_identity_ascii", "auth_identity_accent"] } }
      })
    ).toBe(2);
  });

  it("stops the migration before dropping a nonempty legacy access-token table", async () => {
    const databaseName = `auth_guard_${process.pid}`;
    const sourceUrl = new URL(process.env["DATABASE_URL"] ?? "");
    const guardUrl = new URL(sourceUrl);
    guardUrl.pathname = `/${databaseName}`;
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await prisma.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\``);
    const guardPrisma = new PrismaClient({
      adapter: new PrismaMariaDb(guardUrl.toString())
    });

    try {
      await guardPrisma.$executeRawUnsafe(
        "CREATE TABLE `access_tokens` (`id` VARCHAR(32) NOT NULL PRIMARY KEY)"
      );
      await guardPrisma.$executeRawUnsafe(
        "INSERT INTO `access_tokens` (`id`) VALUES ('must-survive-guard')"
      );
      const migration = await readFile(
        new URL(
          "../../../../packages/db/prisma/migrations/20260724190000_official_auth_core/migration.sql",
          import.meta.url
        ),
        "utf8"
      );
      const guardSql = migration.slice(
        0,
        migration.indexOf("ALTER TABLE `access_tokens` DROP FOREIGN KEY")
      );
      let guardError: unknown;
      for (const statement of guardSql
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)) {
        try {
          await guardPrisma.$executeRawUnsafe(statement);
        } catch (error) {
          guardError = error;
          break;
        }
      }

      expect(String(guardError)).toContain(
        "legacy_access_tokens_must_be_empty_before_official_auth_cutover"
      );
      expect(
        await guardPrisma.$queryRawUnsafe<Array<{ id: string }>>("SELECT `id` FROM `access_tokens`")
      ).toEqual([{ id: "must-survive-guard" }]);
    } finally {
      await guardPrisma.$disconnect();
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    }
  });
});
