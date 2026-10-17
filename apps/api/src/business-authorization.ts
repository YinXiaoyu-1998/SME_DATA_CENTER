import { createDatabaseAdapter, createBusinessAuthorizationRepository } from "@smedc/db";
import { createAuthorizationCutoverService } from "./business-authorization-cutover.js";
import { PrismaClient } from "@prisma/client";
import type { AuthenticatedEmployee } from "@smedc/domain";

export type BusinessAuthorizationRepository = ReturnType<
  typeof createBusinessAuthorizationRepository
>;
export function createBusinessAuthorizationService(repository: BusinessAuthorizationRepository) {
  async function current(employee: Pick<AuthenticatedEmployee, "id" | "orgId">, admin = false) {
    const snapshot = await repository.loadAuthorizationSnapshot(employee.id, employee.orgId);
    if (snapshot.disabled || (admin && snapshot.role !== "admin"))
      throw new Error("AUTHORIZATION_ADMIN_REQUIRED");
    return snapshot;
  }
  async function permissionCard(employee: Pick<AuthenticatedEmployee, "id" | "orgId">) {
    const snapshot = await repository.loadPermissionCard(employee.id, employee.orgId);
    if (snapshot.disabled) throw new Error("AUTHORIZATION_ADMIN_REQUIRED");
    return snapshot;
  }
  return { repository, current, permissionCard, ...createAuthorizationCutoverService(repository) };
}
export type BusinessAuthorizationService = ReturnType<typeof createBusinessAuthorizationService>;
export function createPrismaBusinessAuthorizationService(databaseUrl: string) {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  return {
    ...createBusinessAuthorizationService(createBusinessAuthorizationRepository({ prisma })),
    disconnect: () => prisma.$disconnect()
  };
}
