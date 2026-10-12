import type { Prisma } from "@prisma/client";
import {
  FIXED_BUSINESS_CATEGORY_KEYS,
  isBusinessClearance,
  validateBusinessGrant,
  validateBusinessScope,
  type BusinessCategoryRule,
  type BusinessGrant,
  type ResourceReadRequirement
} from "@smedc/domain";
import { toResourceReadRequirement, toBusinessCategoryRule, loadBusinessGrants } from "@smedc/db";
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
  // Build indexes once: real tenants have many more partitions than categories.
  const categories = new Map(inventory.categories.map((category) => [category.id, category]));
  const dimensions = new Map(
    inventory.dimensions.map((dimension) => [dimension.id, new Set(dimension.valueIds)])
  );
  const stores = new Set(
    inventory.stores.map((store) => JSON.stringify([store.enterpriseKey, store.name]))
  );
  const sourceFragments = new Map<string, CutoverInventory["resources"]>();
  const documentResources = new Map<string, CutoverInventory["resources"]>();
  const partitions = new Set<string>();
  const pdfs = new Set<string>();
  for (const resource of inventory.resources) {
    if (resource.kind === "source_fragment" && resource.sourceDocumentId !== null) {
      const matches = sourceFragments.get(resource.sourceDocumentId) ?? [];
      matches.push(resource);
      sourceFragments.set(resource.sourceDocumentId, matches);
    }
    if (resource.documentId !== null) {
      const key = JSON.stringify([resource.kind, resource.documentId]);
      const matches = documentResources.get(key) ?? [];
      matches.push(resource);
      documentResources.set(key, matches);
    }
    if (resource.kind === "structured") partitions.add(resource.resourceKey);
    if (resource.kind === "ledger_pdf") pdfs.add(resource.resourceKey);
  }
  const missing: CutoverIssue[] = [];
  const add = (code: string, targetId: string) => missing.push({ code, targetId });
  for (const adapter of AUTHORIZATION_READ_ADAPTERS)
    if (!adapters.includes(adapter)) add("READ_ADAPTER_NOT_READY", adapter);
  for (const key of FIXED_BUSINESS_CATEGORY_KEYS) {
    const rule = inventory.categories.find((c) => c.kind === "fixed" && c.key === key);
    if (key === "delivery_ledger") {
      if (!rule) add("INTERNAL_CATEGORY_REQUIRED", key);
      continue;
    }
    if (!rule || !isBusinessClearance(rule.confidentialityLevel))
      add("FIXED_CATEGORY_CLEARANCE_REQUIRED", key);
  }
  for (const category of inventory.categories)
    for (const dimension of category.requiredDimensionIds)
      if (!dimensions.has(dimension)) add("DIMENSION_NOT_READY", category.id);
  for (const resource of inventory.resources) {
    const requirement = resource.requirement;
    const category = categories.get(requirement.categoryId);
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
        !stores.has(JSON.stringify([scope.enterpriseKey, scope.storeName]))
      )
        add("EXACT_STORE_REFERENCE_REQUIRED", resource.id);
      for (const [id, value] of Object.entries(scope.dimensions))
        if (!dimensions.get(id)?.has(value)) add("DIMENSION_VALUE_REQUIRED", resource.id);
    }
  }
  for (const document of inventory.documents) {
    const matches =
      (document.kind === "structured"
        ? sourceFragments.get(document.id)
        : documentResources.get(JSON.stringify([document.kind, document.id]))) ?? [];
    if (
      !matches.length ||
      (document.kind === "structured" &&
        matches.some((r) => categories.get(r.requirement.categoryId)?.key !== document.dataset))
    )
      add(
        document.kind === "structured" ? "SOURCE_LINEAGE_REQUIRED" : "DOCUMENT_ATTRIBUTES_REQUIRED",
        document.id
      );
  }
  for (const id of inventory.partitions)
    if (!partitions.has(`partition:${id}`)) add("PARTITION_ATTRIBUTES_REQUIRED", id);
  for (const id of inventory.pdfs) if (!pdfs.has(id)) add("PDF_ATTRIBUTES_REQUIRED", id);
  for (const account of inventory.accounts)
    for (const grant of account.grants) {
      if (validateBusinessGrant(grant, inventory.categories).length)
        add("GRANT_CONFIGURATION_REQUIRED", `${account.id}/${grant.id}`);
      if (
        grant.stores?.kind === "fixed" &&
        grant.stores.values.some((name) => !stores.has(JSON.stringify([grant.enterpriseKey, name])))
      )
        add("EXACT_STORE_REFERENCE_REQUIRED", `${account.id}/${grant.id}`);
      for (const [id, selection] of Object.entries(grant.dimensions))
        if (!(
          dimensions.has(id) &&
          (selection.kind === "all" || selection.values.every((v) => dimensions.get(id)!.has(v)))
        ))
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
    const grants = await loadBusinessGrants(tx, orgId);
    return inspectCutoverInventory(
      {
        categories: categoryRows.map(toBusinessCategoryRule),
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
        accounts: accounts.map((a) => ({ id: a.id, grants: grants.get(a.id) ?? [] })),
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
