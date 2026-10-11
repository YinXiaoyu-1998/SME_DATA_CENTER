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
  employee: AuthenticatedEmployee
): BusinessAuthorizationService {
  return {
    current: async (actor) => legacyAuthorization({ ...employee, id: actor.id, orgId: actor.orgId })
  } as BusinessAuthorizationService;
}
