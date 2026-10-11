import type { AuthenticatedEmployee, AuthorizationSnapshot } from "@smedc/domain";
import type { BusinessAuthorizationService } from "./business-authorization.js";

export function legacyAuthorization(
  employee: Pick<AuthenticatedEmployee, "id" | "orgId" | "role" | "clearance" | "disabled">
): AuthorizationSnapshot {
  return {
    orgId: employee.orgId,
    employeeId: employee.id,
    role: employee.role,
    disabled: employee.disabled,
    clearance: employee.clearance,
    mode: "legacy",
    authorizationVersion: "0",
    categories: [],
    grants: []
  };
}
export function legacyPermissionService(
  employees: AuthenticatedEmployee | AuthenticatedEmployee[]
): BusinessAuthorizationService {
  const candidates = Array.isArray(employees) ? employees : [employees];
  return {
    current: async (actor) => {
      const employee = candidates.find((candidate) => candidate.id === actor.id) ?? candidates[0]!;
      return legacyAuthorization({ ...employee, id: actor.id, orgId: actor.orgId });
    }
  } as BusinessAuthorizationService;
}
