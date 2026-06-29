export const AUTH_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  employeeDisabled: "EMPLOYEE_DISABLED",
  devLoginUnavailable: "DEV_LOGIN_UNAVAILABLE",
  employeeNotFound: "EMPLOYEE_NOT_FOUND"
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export type EmployeeRoleName = "admin" | "manager" | "employee";

export interface AuthenticatedEmployee {
  id: string;
  email: string;
  role: EmployeeRoleName;
  disabled: boolean;
  labels: string[];
}
