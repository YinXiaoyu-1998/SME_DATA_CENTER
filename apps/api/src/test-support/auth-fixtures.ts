import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
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
  email: "admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:admin", "store:baoli", "store:suzhou"]
};

export const disabledEmployee: AuthenticatedEmployee = {
  id: "emp_disabled",
  orgId: "default-org",
  email: "disabled@example.com",
  role: "employee",
  disabled: true,
  labels: ["all_staff", "person:disabled"]
};

export const baoliManagerEmployee: AuthenticatedEmployee = {
  id: "emp_baoli_manager",
  orgId: "default-org",
  email: "baoli.manager@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "person:baoli.manager", "store:baoli"]
};

export const suzhouManagerEmployee: AuthenticatedEmployee = {
  id: "emp_suzhou_manager",
  orgId: "default-org",
  email: "suzhou.manager@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "person:suzhou.manager", "store:suzhou"]
};

export const lijieEmployee: AuthenticatedEmployee = {
  id: "emp_lijie",
  orgId: "default-org",
  email: "lijie@example.com",
  role: "employee",
  disabled: false,
  labels: ["all_staff", "person:lijie"]
};

export const orgAAdminEmployee: AuthenticatedEmployee = {
  id: "emp_org_a_admin",
  orgId: "org-a",
  email: "org-a.admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:org-a.admin"]
};

export const orgBAdminEmployee: AuthenticatedEmployee = {
  id: "emp_org_b_admin",
  orgId: "org-b",
  email: "org-b.admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:org-b.admin"]
};

export const labelLessEmployee: AuthenticatedEmployee = {
  id: "emp_label_less",
  orgId: "default-org",
  email: "label.less@example.com",
  role: "employee",
  disabled: false,
  labels: []
};

export const unlabeledAdminEmployee: AuthenticatedEmployee = {
  id: "emp_unlabeled_admin",
  orgId: "default-org",
  email: "unlabeled.admin@example.com",
  role: "admin",
  disabled: false,
  labels: []
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
