import { z } from "zod";

export interface CachedUserProfile {
  displayName: string;
  email: string;
  role: "admin" | "employee";
  clearance: number;
  organizationName: string;
}

const nonblankString = z.string().refine((value) => value.trim().length > 0);

export const cachedUserProfileSchema = z.strictObject({
  displayName: nonblankString,
  email: nonblankString,
  role: z.enum(["admin", "employee"]),
  clearance: z.number().int().min(0).max(3),
  organizationName: nonblankString
});

const currentUserResponseSchema = z.object({ employee: z.record(z.string(), z.unknown()) });

export function parseCurrentUserProfileResponse(value: unknown): CachedUserProfile {
  const { employee } = currentUserResponseSchema.parse(value);
  return cachedUserProfileSchema.parse({
    displayName: employee.displayName,
    email: employee.email,
    role: employee.role,
    clearance: employee.clearance,
    organizationName: employee.organizationName
  });
}
