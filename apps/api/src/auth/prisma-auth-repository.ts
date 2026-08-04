import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AccessAuthenticationRecord,
  AuthCoreRepository,
  AuthorizationCodeRedemption,
  RotateCredentialResult,
  SecurityEventInput
} from "./auth-core.js";
import { eventAudit } from "./auth-core.js";

async function revokeSessionFamily(
  tx: Prisma.TransactionClient,
  sessionId: string,
  reason: string,
  now: Date
): Promise<void> {
  await tx.authSession.updateMany({
    where: { id: sessionId, status: "active" },
    data: {
      status: reason === "session_expired" ? "expired" : "revoked",
      revokedAt: now,
      revocationReason: reason
    }
  });
  await tx.durableCredential.updateMany({
    where: { sessionId, status: { not: "revoked" } },
    data: { status: "revoked", revokedAt: now }
  });
  await tx.oAuthAccessToken.updateMany({
    where: { sessionId, revokedAt: null },
    data: { revokedAt: now }
  });
}

export function createPrismaAuthCoreRepository(prisma: PrismaClient): AuthCoreRepository {
  return {
    async findLoginIdentityByEmail(normalizedEmail) {
      return prisma.loginIdentity
        .findUnique({
          where: { normalizedEmail },
          select: {
            id: true,
            orgId: true,
            employeeId: true,
            passwordHash: true,
            disabled: true,
            failedAttemptCount: true,
            cooldownLevel: true,
            cooldownUntil: true,
            employee: {
              select: { disabled: true }
            }
          }
        })
        .then((identity) =>
          identity
            ? {
                id: identity.id,
                orgId: identity.orgId,
                employeeId: identity.employeeId,
                passwordHash: identity.passwordHash,
                disabled: identity.disabled,
                employeeDisabled: identity.employee.disabled,
                failedAttemptCount: identity.failedAttemptCount,
                cooldownLevel: identity.cooldownLevel,
                cooldownUntil: identity.cooldownUntil
              }
            : null
        );
    },

    async recordLoginFailure(identityId, now) {
      await prisma.$executeRaw(
        Prisma.sql`
          UPDATE login_identities
          SET
            cooldown_until = CASE
              WHEN failed_attempt_count + 1 < 5 THEN NULL
              ELSE DATE_ADD(
                ${now},
                INTERVAL (
                  CASE LEAST(cooldown_level + 1, 5)
                    WHEN 1 THEN 5
                    WHEN 2 THEN 10
                    WHEN 3 THEN 20
                    WHEN 4 THEN 40
                    ELSE 60
                  END
                ) MINUTE
              )
            END,
            cooldown_level = CASE
              WHEN failed_attempt_count + 1 >= 5 THEN LEAST(cooldown_level + 1, 5)
              ELSE cooldown_level
            END,
            failed_attempt_count = failed_attempt_count + 1
          WHERE id = ${identityId}
            AND (cooldown_until IS NULL OR cooldown_until <= ${now})
        `
      );
      const identity = await prisma.loginIdentity.findUnique({
        where: { id: identityId },
        select: { cooldownUntil: true }
      });
      return { cooldownUntil: identity?.cooldownUntil ?? null };
    },

    async resetLoginFailures(identityId) {
      await prisma.loginIdentity.updateMany({
        where: { id: identityId },
        data: {
          failedAttemptCount: 0,
          cooldownLevel: 0,
          cooldownUntil: null
        }
      });
    },

    async replacePasswordSetupGrant(input) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM login_identities WHERE id = ${input.identityId} FOR UPDATE`
        );
        const identity = await tx.loginIdentity.findUniqueOrThrow({
          where: { id: input.identityId },
          select: { orgId: true, employeeId: true }
        });
        await tx.passwordSetupSession.updateMany({
          where: {
            identityId: input.identityId,
            consumedAt: null,
            revokedAt: null
          },
          data: { revokedAt: input.now }
        });
        await tx.passwordSetupGrant.updateMany({
          where: {
            identityId: input.identityId,
            usedAt: null,
            revokedAt: null
          },
          data: { revokedAt: input.now }
        });
        const grant = await tx.passwordSetupGrant.create({
          data: {
            identityId: input.identityId,
            purpose: input.purpose,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
            createdAt: input.now
          },
          select: { id: true }
        });
        await tx.authSecurityEvent.create({
          data: {
            eventType: "setup_grant_issued",
            outcome: "succeeded",
            reason: input.purpose,
            orgId: identity.orgId,
            identityId: input.identityId,
            employeeId: identity.employeeId,
            createdAt: input.now
          }
        });
        return grant.id;
      });
    },

    async exchangePasswordSetupGrant(input) {
      return prisma.$transaction(async (tx) => {
        const grant = await tx.passwordSetupGrant.findUnique({
          where: { tokenHash: input.grantTokenHash },
          select: {
            id: true,
            identityId: true,
            purpose: true,
            expiresAt: true,
            usedAt: true,
            revokedAt: true
          }
        });
        if (!grant || grant.usedAt || grant.revokedAt || grant.expiresAt <= input.now) {
          return null;
        }
        const claimed = await tx.passwordSetupGrant.updateMany({
          where: {
            id: grant.id,
            usedAt: null,
            revokedAt: null,
            expiresAt: { gt: input.now }
          },
          data: { usedAt: input.now }
        });
        if (claimed.count !== 1) {
          return null;
        }
        await tx.passwordSetupSession.create({
          data: {
            identityId: grant.identityId,
            grantId: grant.id,
            sessionHash: input.sessionHash,
            expiresAt: input.expiresAt,
            createdAt: input.now
          }
        });
        const identity = await tx.loginIdentity.findUniqueOrThrow({
          where: { id: grant.identityId },
          select: { orgId: true, employeeId: true }
        });
        await tx.authSecurityEvent.create({
          data: {
            eventType: "setup_grant_consumed",
            outcome: "succeeded",
            reason: grant.purpose,
            orgId: identity.orgId,
            identityId: grant.identityId,
            employeeId: identity.employeeId,
            ...eventAudit(input.audit),
            createdAt: input.now
          }
        });
        return { identityId: grant.identityId, purpose: grant.purpose };
      });
    },

    async consumePasswordSetupSession(input) {
      return prisma.$transaction(async (tx) => {
        const setupSession = await tx.passwordSetupSession.findUnique({
          where: { sessionHash: input.sessionHash },
          include: {
            grant: {
              select: { purpose: true }
            },
            identity: {
              select: { orgId: true, employeeId: true }
            }
          }
        });
        if (
          !setupSession ||
          setupSession.consumedAt ||
          setupSession.revokedAt ||
          setupSession.expiresAt <= input.now
        ) {
          return false;
        }
        const consumed = await tx.passwordSetupSession.updateMany({
          where: {
            id: setupSession.id,
            consumedAt: null,
            revokedAt: null,
            expiresAt: { gt: input.now }
          },
          data: { consumedAt: input.now }
        });
        if (consumed.count !== 1) {
          return false;
        }
        await tx.loginIdentity.update({
          where: { id: setupSession.identityId },
          data: {
            passwordHash: input.passwordHash,
            failedAttemptCount: 0,
            cooldownLevel: 0,
            cooldownUntil: null
          }
        });
        const sessions = await tx.authSession.findMany({
          where: { identityId: setupSession.identityId, status: "active" },
          select: { id: true }
        });
        for (const session of sessions) {
          await revokeSessionFamily(tx, session.id, "password_reset", input.now);
          await tx.authSecurityEvent.create({
            data: {
              eventType: "session_revoked",
              outcome: "succeeded",
              reason: "password_reset",
              orgId: setupSession.identity.orgId,
              identityId: setupSession.identityId,
              employeeId: setupSession.identity.employeeId,
              sessionId: session.id,
              ...eventAudit(input.audit),
              createdAt: input.now
            }
          });
        }
        await tx.authSecurityEvent.create({
          data: {
            eventType: "password_setup_completed",
            outcome: "succeeded",
            reason: setupSession.grant.purpose,
            orgId: setupSession.identity.orgId,
            identityId: setupSession.identityId,
            employeeId: setupSession.identity.employeeId,
            ...eventAudit(input.audit),
            createdAt: input.now
          }
        });
        return true;
      });
    },

    async createAuthorizationTransaction(input) {
      const transaction = await prisma.oAuthAuthorizationTransaction.create({
        data: {
          transactionHash: input.transactionHash,
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          state: input.state,
          pkceChallenge: input.pkceChallenge,
          expiresAt: input.expiresAt,
          createdAt: input.now
        },
        select: { id: true }
      });
      return transaction.id;
    },

    async consumeAuthorizationTransactionAndCreateCode(input) {
      return prisma.$transaction(async (tx) => {
        const transaction = await tx.oAuthAuthorizationTransaction.findUnique({
          where: { transactionHash: input.transactionHash }
        });
        if (
          !transaction ||
          transaction.status !== "pending" ||
          transaction.expiresAt <= input.now
        ) {
          return null;
        }
        const identity = await tx.loginIdentity.findUnique({
          where: { id: input.identityId },
          include: {
            employee: {
              select: { id: true, orgId: true, disabled: true }
            }
          }
        });
        if (
          !identity ||
          identity.disabled ||
          identity.employee.disabled ||
          identity.employeeId !== input.employeeId ||
          identity.orgId !== input.orgId ||
          identity.employee.orgId !== input.orgId
        ) {
          return null;
        }
        const consumed = await tx.oAuthAuthorizationTransaction.updateMany({
          where: {
            id: transaction.id,
            status: "pending",
            expiresAt: { gt: input.now }
          },
          data: {
            status: "completed",
            identityId: input.identityId,
            completedAt: input.now
          }
        });
        if (consumed.count !== 1) {
          return null;
        }
        const code = await tx.oAuthAuthorizationCode.create({
          data: {
            transactionId: transaction.id,
            identityId: input.identityId,
            employeeId: input.employeeId,
            orgId: input.orgId,
            codeHash: input.codeHash,
            clientId: transaction.clientId,
            redirectUri: transaction.redirectUri,
            pkceChallenge: transaction.pkceChallenge,
            expiresAt: input.codeExpiresAt,
            createdAt: input.now
          },
          select: { id: true }
        });
        return {
          codeId: code.id,
          clientId: transaction.clientId,
          redirectUri: transaction.redirectUri,
          state: transaction.state
        };
      });
    },

    async redeemAuthorizationCode(input): Promise<AuthorizationCodeRedemption> {
      return prisma.$transaction(async (tx) => {
        const code = await tx.oAuthAuthorizationCode.findUnique({
          where: { codeHash: input.codeHash }
        });
        if (
          !code ||
          code.clientId !== input.clientId ||
          code.redirectUri !== input.redirectUri ||
          code.pkceChallenge !== input.pkceChallenge ||
          code.redeemedAt ||
          code.expiresAt <= input.now
        ) {
          return { status: "invalid" };
        }
        const redeemed = await tx.oAuthAuthorizationCode.updateMany({
          where: {
            id: code.id,
            clientId: input.clientId,
            redirectUri: input.redirectUri,
            pkceChallenge: input.pkceChallenge,
            redeemedAt: null,
            expiresAt: { gt: input.now }
          },
          data: { redeemedAt: input.now }
        });
        if (redeemed.count !== 1) {
          return { status: "invalid" };
        }
        return {
          status: "redeemed",
          identityId: code.identityId,
          employeeId: code.employeeId,
          orgId: code.orgId
        };
      });
    },

    async createSessionBundle(input) {
      return prisma.$transaction(async (tx) => {
        const identity = await tx.loginIdentity.findUnique({
          where: { id: input.identityId },
          include: {
            employee: {
              select: { id: true, orgId: true, disabled: true }
            }
          }
        });
        if (
          !identity ||
          identity.disabled ||
          identity.employee.disabled ||
          identity.employeeId !== input.employeeId ||
          identity.orgId !== input.orgId ||
          identity.employee.orgId !== input.orgId
        ) {
          throw new Error("Login Identity is not active.");
        }
        const session = await tx.authSession.create({
          data: {
            identityId: input.identityId,
            employeeId: input.employeeId,
            orgId: input.orgId,
            absoluteExpiresAt: input.absoluteExpiresAt,
            createdAt: input.now
          },
          select: { id: true }
        });
        await tx.durableCredential.create({
          data: {
            sessionId: session.id,
            credentialHash: input.credentialHash,
            generation: 1,
            createdAt: input.now
          }
        });
        await tx.oAuthAccessToken.create({
          data: {
            sessionId: session.id,
            identityId: input.identityId,
            employeeId: input.employeeId,
            orgId: input.orgId,
            tokenHash: input.accessTokenHash,
            expiresAt: input.accessTokenExpiresAt,
            createdAt: input.now
          }
        });
        await tx.authSecurityEvent.create({
          data: {
            eventType: "session_created",
            outcome: "succeeded",
            orgId: input.orgId,
            identityId: input.identityId,
            employeeId: input.employeeId,
            sessionId: session.id,
            ...eventAudit(input.audit),
            createdAt: input.now
          }
        });
        return session.id;
      });
    },

    async rotateDurableCredential(input): Promise<RotateCredentialResult> {
      return prisma.$transaction(async (tx) => {
        const credential = await tx.durableCredential.findUnique({
          where: { credentialHash: input.presentedCredentialHash },
          include: { session: true }
        });
        if (!credential) {
          return { status: "invalid" };
        }
        if (credential.status !== "active") {
          await revokeSessionFamily(tx, credential.sessionId, "credential_replay", input.now);
          await tx.authSecurityEvent.create({
            data: {
              eventType: "credential_replay_detected",
              outcome: "denied",
              reason: "consumed_generation_reused",
              orgId: credential.session.orgId,
              identityId: credential.session.identityId,
              employeeId: credential.session.employeeId,
              sessionId: credential.sessionId,
              ...eventAudit(input.audit),
              createdAt: input.now
            }
          });
          await tx.authSecurityEvent.create({
            data: {
              eventType: "session_revoked",
              outcome: "succeeded",
              reason: "credential_replay",
              orgId: credential.session.orgId,
              identityId: credential.session.identityId,
              employeeId: credential.session.employeeId,
              sessionId: credential.sessionId,
              ...eventAudit(input.audit),
              createdAt: input.now
            }
          });
          return { status: "replayed", sessionId: credential.sessionId };
        }
        if (
          credential.session.status !== "active" ||
          credential.session.absoluteExpiresAt <= input.now
        ) {
          if (
            credential.session.status === "active" &&
            credential.session.absoluteExpiresAt <= input.now
          ) {
            await revokeSessionFamily(tx, credential.sessionId, "session_expired", input.now);
            await tx.authSecurityEvent.create({
              data: {
                eventType: "session_expired",
                outcome: "denied",
                reason: "absolute_lifetime_elapsed",
                orgId: credential.session.orgId,
                identityId: credential.session.identityId,
                employeeId: credential.session.employeeId,
                sessionId: credential.sessionId,
                ...eventAudit(input.audit),
                createdAt: input.now
              }
            });
          }
          return { status: "invalid" };
        }
        const consumed = await tx.durableCredential.updateMany({
          where: { id: credential.id, status: "active" },
          data: { status: "consumed", consumedAt: input.now }
        });
        if (consumed.count !== 1) {
          await revokeSessionFamily(tx, credential.sessionId, "credential_replay", input.now);
          await tx.authSecurityEvent.create({
            data: {
              eventType: "credential_replay_detected",
              outcome: "denied",
              reason: "concurrent_generation_reuse",
              orgId: credential.session.orgId,
              identityId: credential.session.identityId,
              employeeId: credential.session.employeeId,
              sessionId: credential.sessionId,
              ...eventAudit(input.audit),
              createdAt: input.now
            }
          });
          await tx.authSecurityEvent.create({
            data: {
              eventType: "session_revoked",
              outcome: "succeeded",
              reason: "credential_replay",
              orgId: credential.session.orgId,
              identityId: credential.session.identityId,
              employeeId: credential.session.employeeId,
              sessionId: credential.sessionId,
              ...eventAudit(input.audit),
              createdAt: input.now
            }
          });
          return { status: "replayed", sessionId: credential.sessionId };
        }
        await tx.durableCredential.create({
          data: {
            sessionId: credential.sessionId,
            credentialHash: input.replacementCredentialHash,
            generation: credential.generation + 1,
            createdAt: input.now
          }
        });
        await tx.oAuthAccessToken.create({
          data: {
            sessionId: credential.sessionId,
            identityId: credential.session.identityId,
            employeeId: credential.session.employeeId,
            orgId: credential.session.orgId,
            tokenHash: input.accessTokenHash,
            expiresAt: input.accessTokenExpiresAt,
            createdAt: input.now
          }
        });
        return {
          status: "rotated",
          sessionId: credential.sessionId,
          identityId: credential.session.identityId,
          employeeId: credential.session.employeeId,
          orgId: credential.session.orgId
        };
      });
    },

    async authenticateAccessToken(
      tokenHash,
      now,
      audit
    ): Promise<AccessAuthenticationRecord | null> {
      const token = await prisma.oAuthAccessToken.findUnique({
        where: { tokenHash },
        include: {
          session: true,
          identity: true,
          employee: {
            include: {
              employeeLabels: {
                include: {
                  label: {
                    select: { key: true }
                  }
                }
              }
            }
          }
        }
      });
      if (
        !token ||
        token.revokedAt ||
        token.expiresAt <= now ||
        token.session.status !== "active"
      ) {
        return null;
      }
      if (token.session.absoluteExpiresAt <= now) {
        await prisma.$transaction(async (tx) => {
          await revokeSessionFamily(tx, token.sessionId, "session_expired", now);
          await tx.authSecurityEvent.create({
            data: {
              eventType: "session_expired",
              outcome: "denied",
              reason: "absolute_lifetime_elapsed",
              orgId: token.orgId,
              identityId: token.identityId,
              employeeId: token.employeeId,
              sessionId: token.sessionId,
              ...eventAudit(audit),
              createdAt: now
            }
          });
        });
        return null;
      }
      await prisma.oAuthAccessToken.updateMany({
        where: { id: token.id, revokedAt: null },
        data: { lastUsedAt: now }
      });
      return {
        identityId: token.identityId,
        employeeId: token.employeeId,
        orgId: token.orgId,
        email: token.employee.email,
        role: token.employee.role,
        labels: token.employee.employeeLabels.map(({ label }) => label.key).sort(),
        identityDisabled: token.identity.disabled,
        employeeDisabled: token.employee.disabled
      };
    },

    async revokeSessionByDurableCredential(credentialHash, reason, now, audit) {
      return prisma.$transaction(async (tx) => {
        const credential = await tx.durableCredential.findUnique({
          where: { credentialHash },
          select: { sessionId: true }
        });
        if (!credential) {
          return false;
        }
        const session = await tx.authSession.findUniqueOrThrow({
          where: { id: credential.sessionId }
        });
        await revokeSessionFamily(tx, credential.sessionId, reason, now);
        await tx.authSecurityEvent.create({
          data: {
            eventType: "logout",
            outcome: "succeeded",
            reason,
            orgId: session.orgId,
            identityId: session.identityId,
            employeeId: session.employeeId,
            sessionId: session.id,
            ...eventAudit(audit),
            createdAt: now
          }
        });
        await tx.authSecurityEvent.create({
          data: {
            eventType: "session_revoked",
            outcome: "succeeded",
            reason,
            orgId: session.orgId,
            identityId: session.identityId,
            employeeId: session.employeeId,
            sessionId: session.id,
            ...eventAudit(audit),
            createdAt: now
          }
        });
        return true;
      });
    },

    async revokeIdentitySessions(identityId, reason, now) {
      return prisma.$transaction(async (tx) => {
        const sessions = await tx.authSession.findMany({
          where: { identityId, status: "active" },
          select: { id: true }
        });
        for (const session of sessions) {
          await revokeSessionFamily(tx, session.id, reason, now);
          const details = await tx.authSession.findUniqueOrThrow({
            where: { id: session.id },
            select: { orgId: true, identityId: true, employeeId: true }
          });
          await tx.authSecurityEvent.create({
            data: {
              eventType: "session_revoked",
              outcome: "succeeded",
              reason,
              orgId: details.orgId,
              identityId: details.identityId,
              employeeId: details.employeeId,
              sessionId: session.id,
              createdAt: now
            }
          });
        }
        return sessions.length;
      });
    },

    async writeSecurityEvent(event: SecurityEventInput & { createdAt: Date }) {
      await prisma.authSecurityEvent.create({
        data: {
          eventType: event.type,
          outcome: event.outcome,
          reason: event.reason,
          requestId: event.requestId,
          sourceIp: event.sourceIp,
          launcherVersion: event.launcherVersion,
          orgId: event.orgId,
          identityId: event.identityId,
          employeeId: event.employeeId,
          sessionId: event.sessionId,
          createdAt: event.createdAt
        }
      });
    },

    async pruneSecurityEvents(before) {
      return (await prisma.authSecurityEvent.deleteMany({ where: { createdAt: { lt: before } } }))
        .count;
    }
  };
}
