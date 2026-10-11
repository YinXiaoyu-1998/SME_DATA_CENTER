import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  createBusinessAuthorizationRepository,
  lockAuthorizationPublication,
  persistResourceAttributes,
  toResourceReadRequirement
} from "@smedc/db";
import {
  canReadResource,
  type AuthorizationSnapshot,
  type ResourceReadRequirement
} from "@smedc/domain";
import type { LedgerPartitionKey, LedgerSourceRef } from "./types.js";

type Reader = Prisma.TransactionClient | PrismaClient;
export async function currentLedgerAuthorization(
  reader: Reader,
  employeeId: string,
  orgId: string
) {
  const repository = createBusinessAuthorizationRepository({ prisma: reader as PrismaClient });
  return "$transaction" in reader
    ? repository.loadAuthorizationSnapshot(employeeId, orgId)
    : repository.loadAuthorizationSnapshot(employeeId, orgId, reader);
}
/** The registered conversion preserves the exact store; additional required dimensions fail closed. */
export async function ledgerPdfReadRequirement(
  reader: Reader,
  key: LedgerPartitionKey,
  sources: LedgerSourceRef[],
  partitionId?: string
): Promise<ResourceReadRequirement | null> {
  if (partitionId) {
    const resource = await reader.businessResource.findUnique({
      where: {
        orgId_kind_resourceKey: { orgId: key.orgId, kind: "ledger_pdf", resourceKey: partitionId }
      },
      include: { scopes: { include: { dimensions: true } } }
    });
    if (resource) {
      const requirement = toResourceReadRequirement(resource);
      return requirement.scopes.length === 1 && requirement.scopes[0]!.storeName === key.storeName
        ? requirement
        : null;
    }
  }
  const category = await reader.businessCategory.findUnique({
    where: { orgId_key: { orgId: key.orgId, key: "ledger_pdf" } },
    include: { dimensions: true }
  });
  if (!category || category.dimensions.length || !category.allowStore) return null;
  const ledgerIds = sources
    .filter((source) => source.kind === "ledger")
    .map((source) => source.sourceDocumentId);
  if (!ledgerIds.length) return null;
  const fragments = await reader.businessResource.findMany({
    where: {
      orgId: key.orgId,
      kind: "source_fragment",
      valid: true,
      sourceDocumentId: { in: ledgerIds },
      category: { key: "delivery_ledger" }
    },
    include: { scopes: { include: { dimensions: true } } }
  });
  const scopes = fragments.flatMap((resource) => toResourceReadRequirement(resource).scopes);
  if (
    new Set(fragments.map((resource) => resource.sourceDocumentId)).size !==
      new Set(ledgerIds).size ||
    !scopes.length ||
    scopes.some((scope) => scope.ownership !== "store" || scope.storeName !== key.storeName)
  )
    return null;
  const enterpriseKeys = new Set(scopes.map((scope) => scope.enterpriseKey));
  if (enterpriseKeys.size !== 1) return null;
  return {
    orgId: key.orgId,
    categoryId: category.id,
    valid: true,
    scopes: [
      {
        enterpriseKey: scopes[0]!.enterpriseKey,
        ownership: "store",
        storeName: key.storeName,
        dimensions: {}
      }
    ]
  };
}
export async function canReadLedgerPdf(
  reader: Reader,
  snapshot: AuthorizationSnapshot,
  key: LedgerPartitionKey,
  sources: LedgerSourceRef[],
  partitionId?: string,
  legacyLevel = Math.max(0, ...sources.map((source) => source.confidentialityLevel))
): Promise<boolean> {
  if (snapshot.disabled || snapshot.orgId !== key.orgId) return false;
  if (snapshot.mode === "legacy" || snapshot.mode === "preparing")
    return (
      snapshot.clearance >=
      Math.max(legacyLevel, ...sources.map((source) => source.confidentialityLevel))
    );
  const requirement = await ledgerPdfReadRequirement(reader, key, sources, partitionId);
  return !!requirement && canReadResource(snapshot, requirement).allowed;
}
export async function persistLedgerPdfRequirement(
  tx: Prisma.TransactionClient,
  key: LedgerPartitionKey,
  partitionId: string,
  sources: LedgerSourceRef[],
  valid = true
): Promise<number | null> {
  const state = await lockAuthorizationPublication(tx, key.orgId);
  if (state.mode === "suspended") throw new Error("AUTHORIZATION_SUSPENDED");
  if (!valid) {
    await tx.businessResource.updateMany({
      where: { orgId: key.orgId, kind: "ledger_pdf", resourceKey: partitionId, valid: true },
      data: {
        valid: false,
        authorizationVersion: { increment: 1 },
        contentVersion: { increment: 1 }
      }
    });
    return null;
  }
  // Regeneration uses the registered source-to-product conversion, never the caller's grants.
  const requirement = await ledgerPdfReadRequirement(tx, key, sources);
  if (!requirement) {
    if (state.mode === "enabled") throw new Error("RESOURCE_ATTRIBUTES_NOT_READY");
    return null;
  }
  const existing = await tx.businessResource.findUnique({
    where: {
      orgId_kind_resourceKey: { orgId: key.orgId, kind: "ledger_pdf", resourceKey: partitionId }
    }
  });
  await persistResourceAttributes(tx, {
    ...requirement,
    id: existing?.id ?? randomUUID().replaceAll("-", ""),
    kind: "ledger_pdf",
    resourceKey: partitionId
  });
  const category = await tx.businessCategory.findUniqueOrThrow({
    where: { orgId_id: { orgId: key.orgId, id: requirement.categoryId } }
  });
  return category.confidentialityLevel;
}
