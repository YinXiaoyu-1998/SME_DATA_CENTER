import { isBusinessClearance } from "@smedc/domain";
import {
  createBusinessAuthorizationRepository,
  persistBusinessGrants,
  initializeFixedBusinessCategories
} from "@smedc/db";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { AuthOperatorRepository } from "./operator-cli.js";

export function createPrismaAuthOperatorRepository(prisma: PrismaClient): AuthOperatorRepository {
  return {
    async onboard(input) {
      return prisma.$transaction(async (tx) => {
        if (!isBusinessClearance(input.clearance)) throw new Error("INVALID_ACCOUNT_CLEARANCE");
        const organization = await tx.organization.findUnique({
          where: { id: input.orgId },
          select: { id: true }
        });
        if (!organization) {
          throw new Error("Organization not found.");
        }
        const employee = await tx.userAccount.create({
          data: {
            orgId: input.orgId,
            email: input.normalizedEmail,
            displayName: input.displayName,
            role: input.role,
            clearance: input.clearance
          },
          select: { id: true }
        });
        const state = await tx.businessAuthorizationState.upsert({
          where: { orgId: input.orgId },
          create: { orgId: input.orgId, version: 1n },
          update: { version: { increment: 1 } }
        });
        await initializeFixedBusinessCategories(tx, input.orgId);
        const snapshot = await createBusinessAuthorizationRepository({
          prisma
        }).loadAuthorizationSnapshot(employee.id, input.orgId, tx);
        await persistBusinessGrants(
          tx,
          { orgId: input.orgId, userAccountId: employee.id, grants: input.initialGrants ?? [] },
          snapshot.categories
        );
        await tx.auditLog.create({
          data: {
            orgId: input.orgId,
            actorUserAccountId: null,
            action: "operator.account.initial_permissions",
            targetType: "employee",
            targetId: employee.id,
            result: "succeeded",
            clientSource: "operator_cli",
            metadata: {
              before: null,
              after: {
                clearance: input.clearance,
                grants: JSON.parse(JSON.stringify(input.initialGrants ?? []))
              },
              authorizationVersion: state.version.toString()
            }
          }
        });
        const identity = await tx.loginIdentity.create({
          data: {
            orgId: input.orgId,
            userAccountId: employee.id,
            normalizedEmail: input.normalizedEmail
          },
          select: { id: true }
        });
        await tx.passwordSetupGrant.create({
          data: {
            identityId: identity.id,
            purpose: "initial_setup",
            tokenHash: input.grantTokenHash,
            expiresAt: input.grantExpiresAt,
            createdAt: input.now
          }
        });
        await tx.authSecurityEvent.create({
          data: {
            eventType: "account_onboarded",
            outcome: "succeeded",
            orgId: input.orgId,
            userAccountId: employee.id,
            identityId: identity.id,
            createdAt: input.now
          }
        });
        await tx.authSecurityEvent.create({
          data: {
            eventType: "setup_grant_issued",
            outcome: "succeeded",
            reason: "initial_setup",
            orgId: input.orgId,
            userAccountId: employee.id,
            identityId: identity.id,
            createdAt: input.now
          }
        });
        return { userAccountId: employee.id, identityId: identity.id };
      });
    },

    async resetPassword(input) {
      return prisma.$transaction(async (tx) => {
        const identities = await tx.loginIdentity.findMany({
          where: {
            userAccountId: input.userAccountId,
            provider: "local_password",
            disabled: false
          },
          select: { id: true, userAccountId: true, orgId: true },
          take: 2
        });
        if (identities.length === 0) {
          return null;
        }
        if (identities.length !== 1) {
          throw new Error("Employee has multiple active local-password Login Identities.");
        }
        const identity = identities[0]!;
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM login_identities WHERE id = ${identity.id} FOR UPDATE`
        );
        await tx.browserSession.updateMany({
          where: { identityId: identity.id, revokedAt: null },
          data: { revokedAt: input.now }
        });
        await tx.passwordSetupSession.updateMany({
          where: {
            identityId: identity.id,
            consumedAt: null,
            revokedAt: null
          },
          data: { revokedAt: input.now }
        });
        await tx.passwordSetupGrant.updateMany({
          where: {
            identityId: identity.id,
            usedAt: null,
            revokedAt: null
          },
          data: { revokedAt: input.now }
        });
        await tx.passwordSetupGrant.create({
          data: {
            identityId: identity.id,
            purpose: "password_reset",
            tokenHash: input.grantTokenHash,
            expiresAt: input.grantExpiresAt,
            createdAt: input.now
          }
        });
        await tx.authSecurityEvent.create({
          data: {
            eventType: "setup_grant_issued",
            outcome: "succeeded",
            reason: "password_reset",
            orgId: identity.orgId,
            userAccountId: identity.userAccountId,
            identityId: identity.id,
            createdAt: input.now
          }
        });
        return { userAccountId: identity.userAccountId, identityId: identity.id };
      });
    },

    async deleteTestAccount(input) {
      return prisma.$transaction(async (tx) => {
        const identity = await tx.loginIdentity.findUnique({
          where: { normalizedEmail: input.normalizedEmail },
          select: { id: true, userAccountId: true, orgId: true }
        });
        if (!identity) {
          return null;
        }

        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM employees WHERE id = ${identity.userAccountId} FOR UPDATE`
        );

        const uploadedDocumentCount = await tx.document.count({
          where: { uploaderId: identity.userAccountId }
        });
        if (uploadedDocumentCount > 0) {
          throw new Error("Test account still owns uploaded documents; clean test data first.");
        }

        const identities = await tx.loginIdentity.findMany({
          where: { userAccountId: identity.userAccountId },
          select: { id: true }
        });
        const identityIds = identities.map((row) => row.id);
        const sessions = await tx.authSession.findMany({
          where: { userAccountId: identity.userAccountId },
          select: { id: true }
        });
        const sessionIds = sessions.map((row) => row.id);

        await tx.oAuthAccessToken.deleteMany({
          where: {
            OR: [{ userAccountId: identity.userAccountId }, { identityId: { in: identityIds } }]
          }
        });
        await tx.durableCredential.deleteMany({
          where: { sessionId: { in: sessionIds } }
        });
        await tx.authSecurityEvent.deleteMany({
          where: {
            OR: [
              { userAccountId: identity.userAccountId },
              { identityId: { in: identityIds } },
              { sessionId: { in: sessionIds } }
            ]
          }
        });
        await tx.authSession.deleteMany({
          where: { id: { in: sessionIds } }
        });
        await tx.passwordSetupSession.deleteMany({
          where: { identityId: { in: identityIds } }
        });
        await tx.passwordSetupGrant.deleteMany({
          where: { identityId: { in: identityIds } }
        });
        await tx.auditLog.deleteMany({
          where: { actorUserAccountId: identity.userAccountId }
        });
        await tx.loginIdentity.deleteMany({
          where: { id: { in: identityIds } }
        });
        await tx.userAccount.delete({ where: { id: identity.userAccountId } });

        return {
          userAccountId: identity.userAccountId,
          identityIds
        };
      });
    },

    async disconnect() {
      await prisma.$disconnect();
    }
  };
}
