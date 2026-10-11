import type { Prisma, PrismaClient } from "@prisma/client";
import { canReadLedgerPdf, currentLedgerAuthorization } from "./pdf-authorization.js";
import type { AuthorizationSnapshot } from "@smedc/domain";
import type { LedgerPartitionKey, LedgerSourceRef } from "./types.js";

export type LedgerArtifactAccessInput = {
  employee: { id: string; orgId: string; clearance: number; disabled: boolean };
  orgId: string;
  sources: LedgerSourceRef[];
  key: LedgerPartitionKey;
  partitionId?: string;
  authorization?: AuthorizationSnapshot;
  confidentialityLevel?: number;
};
export type LedgerSourcesCurrentInput = {
  orgId: string;
  sources: LedgerSourceRef[];
  tx?: Pick<Prisma.TransactionClient, "document">;
};

/** Roles grant submission privileges only; derived content requires every current dependency. */
export function createPrismaLedgerArtifactAccess({
  prisma
}: {
  prisma: Pick<Prisma.TransactionClient, "employee" | "document"> | PrismaClient;
}) {
  async function currentSources(input: LedgerSourcesCurrentInput): Promise<boolean> {
    const documents = await (input.tx ?? prisma).document.findMany({
      where: {
        orgId: input.orgId,
        id: { in: input.sources.map((source) => source.sourceDocumentId) }
      },
      include: {
        importBatch: true,
        quarantineCertificate: true,
        businessResources: { where: { kind: "quarantine_certificate" } }
      }
    });
    const byId = new Map(documents.map((document) => [document.id, document]));
    return input.sources.every((source) => {
      const document = byId.get(source.sourceDocumentId);
      if (
        !document ||
        document.status !== "active" ||
        document.archivedAt !== null ||
        document.checksumSha256 !== source.checksumSha256 ||
        (source.contentVersion !== undefined &&
          document.contentVersion !== source.contentVersion) ||
        (source.businessContentVersion !== undefined &&
          String(document.businessResources[0]?.contentVersion ?? 1) !==
            source.businessContentVersion)
      )
        return false;
      if (source.kind === "certificate")
        return (
          document.documentKind === "quarantine_certificate" &&
          document.quarantineCertificate?.orgId === input.orgId &&
          document.businessResources.every((resource) => resource.valid)
        );
      const batch = document.importBatch;
      return (
        document.documentKind === "structured" &&
        batch?.orgId === input.orgId &&
        batch.status === "applied" &&
        batch.archivedAt === null &&
        batch.dataset === (source.kind === "ledger" ? "delivery_ledger" : "supplier_catalog")
      );
    });
  }
  return {
    /** Worker publication passes its CAS transaction; no employee identity is required. */
    sourcesAreCurrent(input: LedgerSourcesCurrentInput): Promise<boolean> {
      return currentSources(input);
    },
    async canReadLedgerArtifact(input: LedgerArtifactAccessInput): Promise<boolean> {
      if (input.employee.disabled || input.employee.orgId !== input.orgId || !input.sources.length)
        return false;
      const employee = await prisma.employee.findFirst({
        where: { id: input.employee.id, orgId: input.orgId }
      });
      if (!employee || employee.disabled) return false;
      if (!input.key || input.key.orgId !== input.orgId) return false;
      const snapshot =
        input.authorization ??
        (await currentLedgerAuthorization(prisma as PrismaClient, employee.id, input.orgId));
      if (
        !(await canReadLedgerPdf(
          prisma as PrismaClient,
          snapshot,
          input.key,
          input.sources,
          input.partitionId,
          input.confidentialityLevel
        ))
      )
        return false;
      return currentSources(input);
    }
  };
}
