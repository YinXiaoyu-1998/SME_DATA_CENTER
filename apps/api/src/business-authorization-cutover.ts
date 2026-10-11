import type { Prisma } from "@prisma/client";
import {
  isBusinessClearance,
  validateBusinessGrant,
  validateBusinessScope,
  type BusinessCategoryRule,
  type BusinessGrant,
  type ResourceReadRequirement
} from "@smedc/domain";
import { toResourceReadRequirement } from "@smedc/db";
import type { BusinessAuthorizationRepository } from "./business-authorization.js";

// Server-owned release registration. A deployed binary must support the complete set to activate.
export const AUTHORIZATION_READ_ADAPTERS = [
  "structured_query",
  "structured_coverage",
  "partition_catalog",
  "partition_download",
  "source_download",
  "evidence_search",
  "evidence_status",
  "quarantine_certificate",
  "ledger_pdf",
  "ledger_download",
  "document_lifecycle"
] as const;
const FIXED_CATEGORIES = [
  "business",
  "dishes",
  "vip",
  "dish_catalog",
  "supplier_catalog",
  "delivery_ledger",
  "quarantine_certificate",
  "ledger_pdf"
] as const;
export interface CutoverIssue {
  code: string;
  targetId: string;
}
export interface CutoverInventory {
  categories: BusinessCategoryRule[];
  resources: Array<{
    id: string;
    kind: string;
    resourceKey: string;
    documentId: string | null;
    sourceDocumentId: string | null;
    requirement: ResourceReadRequirement;
  }>;
  documents: Array<{ id: string; kind: string | null; dataset: string | null }>;
  partitions: string[];
  pdfs: string[];
  accounts: Array<{ id: string; grants: BusinessGrant[] }>;
  stores: Array<{ enterpriseKey: string; name: string }>;
  dimensions: Array<{ id: string; valueIds: string[] }>;
}
export function inspectCutoverInventory(inventory: CutoverInventory, adapters: readonly string[]) {
  const missing: CutoverIssue[] = [];
  const add = (code: string, targetId: string) => missing.push({ code, targetId });
  for (const adapter of AUTHORIZATION_READ_ADAPTERS)
    if (!adapters.includes(adapter)) add("READ_ADAPTER_NOT_READY", adapter);
  for (const key of FIXED_CATEGORIES) {
    const rule = inventory.categories.find((c) => c.kind === "fixed" && c.key === key);
    if (!rule || !isBusinessClearance(rule.confidentialityLevel))
      add("FIXED_CATEGORY_CLEARANCE_REQUIRED", key);
  }
  for (const category of inventory.categories)
    for (const dimension of category.requiredDimensionIds)
      if (!inventory.dimensions.some((d) => d.id === dimension))
        add("DIMENSION_NOT_READY", category.id);
  for (const resource of inventory.resources) {
    const requirement = resource.requirement;
    const category = inventory.categories.find((c) => c.id === requirement.categoryId);
    if (
      !category ||
      !requirement.scopes.length ||
      requirement.scopes.some((scope) => !validateBusinessScope(scope, category)) ||
      (category.kind === "evidence" && !isBusinessClearance(requirement.fileConfidentialityLevel))
    )
      add("RESOURCE_ATTRIBUTES_REQUIRED", resource.id);
    if (
      (resource.kind === "evidence" && category?.kind !== "evidence") ||
      (["quarantine_certificate", "ledger_pdf"].includes(resource.kind) &&
        category?.key !== resource.kind) ||
      (["structured", "source_fragment"].includes(resource.kind) && category?.kind !== "fixed")
    )
      add("RESOURCE_CATEGORY_MISMATCH", resource.id);
    if (
      ["quarantine_certificate", "ledger_pdf"].includes(resource.kind) &&
      (requirement.scopes.length !== 1 || requirement.scopes[0]?.ownership !== "store")
    )
      add("SINGLE_STORE_REQUIRED", resource.id);
    for (const scope of requirement.scopes) {
      if (
        scope.ownership === "store" &&
        !inventory.stores.some(
          (store) => store.enterpriseKey === scope.enterpriseKey && store.name === scope.storeName
        )
      )
        add("EXACT_STORE_REFERENCE_REQUIRED", resource.id);
      for (const [id, value] of Object.entries(scope.dimensions))
        if (!inventory.dimensions.some((d) => d.id === id && d.valueIds.includes(value)))
          add("DIMENSION_VALUE_REQUIRED", resource.id);
    }
  }
  for (const document of inventory.documents) {
    const matches = inventory.resources.filter((r) =>
      document.kind === "structured"
        ? r.kind === "source_fragment" && r.sourceDocumentId === document.id
        : r.documentId === document.id && r.kind === document.kind
    );
    if (
      !matches.length ||
      (document.kind === "structured" &&
        matches.some(
          (r) =>
            inventory.categories.find((c) => c.id === r.requirement.categoryId)?.key !==
            document.dataset
        ))
    )
      add(
        document.kind === "structured" ? "SOURCE_LINEAGE_REQUIRED" : "DOCUMENT_ATTRIBUTES_REQUIRED",
        document.id
      );
  }
  for (const id of inventory.partitions)
    if (
      !inventory.resources.some(
        (r) => r.kind === "structured" && r.resourceKey === `partition:${id}`
      )
    )
      add("PARTITION_ATTRIBUTES_REQUIRED", id);
  for (const id of inventory.pdfs)
    if (!inventory.resources.some((r) => r.kind === "ledger_pdf" && r.resourceKey === id))
      add("PDF_ATTRIBUTES_REQUIRED", id);
  for (const account of inventory.accounts)
    for (const grant of account.grants) {
      if (validateBusinessGrant(grant, inventory.categories).length)
        add("GRANT_CONFIGURATION_REQUIRED", `${account.id}/${grant.id}`);
      if (
        grant.stores?.kind === "fixed" &&
        grant.stores.values.some(
          (name) =>
            !inventory.stores.some(
              (s) => s.enterpriseKey === grant.enterpriseKey && s.name === name
            )
        )
      )
        add("EXACT_STORE_REFERENCE_REQUIRED", `${account.id}/${grant.id}`);
      for (const [id, selection] of Object.entries(grant.dimensions))
        if (
          !inventory.dimensions.some(
            (d) =>
              d.id === id &&
              (selection.kind === "all" || selection.values.every((v) => d.valueIds.includes(v)))
          )
        )
          add("GRANT_DIMENSION_REQUIRED", `${account.id}/${grant.id}`);
    }
  return {
    ready: missing.length === 0,
    missing,
    accountsWithoutGrants: inventory.accounts.filter((a) => !a.grants.length).map((a) => a.id)
  };
}
export function createAuthorizationCutoverService(
  repository: BusinessAuthorizationRepository,
  adapters: readonly string[] = AUTHORIZATION_READ_ADAPTERS
) {
  async function inspect(orgId: string, tx: Prisma.TransactionClient) {
    const categoryRows = await tx.businessCategory.findMany({
      where: { orgId },
      include: { dimensions: true }
    });
    const resources = await tx.businessResource.findMany({
      where: { orgId },
      include: { scopes: { include: { dimensions: true } } }
    });
    const documents = await tx.document.findMany({
      where: { orgId, archivedAt: null, status: { notIn: ["archived", "uploading"] } },
      include: { importBatch: { select: { dataset: true } } }
    });
    const accounts = await tx.employee.findMany({ where: { orgId }, select: { id: true } });
    const dimensions = await tx.businessDimension.findMany({
      where: { orgId },
      include: { values: true }
    });
    return inspectCutoverInventory(
      {
        categories: categoryRows.map((c) => ({
          id: c.id,
          ...(c.key ? { key: c.key } : {}),
          kind: c.kind,
          confidentialityLevel: c.confidentialityLevel,
          ownerships: [
            ...(c.allowGroup ? ["group" as const] : []),
            ...(c.allowStore ? ["store" as const] : [])
          ],
          requiredDimensionIds: c.dimensions.map((d) => d.dimensionId)
        })),
        resources: resources.map((r) => ({ ...r, requirement: toResourceReadRequirement(r) })),
        documents: documents.map((d) => ({
          id: d.id,
          kind: d.documentKind,
          dataset: d.importBatch?.dataset ?? null
        })),
        partitions: (
          await tx.structuredPartition.findMany({ where: { orgId }, select: { id: true } })
        ).map((p) => p.id),
        pdfs: (
          await tx.ledgerPdfPartition.findMany({
            where: { orgId, currentObjectKey: { not: null } },
            select: { id: true }
          })
        ).map((p) => p.id),
        accounts: await Promise.all(
          accounts.map(async (a) => ({
            id: a.id,
            grants: (await repository.loadAuthorizationSnapshot(a.id, orgId, tx)).grants
          }))
        ),
        stores: await tx.businessStore.findMany({
          where: { orgId },
          select: { enterpriseKey: true, name: true }
        }),
        dimensions: dimensions.map((d) => ({ id: d.id, valueIds: d.values.map((v) => v.id) }))
      },
      adapters
    );
  }
  return {
    async prepareAuthorizationCutover(orgId: string) {
      const report = await repository.inspectAuthorizationCutover(orgId, (tx) =>
        inspect(orgId, tx)
      );
      return {
        authorizationVersion: report.authorizationVersion,
        mode: report.mode,
        ...report.inspection
      };
    },
    activateAuthorizationCutover(
      actor: { orgId: string; employeeId: string },
      expectedVersion: string,
      confirm: true
    ) {
      return repository.activateAuthorizationCutover(
        { orgId: actor.orgId, actorId: actor.employeeId, expectedVersion, confirm },
        (tx) => inspect(actor.orgId, tx)
      );
    }
  };
}
