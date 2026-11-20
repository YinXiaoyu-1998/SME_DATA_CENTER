import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  canReadResource,
  type ComboSaleMappingRow,
  type QueryComboSaleMappings,
  type UpdateComboSaleMapping
} from "@smedc/domain";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
import { resolveFormalStore } from "./formal-store-directory.js";

type Actor = { id: string; orgId: string; requestId?: string };
type Scope = { orgId: string; enterpriseKey: string; storeId: string };
type Tx = Prisma.TransactionClient;

export class ComboSaleMappingError extends Error {
  constructor(
    readonly status: 400 | 403,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
function denied(): never {
  throw new ComboSaleMappingError(
    403,
    "COMBO_SALE_MAPPING_FORBIDDEN",
    "This account cannot access mappings in the requested scope."
  );
}
function invalidTarget(): never {
  throw new ComboSaleMappingError(
    400,
    "COMBO_SALE_MAPPING_INVALID_TARGET",
    "Select a current single SKU or active department of this enterprise."
  );
}

type ConfirmTarget = Extract<UpdateComboSaleMapping["operation"], { kind: "confirm" }>["target"];
async function resolveTarget(tx: Tx, scope: Scope, target: ConfirmTarget) {
  if (target.kind === "sku") {
    const [entry] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM dish_catalog_entries WHERE org_id=${scope.orgId}
      AND enterprise_key=${scope.enterpriseKey} AND BINARY enterprise_key=BINARY ${scope.enterpriseKey}
      AND sku_id=${target.skuId} AND BINARY sku_id=BINARY ${target.skuId}
      AND (dish_type IS NULL OR dish_type='single') FOR SHARE
    `;
    if (!entry) invalidTarget();
    return { targetSkuId: target.skuId, targetEntryId: entry.id, targetDepartmentId: null };
  }
  const [department] = await tx.$queryRaw<{ id: string }[]>`
    SELECT department_id AS id FROM business_departments WHERE department_id=${target.departmentId}
    AND BINARY department_id=BINARY ${target.departmentId} AND org_id=${scope.orgId}
    AND BINARY enterprise_key=BINARY ${scope.enterpriseKey} AND retired=FALSE FOR SHARE
  `;
  if (!department) invalidTarget();
  return { targetSkuId: null, targetEntryId: null, targetDepartmentId: department.id };
}

export function createComboSaleMappingRepository(prisma: PrismaClient) {
  const authorization = createBusinessAuthorizationRepository({ prisma });

  async function authorize(
    tx: Tx,
    actor: Actor,
    input: QueryComboSaleMappings,
    write: boolean
  ): Promise<Scope> {
    const { orgId } = actor;
    if (write) {
      // Permission changes and catalog updates use this same lock. Concurrent confirms and
      // revocations observe the previous committed mapping before deciding whether to audit.
      await tx.$queryRaw`SELECT org_id FROM business_authorization_states WHERE org_id=${orgId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM employees WHERE org_id=${orgId} AND id=${actor.id} FOR SHARE`;
    }
    const snapshot = await authorization.loadAuthorizationSnapshot(actor.id, orgId, tx);
    if (snapshot.disabled || snapshot.mode !== "enabled" || (write && snapshot.role !== "admin"))
      denied();
    const [enterprise] = await tx.$queryRaw<{ enterpriseKey: string }[]>`
      SELECT enterprise_key AS enterpriseKey FROM business_enterprise_identities
      WHERE org_id=${orgId} AND BINARY enterprise_name=BINARY ${input.enterpriseName}
    `;
    if (!enterprise) denied();
    const { enterpriseKey } = enterprise;
    const store = await resolveFormalStore(tx, { orgId, enterpriseKey, name: input.storeName });
    if (!store || store.retired) denied();
    for (const key of ["combo_sales", "dish_catalog"]) {
      const rule = snapshot.categories.find((c) => c.key === key && c.kind === "fixed");
      if (
        !rule ||
        !canReadResource(snapshot, {
          orgId,
          categoryId: rule.id,
          valid: true,
          scopes: [
            {
              enterpriseKey,
              dimensions: {},
              ...(key === "combo_sales"
                ? { ownership: "store", storeName: store.storeKey }
                : { ownership: "group" })
            }
          ]
        }).allowed
      )
        denied();
    }
    return { orgId, enterpriseKey, storeId: store.storeId };
  }

  return {
    async update(actor: Actor, input: UpdateComboSaleMapping) {
      return prisma.$transaction(async (tx) => {
        const scope = await authorize(tx, actor, input, true);
        const { sourceName, specification, operation } = input;
        const id = createHash("sha256")
          .update(
            JSON.stringify([
              scope.orgId,
              scope.enterpriseKey,
              scope.storeId,
              sourceName,
              specification
            ])
          )
          .digest("hex");
        const existing = await tx.comboSaleMapping.findUnique({ where: { id } });
        let changed: boolean;
        if (operation.kind === "revoke") {
          changed = !!existing;
          if (changed) await tx.comboSaleMapping.delete({ where: { id } });
        } else {
          const fields = {
            ...(await resolveTarget(tx, scope, operation.target)),
            basis: operation.basis
          };
          changed =
            !existing ||
            existing.targetDepartmentId !== fields.targetDepartmentId ||
            existing.targetEntryId !== fields.targetEntryId ||
            existing.basis !== fields.basis;
          if (changed)
            await tx.comboSaleMapping.upsert({
              where: { id },
              create: { id, ...scope, sourceName, specification, ...fields },
              update: fields
            });
        }
        if (changed)
          await tx.auditLog.create({
            data: {
              orgId: actor.orgId,
              actorUserAccountId: actor.id,
              requestId: actor.requestId ?? null,
              action: "combo_sale_mapping." + operation.kind,
              targetType: "combo_sale_mapping",
              targetId: id
            }
          });
        return { id, changed };
      });
    },
    async query(actor: Actor, input: QueryComboSaleMappings) {
      return prisma.$transaction(
        async (tx) => {
          const { orgId, enterpriseKey, storeId } = await authorize(tx, actor, input, false);
          const limit = input.limit ?? 50;
          const mappings = await tx.$queryRaw<
            Array<{
              id: string;
              sourceName: string;
              specification: string | null;
              basis: string;
              targetSkuId: string | null;
              targetDepartmentId: string | null;
              entryId: string | null;
              departmentId: string | null;
              departmentName: string | null;
            }>
          >`
          SELECT m.id, m.source_name AS sourceName, m.specification, m.basis,
            m.target_sku_id AS targetSkuId, m.target_department_id AS targetDepartmentId,
            e.id AS entryId, d.department_id AS departmentId, d.name AS departmentName
          FROM combo_sale_mappings m
          LEFT JOIN dish_catalog_entries e ON e.id=m.target_entry_id AND e.org_id=m.org_id
            AND BINARY e.enterprise_key=BINARY m.enterprise_key AND (e.dish_type IS NULL OR e.dish_type='single')
          LEFT JOIN business_departments d ON d.department_id=COALESCE(m.target_department_id,e.department_id)
            AND d.org_id=m.org_id AND BINARY d.enterprise_key=BINARY m.enterprise_key AND d.retired=FALSE
          WHERE m.org_id=${orgId} AND m.enterprise_key=${enterpriseKey} AND m.store_id=${storeId}
          AND m.id>${input.afterId ?? ""} ORDER BY m.id LIMIT ${limit + 1}
        `;
          const rows: ComboSaleMappingRow[] = mappings.slice(0, limit).map((m) => ({
            id: m.id,
            sourceName: m.sourceName,
            specification: m.specification,
            basis: m.basis,
            target:
              m.targetSkuId !== null
                ? { kind: "sku", skuId: m.targetSkuId }
                : { kind: "department", departmentId: m.targetDepartmentId! },
            valid: m.targetSkuId !== null ? m.entryId !== null : m.departmentId !== null,
            departmentId: m.departmentId,
            departmentName: m.departmentName
          }));
          return { rows, nextAfterId: mappings.length > limit ? rows.at(-1)!.id : null };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
    }
  };
}
