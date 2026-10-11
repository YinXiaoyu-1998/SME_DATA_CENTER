import { Prisma, type PrismaClient } from "@prisma/client";
import type { BrowserSessionRepository } from "./browser-session.js";
import { eventAudit } from "./auth-core.js";
import { hashOpaqueSecret } from "./primitives.js";

export function createPrismaBrowserSessionRepository(
  prisma: PrismaClient
): BrowserSessionRepository {
  return {
    async create(input) {
      return prisma.$transaction(async (tx) => {
        // Password changes and session issuance serialize on the same identity.
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM login_identities WHERE id = ${input.identityId} FOR UPDATE`
        );
        const identity = await tx.loginIdentity.findUnique({
          where: { id: input.identityId },
          include: { employee: true }
        });
        if (
          !identity ||
          identity.disabled ||
          identity.employee.disabled ||
          identity.orgId !== input.orgId ||
          identity.employee.orgId !== input.orgId ||
          identity.employeeId !== input.employeeId ||
          !identity.passwordHash ||
          hashOpaqueSecret(identity.passwordHash) !== input.credentialFingerprint
        )
          return false;
        await tx.browserSession.create({
          data: {
            identityId: input.identityId,
            employeeId: input.employeeId,
            orgId: input.orgId,
            secretHash: input.secretHash,
            credentialFingerprint: input.credentialFingerprint,
            expiresAt: input.expiresAt,
            createdAt: input.now
          }
        });
        await tx.authSecurityEvent.create({
          data: {
            eventType: "session_created",
            outcome: "succeeded",
            reason: "browser_sign_in",
            identityId: input.identityId,
            employeeId: input.employeeId,
            orgId: input.orgId,
            ...eventAudit(input.audit),
            createdAt: input.now
          }
        });
        return true;
      });
    },
    async find(secretHash) {
      const row = await prisma.browserSession.findUnique({
        where: { secretHash },
        include: {
          identity: {
            include: { employee: { include: { organization: { select: { name: true } } } } }
          }
        }
      });
      if (
        !row ||
        row.identity.disabled ||
        row.identity.employee.disabled ||
        !row.identity.passwordHash ||
        row.identityId !== row.identity.id ||
        row.employeeId !== row.identity.employeeId ||
        row.orgId !== row.identity.orgId ||
        row.orgId !== row.identity.employee.orgId
      )
        return null;
      const employee = row.identity.employee;
      return {
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        credentialFingerprint: row.credentialFingerprint,
        currentCredentialFingerprint: hashOpaqueSecret(row.identity.passwordHash),
        principal: {
          identityId: row.identityId,
          id: employee.id,
          orgId: employee.orgId,
          organizationName: employee.organization.name,
          displayName: employee.displayName,
          email: employee.email,
          role: employee.role,
          clearance: employee.clearance,
          disabled: employee.disabled
        }
      };
    },
    async revoke(secretHash, now) {
      await prisma.$transaction(async (tx) => {
        const row = await tx.browserSession.findUnique({
          where: { secretHash },
          select: { identityId: true, employeeId: true, orgId: true }
        });
        const result = await tx.browserSession.updateMany({
          where: { secretHash, revokedAt: null },
          data: { revokedAt: now }
        });
        if (row && result.count)
          await tx.authSecurityEvent.create({
            data: {
              ...row,
              eventType: "session_revoked",
              outcome: "succeeded",
              reason: "browser_logout",
              createdAt: now
            }
          });
      });
    }
  };
}
