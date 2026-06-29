export const domainWorkspaceName = "@enterprise-hub/domain";
export {
  canEmployeeAccessDocument,
  type DocumentAccessInput,
  type DocumentPermissionTarget,
  type EmployeePermissionSubject
} from "./permissions.js";
export {
  AUTH_ERROR_CODES,
  type AuthenticatedEmployee,
  type AuthErrorCode,
  type EmployeeRoleName
} from "./auth.js";
export {
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  isDocumentType,
  type DocumentStatusName,
  type DocumentTypeName
} from "./documents.js";
export { AUDIT_ACTIONS, type AuditActionName } from "./audit.js";
