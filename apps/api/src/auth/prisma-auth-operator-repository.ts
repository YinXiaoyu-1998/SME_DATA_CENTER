import { Prisma, type PrismaClient } from "@prisma/client";
import type { AuthOperatorRepository } from "./operator-cli.js";

export function createPrismaAuthOperatorRepository(prisma: PrismaClient): AuthOperatorRepository {
  return {
    async onboard(input) {
      return prisma.$transaction(async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: input.orgId },
          select: { id: true }
        });
        if (!organization) {
          throw new Error("Organization not found.");
        }
        const employee = await tx.employee.create({
          data: {
            orgId: input.orgId,
            email: input.normalizedEmail,
            displayName: input.displayName,
            role: input.role,
            clearance: input.clearance
          },
          select: { id: true }
        });
        const identity = await tx.loginIdentity.create({
          data: {
            orgId: input.orgId,
            employeeId: employee.id,
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
            employeeId: employee.id,
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
            employeeId: employee.id,
            identityId: identity.id,
            createdAt: input.now
          }
        });
        return { employeeId: employee.id, identityId: identity.id };
      });
    },

    async resetPassword(input) {
      return prisma.$transaction(async (tx) => {
        const identities = await tx.loginIdentity.findMany({
          where: {
            employeeId: input.employeeId,
            provider: "local_password",
            disabled: false
          },
          select: { id: true, employeeId: true, orgId: true },
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
            employeeId: identity.employeeId,
            identityId: identity.id,
            createdAt: input.now
          }
        });
        return { employeeId: identity.employeeId, identityId: identity.id };
      });
    },

    async deleteTestAccount(input) {
      return prisma.$transaction(async (tx) => {
        const identity = await tx.loginIdentity.findUnique({
          where: { normalizedEmail: input.normalizedEmail },
          select: { id: true, employeeId: true, orgId: true }
        });
        if (!identity) {
          return null;
        }

        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM employees WHERE id = ${identity.employeeId} FOR UPDATE`
        );

        const uploadedDocumentCount = await tx.document.count({
          where: { uploaderId: identity.employeeId }
        });
        if (uploadedDocumentCount > 0) {
          throw new Error("Test account still owns uploaded documents; clean test data first.");
        }

        const identities = await tx.loginIdentity.findMany({
          where: { employeeId: identity.employeeId },
          select: { id: true }
        });
        const identityIds = identities.map((row) => row.id);
        const sessions = await tx.authSession.findMany({
          where: { employeeId: identity.employeeId },
          select: { id: true }
        });
        const sessionIds = sessions.map((row) => row.id);

        await tx.oAuthAccessToken.deleteMany({
          where: { OR: [{ employeeId: identity.employeeId }, { identityId: { in: identityIds } }] }
        });
        await tx.durableCredential.deleteMany({
          where: { sessionId: { in: sessionIds } }
        });
        await tx.authSecurityEvent.deleteMany({
          where: {
            OR: [
              { employeeId: identity.employeeId },
              { identityId: { in: identityIds } },
              { sessionId: { in: sessionIds } }
            ]
          }
        });
        await tx.authSession.deleteMany({
          where: { id: { in: sessionIds } }
        });
        await tx.oAuthAuthorizationCode.deleteMany({
          where: { OR: [{ employeeId: identity.employeeId }, { identityId: { in: identityIds } }] }
        });
        await tx.oAuthAuthorizationTransaction.deleteMany({
          where: { identityId: { in: identityIds } }
        });
        await tx.passwordSetupSession.deleteMany({
          where: { identityId: { in: identityIds } }
        });
        await tx.passwordSetupGrant.deleteMany({
          where: { identityId: { in: identityIds } }
        });
        await tx.auditLog.deleteMany({
          where: { actorEmployeeId: identity.employeeId }
        });
        await tx.loginIdentity.deleteMany({
          where: { id: { in: identityIds } }
        });
        await tx.employee.delete({ where: { id: identity.employeeId } });

        return {
          employeeId: identity.employeeId,
          identityIds
        };
      });
    },

    async disconnect() {
      await prisma.$disconnect();
    }
  };
}
