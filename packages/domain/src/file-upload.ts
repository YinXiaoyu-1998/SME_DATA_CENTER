export const FILE_UPLOAD_ADMIN_REQUIRED_CODE = "UPLOAD_ADMIN_REQUIRED";
export const FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE = "File upload requires the admin role.";

export function canEmployeeUploadFiles(subject: {
  role: "admin" | "employee";
  disabled: boolean;
}): boolean {
  return !subject.disabled && subject.role === "admin";
}
