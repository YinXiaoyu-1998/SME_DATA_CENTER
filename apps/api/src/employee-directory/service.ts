import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createBusinessAuthorizationRepository } from "@smedc/db";
import { canReadResource, type AuthorizationSnapshot } from "@smedc/domain";
import { directoryInputSchemas } from "../../../../packages/mcp-contract/src/employee-directory.js";

export type DirectoryAction = keyof typeof directoryInputSchemas;
type Actor = { id: string; orgId: string };
type Tx = Prisma.TransactionClient;
function fail(code: string): never {
  throw new Error(code);
}
const version = (v: bigint) => v.toString();

export function createEmployeeDirectoryService(prisma: PrismaClient) {
  const authorization = createBusinessAuthorizationRepository({ prisma });
  return {
    async execute(action: DirectoryAction, raw: unknown, actor: Actor): Promise<unknown> {
      const input = directoryInputSchemas[action].parse(raw);
      return prisma.$transaction(
        async (tx) => {
          // Shared ordering with permission mutations; serialize all directory writes per enterprise.
          await tx.$queryRaw`SELECT org_id FROM business_authorization_states WHERE org_id = ${actor.orgId} FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM employees WHERE org_id = ${actor.orgId} AND id = ${actor.id} FOR SHARE`;
          const snapshot = await authorization.loadAuthorizationSnapshot(actor.id, actor.orgId, tx);
          if (snapshot.disabled) fail("DIRECTORY_ACCESS_DENIED");
          const write = [
            "create_employee",
            "update_employee",
            "manage_store",
            "manage_department"
          ].includes(action);
          if (
            (write || (action === "list_directory" && "management" in input && input.management)) &&
            snapshot.role !== "admin"
          )
            fail("DIRECTORY_ACCESS_DENIED");
          // A management write and employee assignment always lock the same parent row.
          const enterprises = await tx.$queryRaw<Array<{ enterpriseName: string }>>(
            write
              ? Prisma.sql`SELECT enterprise_name AS enterpriseName FROM business_enterprise_identities WHERE org_id = ${actor.orgId} AND BINARY enterprise_key = BINARY ${input.enterpriseKey} FOR UPDATE`
              : Prisma.sql`SELECT enterprise_name AS enterpriseName FROM business_enterprise_identities WHERE org_id = ${actor.orgId} AND BINARY enterprise_key = BINARY ${input.enterpriseKey}`
          );
          if (!enterprises[0]) fail("DIRECTORY_NOT_FOUND");
          const where = { orgId: actor.orgId, enterpriseKey: input.enterpriseKey };
          const audit = async (targetId: string) => {
            await tx.auditLog.create({
              data: {
                orgId: actor.orgId,
                actorUserAccountId: actor.id,
                action: `directory.${action}`,
                targetType: "employee_directory",
                targetId,
                result: "succeeded",
                metadata: {}
              }
            });
          };
          const read = (storeKey: string | null) =>
            canReadProfile(snapshot, actor.orgId, input.enterpriseKey, storeKey);
          const scopeFor = async (storeId: string | null, requireActive: boolean) => {
            if (!storeId) return null;
            const store = await tx.businessStore.findFirst({ where: { ...where, storeId } });
            if (!store || (requireActive && (store.retired || store.confirmation !== "confirmed")))
              fail("DIRECTORY_NOT_FOUND");
            return store;
          };
          const employeeView = async (row: {
            employeeUid: string;
            name: string;
            departmentId: string;
            storeId: string | null;
            status: "active" | "departed";
            version: bigint;
          }) => {
            const department = await tx.businessDepartment.findFirst({
              where: { ...where, departmentId: row.departmentId }
            });
            const store = await scopeFor(row.storeId, false);
            if (!department) fail("DIRECTORY_NOT_FOUND");
            return {
              employeeUid: row.employeeUid,
              name: row.name,
              departmentId: row.departmentId,
              departmentName: department.name,
              scope: store
                ? {
                    ownership: "store" as const,
                    storeId: store.storeId,
                    storeName: store.officialName
                  }
                : { ownership: "group" as const, storeId: null, storeName: null },
              status: row.status,
              version: version(row.version)
            };
          };
          if (action === "list_directory") {
            const management =
              directoryInputSchemas.list_directory.parse(input).management === true;
            const stores = await tx.businessStore.findMany({
              where: {
                ...where,
                ...(management ? {} : { retired: false, confirmation: "confirmed" })
              },
              orderBy: { officialName: "asc" }
            });
            const departments = await tx.businessDepartment.findMany({
              where: { ...where, ...(management ? {} : { retired: false }) },
              orderBy: { name: "asc" }
            });
            return {
              enterpriseKey: input.enterpriseKey,
              enterpriseName: enterprises[0]!.enterpriseName,
              stores: stores.map((s) => ({
                storeId: s.storeId,
                ...(management ? { storeKey: s.name } : {}),
                name: s.officialName,
                status: s.retired ? "retired" : s.confirmation,
                version: version(s.version)
              })),
              departments: departments.map((d) => ({
                departmentId: d.departmentId,
                name: d.name,
                status: d.retired ? "retired" : "active",
                version: version(d.version)
              }))
            };
          }
          if (action === "list_employees") {
            const q = directoryInputSchemas.list_employees.parse(input);
            // Authorize complete scopes first and apply them before filtering or pagination.
            const stores = await tx.businessStore.findMany({ where });
            const storeIds = stores
              .filter((store) => read(store.name))
              .map((store) => store.storeId);
            const group = read(null);
            const access =
              group && storeIds.length === stores.length
                ? "all"
                : group || storeIds.length
                  ? "partial"
                  : "none";
            if (access === "none") return { employees: [], access, nextCursor: null };
            const scopes: Prisma.EmployeeWhereInput[] = [
              ...(group ? [{ storeId: null }] : []),
              ...(storeIds.length ? [{ storeId: { in: storeIds } }] : [])
            ];
            const limit = q.limit ?? 50;
            const rows = await tx.employee.findMany({
              where: {
                ...where,
                OR: scopes,
                status: q.status ?? "active",
                ...(q.search ? { name: { contains: q.search } } : {}),
                ...(q.departmentId ? { departmentId: q.departmentId } : {}),
                ...(q.storeId ? { storeId: q.storeId } : {}),
                ...(q.cursor ? { employeeUid: { gt: q.cursor } } : {})
              },
              orderBy: { employeeUid: "asc" },
              take: limit + 1
            });
            const result = rows.slice(0, limit);
            return {
              employees: await Promise.all(result.map(employeeView)),
              access,
              nextCursor: rows.length > limit ? result[result.length - 1]!.employeeUid : null
            };
          }
          if (action === "get_employee" || action === "update_employee") {
            const q =
              action === "get_employee"
                ? directoryInputSchemas.get_employee.parse(input)
                : directoryInputSchemas.update_employee.parse(input);
            if (write)
              await tx.$queryRaw`SELECT employee_uid FROM employee_directory_profiles WHERE org_id = ${actor.orgId} AND enterprise_key = ${input.enterpriseKey} AND employee_uid = ${q.employeeUid} FOR UPDATE`;
            const row = await tx.employee.findFirst({
              where: { ...where, employeeUid: q.employeeUid }
            });
            if (!row) fail("DIRECTORY_NOT_FOUND");
            const previousStore = await scopeFor(row.storeId, false);
            if (!read(previousStore?.name ?? null)) fail("DIRECTORY_NOT_FOUND");
            if (action === "get_employee") return { employee: await employeeView(row) };
            const update = directoryInputSchemas.update_employee.parse(input);
            if (version(row.version) !== update.expectedVersion) fail("DIRECTORY_CONFLICT");
            if (
              update.status === "departed" &&
              (update.departmentId !== row.departmentId || update.scope.storeId !== row.storeId)
            )
              fail("DIRECTORY_CONFLICT");
            if (update.status === "active") {
              const dept = await tx.businessDepartment.findFirst({
                where: { ...where, departmentId: update.departmentId, retired: false }
              });
              const store = await scopeFor(update.scope.storeId, true);
              if (!dept) fail("DIRECTORY_NOT_FOUND");
              if (!read(store?.name ?? null)) fail("DIRECTORY_NOT_FOUND");
            }
            const changed = await tx.employee.update({
              where: { employeeUid: row.employeeUid },
              data: {
                name: update.name,
                departmentId: update.departmentId,
                storeId: update.scope.storeId,
                status: update.status,
                version: { increment: 1 }
              }
            });
            await audit(row.employeeUid);
            return { employeeUid: row.employeeUid, version: version(changed.version) };
          }
          if (action === "create_employee") {
            const create = directoryInputSchemas.create_employee.parse(input);
            const dept = await tx.businessDepartment.findFirst({
              where: { ...where, departmentId: create.departmentId, retired: false }
            });
            await scopeFor(create.scope.storeId, true);
            if (!dept) fail("DIRECTORY_NOT_FOUND");
            const employeeUid = randomUUID();
            await tx.employee.create({
              data: {
                ...where,
                employeeUid,
                name: create.name,
                departmentId: create.departmentId,
                storeId: create.scope.storeId
              }
            });
            await audit(employeeUid);
            return { employeeUid };
          }
          if (action === "manage_department") {
            const op = directoryInputSchemas.manage_department.parse(input).operation;
            if (op.kind === "create") {
              const departmentId = randomUUID();
              await tx.businessDepartment.create({
                data: { ...where, departmentId, name: op.name }
              });
              await audit(departmentId);
              return { departmentId, version: "0" };
            }
            const row = await tx.businessDepartment.findFirst({
              where: { ...where, departmentId: op.departmentId }
            });
            if (!row) fail("DIRECTORY_NOT_FOUND");
            if (version(row.version) !== op.expectedVersion) fail("DIRECTORY_CONFLICT");
            if (
              op.kind === "retire" &&
              (await tx.employee.count({
                where: { ...where, departmentId: row.departmentId, status: "active" }
              }))
            )
              fail("DIRECTORY_IN_USE");
            const changed = await tx.businessDepartment.update({
              where: { departmentId: row.departmentId },
              data: {
                ...(op.kind === "rename" ? { name: op.name } : { retired: op.kind === "retire" }),
                version: { increment: 1 }
              }
            });
            await audit(row.departmentId);
            return { departmentId: row.departmentId, version: version(changed.version) };
          }
          const op = directoryInputSchemas.manage_store.parse(input).operation;
          if (op.kind === "create") {
            const storeId = randomUUID();
            await tx.businessStore.create({
              data: {
                ...where,
                name: op.name,
                officialName: op.name,
                storeId,
                confirmation: "confirmed"
              }
            });
            await audit(storeId);
            return { storeId, version: "0" };
          }
          const row = await tx.businessStore.findFirst({
            where: { ...where, storeId: op.storeId }
          });
          if (!row) fail("DIRECTORY_NOT_FOUND");
          if (version(row.version) !== op.expectedVersion) fail("DIRECTORY_CONFLICT");
          if (
            op.kind === "retire" &&
            (await tx.employee.count({
              where: { ...where, storeId: row.storeId, status: "active" }
            }))
          )
            fail("DIRECTORY_IN_USE");
          if ((op.kind === "restore" || op.kind === "confirm") && row.confirmation === "historical")
            fail("DIRECTORY_CONFLICT");
          if (
            op.kind === "historical" &&
            (row.confirmation !== "pending" ||
              (await tx.employee.count({
                where: { ...where, storeId: row.storeId, status: "active" }
              })))
          )
            fail("DIRECTORY_CONFLICT");
          const changed = await tx.businessStore.update({
            where: { orgId_enterpriseKey_name: { ...where, name: row.name } },
            data: {
              ...(op.kind === "rename" ? { officialName: op.name } : {}),
              ...(op.kind === "confirm" ? { confirmation: "confirmed" as const } : {}),
              ...(op.kind === "historical" ? { confirmation: "historical" as const } : {}),
              ...(op.kind === "retire" ? { retired: true } : {}),
              ...(op.kind === "restore" ? { retired: false } : {}),
              version: { increment: 1 }
            }
          });
          await audit(row.storeId);
          return { storeId: row.storeId, version: version(changed.version) };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 }
      );
    }
  };
}
function canReadProfile(
  snapshot: AuthorizationSnapshot,
  orgId: string,
  enterpriseKey: string,
  storeKey: string | null
): boolean {
  const category = snapshot.categories.find((c) => c.key === "employee_profiles");
  return (
    !!category &&
    canReadResource(snapshot, {
      orgId,
      categoryId: category.id,
      valid: true,
      scopes: [
        {
          enterpriseKey,
          ownership: storeKey === null ? "group" : "store",
          ...(storeKey === null ? {} : { storeName: storeKey }),
          dimensions: {}
        }
      ]
    }).allowed
  );
}
