import { z } from "zod";

const enterpriseKey = z.string().min(1).max(128);
const id = z.string().uuid();
const name = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim().length > 0);
const version = z.string().regex(/^(0|[1-9]\d*)$/);
const scope = z.discriminatedUnion("ownership", [
  z.object({ ownership: z.literal("group"), storeId: z.null() }).strict(),
  z.object({ ownership: z.literal("store"), storeId: id }).strict()
]);

export const directoryInputSchemas = {
  list_directory: z.object({ enterpriseKey, management: z.boolean().optional() }).strict(),
  list_employees: z
    .object({
      enterpriseKey,
      status: z.enum(["active", "departed"]).optional(),
      search: z.string().max(255).optional(),
      departmentId: id.optional(),
      storeId: id.optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).optional()
    })
    .strict(),
  get_employee: z.object({ enterpriseKey, employeeUid: id }).strict(),
  create_employee: z.object({ enterpriseKey, name, departmentId: id, scope }).strict(),
  update_employee: z
    .object({
      enterpriseKey,
      employeeUid: id,
      expectedVersion: version,
      name,
      departmentId: id,
      scope,
      status: z.enum(["active", "departed"])
    })
    .strict(),
  manage_store: z
    .object({
      enterpriseKey,
      operation: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("create"), name }).strict(),
        z
          .object({ kind: z.literal("rename"), storeId: id, expectedVersion: version, name })
          .strict(),
        z.object({ kind: z.literal("confirm"), storeId: id, expectedVersion: version }).strict(),
        z.object({ kind: z.literal("historical"), storeId: id, expectedVersion: version }).strict(),
        z.object({ kind: z.literal("retire"), storeId: id, expectedVersion: version }).strict(),
        z.object({ kind: z.literal("restore"), storeId: id, expectedVersion: version }).strict()
      ])
    })
    .strict(),
  manage_department: z
    .object({
      enterpriseKey,
      operation: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("create"), name }).strict(),
        z
          .object({ kind: z.literal("rename"), departmentId: id, expectedVersion: version, name })
          .strict(),
        z
          .object({ kind: z.literal("retire"), departmentId: id, expectedVersion: version })
          .strict(),
        z
          .object({ kind: z.literal("restore"), departmentId: id, expectedVersion: version })
          .strict()
      ])
    })
    .strict()
} as const;

export const queryEmployeeDirectoryInput = z.discriminatedUnion("action", [
  directoryInputSchemas.list_directory.extend({ action: z.literal("list_directory") }),
  directoryInputSchemas.list_employees.extend({ action: z.literal("list_employees") }),
  directoryInputSchemas.get_employee.extend({ action: z.literal("get_employee") })
]);
export const manageEmployeeDirectoryInput = z.discriminatedUnion("action", [
  directoryInputSchemas.manage_store.extend({ action: z.literal("manage_store") }),
  directoryInputSchemas.manage_department.extend({ action: z.literal("manage_department") }),
  directoryInputSchemas.create_employee.extend({ action: z.literal("create_employee") }),
  directoryInputSchemas.update_employee.extend({ action: z.literal("update_employee") })
]);
