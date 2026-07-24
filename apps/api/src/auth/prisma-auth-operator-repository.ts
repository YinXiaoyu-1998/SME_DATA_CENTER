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
        const requestedLabelKeys = [...new Set(input.labelKeys)];
        const requestedLabels = await tx.label.findMany({
          where: { orgId: input.orgId, key: { in: requestedLabelKeys } },
          select: { id: true, key: true }
        });
        if (requestedLabels.length !== requestedLabelKeys.length) {
          throw new Error("One or more requested labels do not exist in the organization.");
        }
        const employee = await tx.employee.create({
          data: {
            orgId: input.orgId,
            email: input.normalizedEmail,
            displayName: input.displayName,
            role: input.role
          },
          select: { id: true }
        });
        const personalLabel = await tx.label.create({
          data: {
            orgId: input.orgId,
            key: `person:${employee.id}`,
            name: `${input.displayName} Personal`,
            type: "personal"
          },
          select: { id: true }
        });
        await tx.employeeLabel.createMany({
          data: [personalLabel, ...requestedLabels].map((label) => ({
            employeeId: employee.id,
            labelId: label.id
          })),
          skipDuplicates: true
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

    async audit(input) {
      return prisma.authSecurityEvent.findMany({
        where: { createdAt: { gte: input.since } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
        select: {
          createdAt: true,
          eventType: true,
          outcome: true,
          reason: true,
          requestId: true,
          sourceIp: true,
          launcherVersion: true,
          orgId: true,
          identityId: true,
          employeeId: true,
          sessionId: true
        }
      });
    },

    async disconnect() {
      await prisma.$disconnect();
    }
  };
}
