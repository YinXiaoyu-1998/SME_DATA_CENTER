export interface EmployeePermissionSubject {
  disabled: boolean;
  clearance: number;
}

export interface DocumentPermissionTarget {
  confidentialityLevel: number;
}

export interface DocumentAccessInput {
  employee: EmployeePermissionSubject;
  document: DocumentPermissionTarget;
}

export function canEmployeeAccessDocument(input: DocumentAccessInput): boolean {
  if (input.employee.disabled) {
    return false;
  }

  return input.employee.clearance >= input.document.confidentialityLevel;
}
