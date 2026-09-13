import type { AuthenticatedEmployee } from "@enterprise-hub/domain";

/**
 * Product-declared operations that require the admin role and intentionally
 * bypass a target document's confidentiality level. This is not a read grant:
 * ordinary retrieval continues to use the document access policy.
 */
export const PRIVILEGED_ADMIN_OPERATIONS = {
  archiveQuarantineCertificates: {
    id: "archive_quarantine_certificates",
    description: "Archive quarantine certificates by receipt ID or source document ID."
  }
} as const;

export function canPerformPrivilegedAdministrativeOperation(
  employee: AuthenticatedEmployee,
  operation: keyof typeof PRIVILEGED_ADMIN_OPERATIONS
): boolean {
  void operation;
  return !employee.disabled && employee.role === "admin";
}
