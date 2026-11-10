import { z } from "zod";
import { directoryInputSchemas } from "@smedc/mcp-contract";

export const directoryOrgParams = z
  .object({ orgId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
  .strict();
export { directoryInputSchemas };
const uuid = z.string().uuid();
const version = z.string().regex(/^(0|[1-9]\d*)$/);
const store = z
  .object({
    storeId: uuid,
    name: z.string(),
    status: z.enum(["confirmed", "pending", "historical", "retired"]),
    version
  })
  .strict();
const department = z
  .object({ departmentId: uuid, name: z.string(), status: z.enum(["active", "retired"]), version })
  .strict();
const employee = z
  .object({
    employeeUid: uuid,
    name: z.string(),
    departmentId: uuid,
    departmentName: z.string(),
    scope: z.discriminatedUnion("ownership", [
      z.object({ ownership: z.literal("group"), storeId: z.null(), storeName: z.null() }).strict(),
      z.object({ ownership: z.literal("store"), storeId: uuid, storeName: z.string() }).strict()
    ]),
    status: z.enum(["active", "departed"]),
    version
  })
  .strict();
export const directoryResponses = {
  list_directory: z
    .object({
      enterpriseKey: z.string(),
      enterpriseName: z.string(),
      stores: z.array(store),
      departments: z.array(department)
    })
    .strict(),
  list_employees: z
    .object({
      employees: z.array(employee),
      access: z.enum(["none", "partial", "all"]),
      nextCursor: uuid.nullable()
    })
    .strict(),
  get_employee: z.object({ employee }).strict(),
  create_employee: z.object({ employeeUid: uuid }).strict(),
  update_employee: z.object({ employeeUid: uuid, version }).strict(),
  manage_store: z.object({ storeId: uuid, version }).strict(),
  manage_department: z.object({ departmentId: uuid, version }).strict()
} as const;
