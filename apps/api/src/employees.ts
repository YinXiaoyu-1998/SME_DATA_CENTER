import { createDatabaseAdapter } from "@enterprise-hub/db";
import { PrismaClient } from "@prisma/client";
import type { AuthenticatedEmployee, EmployeeRoleName } from "@enterprise-hub/domain";

export interface EmployeeRepository {
  findByEmail(email: string): Promise<AuthenticatedEmployee | null>;
  findById(id: string): Promise<AuthenticatedEmployee | null>;
  disconnect?(): Promise<void>;
}

interface PrismaEmployeeRow {
  id: string;
  orgId: string;
  displayName: string;
  email: string;
  role: EmployeeRoleName;
  clearance: number;
  disabled: boolean;
}

function toAuthenticatedEmployee(employee: PrismaEmployeeRow): AuthenticatedEmployee {
  return {
    id: employee.id,
    orgId: employee.orgId,
    displayName: employee.displayName,
    email: employee.email,
    role: employee.role,
    clearance: employee.clearance,
    disabled: employee.disabled
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the API with the Prisma employee repository."
    );
  }

  return databaseUrl;
}

export function createPrismaEmployeeRepository(
  databaseUrl = requireDatabaseUrl()
): EmployeeRepository {
  const adapter = createDatabaseAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async findByEmail(email: string) {
      const employee = await prisma.employee.findUnique({
        where: { email }
      });

      return employee ? toAuthenticatedEmployee(employee) : null;
    },
    async findById(id: string) {
      const employee = await prisma.employee.findUnique({
        where: { id }
      });

      return employee ? toAuthenticatedEmployee(employee) : null;
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}
