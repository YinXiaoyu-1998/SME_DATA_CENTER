export interface EmployeePermissionSubject {
  disabled: boolean;
  labelKeys: string[];
}

export interface DocumentPermissionTarget {
  labelKeys: string[];
}

export interface DocumentAccessInput {
  employee: EmployeePermissionSubject;
  document: DocumentPermissionTarget;
}

export function canEmployeeAccessDocument(input: DocumentAccessInput): boolean {
  if (input.employee.disabled) {
    return false;
  }

  if (input.document.labelKeys.includes("all_staff")) {
    return true;
  }

  return input.document.labelKeys.some((labelKey) => input.employee.labelKeys.includes(labelKey));
}
