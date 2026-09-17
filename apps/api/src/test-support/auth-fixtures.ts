import type { AuthenticatedEmployee } from "@smedc/domain";
import { buildApiServer } from "../server.js";
import type { EmployeeRepository } from "../employees.js";

export const jwtSecret = "test-local-jwt-secret";
export const officialTestTokens = new Map<string, AuthenticatedEmployee>();

export async function authenticateTestAccessToken(token: string) {
  return officialTestTokens.get(token) ?? null;
}

export const adminEmployee: AuthenticatedEmployee = {
  id: "emp_admin",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Admin User",
  email: "admin@example.com",
  role: "admin",
  clearance: 3,
  disabled: false
};

export const lowClearanceAdminEmployee: AuthenticatedEmployee = {
  id: "emp_admin_clearance_0",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Low Clearance Admin",
  email: "admin.clearance-0@example.com",
  role: "admin",
  clearance: 0,
  disabled: false
};

export const disabledEmployee: AuthenticatedEmployee = {
  id: "emp_disabled",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Disabled User",
  email: "disabled@example.com",
  role: "employee",
  clearance: 0,
  disabled: true
};

export const baoliEmployee: AuthenticatedEmployee = {
  id: "emp_baoli_employee",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Baoli Employee",
  email: "baoli.employee@example.com",
  role: "employee",
  clearance: 1,
  disabled: false
};

export const suzhouEmployee: AuthenticatedEmployee = {
  id: "emp_suzhou_employee",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Suzhou Employee",
  email: "suzhou.employee@example.com",
  role: "employee",
  clearance: 2,
  disabled: false
};

export const lijieEmployee: AuthenticatedEmployee = {
  id: "emp_lijie",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Li Jie",
  email: "lijie@example.com",
  role: "employee",
  clearance: 0,
  disabled: false
};

export const orgAAdminEmployee: AuthenticatedEmployee = {
  id: "emp_org_a_admin",
  orgId: "org-a",
  organizationName: "Organization A",
  displayName: "Organization A Admin",
  email: "org-a.admin@example.com",
  role: "admin",
  clearance: 3,
  disabled: false
};

export const orgBAdminEmployee: AuthenticatedEmployee = {
  id: "emp_org_b_admin",
  orgId: "org-b",
  organizationName: "Organization B",
  displayName: "Organization B Admin",
  email: "org-b.admin@example.com",
  role: "admin",
  clearance: 3,
  disabled: false
};

export const clearanceZeroEmployee: AuthenticatedEmployee = {
  id: "emp_clearance_zero",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Clearance-zero Employee",
  email: "clearance.zero@example.com",
  role: "employee",
  clearance: 0,
  disabled: false
};

export const clearanceZeroAdminEmployee: AuthenticatedEmployee = {
  id: "emp_clearance_zero_admin",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Clearance-zero Admin",
  email: "clearance.zero.admin@example.com",
  role: "admin",
  clearance: 0,
  disabled: false
};

export function createRepository(employees: AuthenticatedEmployee[]): EmployeeRepository {
  return {
    async findByEmail(email: string) {
      return employees.find((employee) => employee.email === email) ?? null;
    },
    async findById(id: string) {
      return employees.find((employee) => employee.id === id) ?? null;
    }
  };
}

export function buildTestServer(employees = [adminEmployee, disabledEmployee]) {
  return buildApiServer({
    employeeRepository: createRepository(employees),
    cursorSigningSecret: jwtSecret,
    authenticateAccessToken: authenticateTestAccessToken,
    logger: false
  });
}

export async function accessTokenFor(employee: AuthenticatedEmployee) {
  const token = `eh_at_test_${employee.id}`;
  officialTestTokens.set(token, employee);
  return token;
}
