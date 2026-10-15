import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  callJson,
  cleanupRun,
  collectCostCardAcceptanceCleanupTargets,
  runConfig
} from "./official-manual-acceptance.js";

describe("official acceptance expected MCP denial", () => {
  const query = {
    dataset: "delivery_ledger",
    filter: { field: "store_name", op: "eq", value: "Synthetic receipt store" },
    aggregates: [{ op: "count", as: "rows" }]
  };

  it("accepts the closed-ledger contract instead of requiring aggregate rows", async () => {
    const client = new Client({ name: "acceptance-test", version: "1" });
    vi.spyOn(client, "callTool").mockResolvedValue({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ error: { code: "LEDGER_DETAIL_DISABLED" } }) }
      ]
    });

    await expect(
      callJson(client, "query_structured_dataset", query, "LEDGER_DETAIL_DISABLED")
    ).resolves.toMatchObject({ isError: true, error: { code: "LEDGER_DETAIL_DISABLED" } });
  });

  it("rejects an accidentally reopened aggregate endpoint", async () => {
    const client = new Client({ name: "acceptance-test", version: "1" });
    vi.spyOn(client, "callTool").mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ rows: [{ rows: 2, amount: 42.5 }] }) }]
    });

    await expect(
      callJson(client, "query_structured_dataset", query, "LEDGER_DETAIL_DISABLED")
    ).rejects.toThrow("expected MCP error LEDGER_DETAIL_DISABLED");
  });

  it.each([
    { isError: true, code: "AUTHENTICATION_REQUIRED" },
    { isError: true, code: "FORBIDDEN" },
    { isError: false, code: "LEDGER_DETAIL_DISABLED" }
  ])("does not count an unrelated or unmarked error as the expected denial: %j", async (input) => {
    const client = new Client({ name: "acceptance-test", version: "1" });
    vi.spyOn(client, "callTool").mockResolvedValue({
      isError: input.isError,
      content: [{ type: "text", text: JSON.stringify({ error: { code: input.code } }) }]
    });

    await expect(
      callJson(client, "query_structured_dataset", query, "LEDGER_DETAIL_DISABLED")
    ).rejects.toThrow("expected MCP error LEDGER_DETAIL_DISABLED");
  });

  it("preserves transport failures and ordinary tool-error handling", async () => {
    const client = new Client({ name: "acceptance-test", version: "1" });
    const transportError = new Error("transport unavailable");
    vi.spyOn(client, "callTool")
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce({
        isError: true,
        content: [
          { type: "text", text: JSON.stringify({ error: { code: "LEDGER_DETAIL_DISABLED" } }) }
        ]
      });

    await expect(
      callJson(client, "query_structured_dataset", query, "LEDGER_DETAIL_DISABLED")
    ).rejects.toBe(transportError);
    await expect(callJson(client, "query_structured_dataset", query)).rejects.toThrow(
      "query_structured_dataset failed"
    );
  });
});

it("rejects another uploader's explicit cleanup IDs before deleting any data", async () => {
  const run = runConfig("cleanup-scope", {
    reuseSession: "qa@example.invalid",
    documentIds: ["doc_other_owner"],
    partitionJobIds: []
  });
  run.reusedEmployeeId = "emp_qa";
  const findDocuments = vi.fn();
  const prisma = {
    loginIdentity: { findMany: vi.fn().mockResolvedValue([]) },
    document: { count: vi.fn().mockResolvedValue(1), findMany: findDocuments },
    partitionImportJob: { count: vi.fn().mockResolvedValue(0) },
    ledgerArtifactRequest: { count: vi.fn().mockResolvedValue(0) }
  };
  await expect(cleanupRun(prisma as unknown as PrismaClient, run)).rejects.toThrow(
    "Cleanup IDs do not belong to the selected QA account"
  );
  expect(findDocuments).not.toHaveBeenCalled();
});

it("resolves null-source card resources by key and historical cost-card source fragments", async () => {
  const cards = [
    {
      orgId: "org",
      id: "active",
      sourceDocumentId: "current",
      archivedAt: null,
      objectKey: "active.csv"
    },
    {
      orgId: "org",
      id: "archived",
      sourceDocumentId: "current",
      archivedAt: new Date(),
      objectKey: "archived.csv"
    },
    {
      orgId: "org",
      id: "unrelated",
      sourceDocumentId: "other",
      archivedAt: null,
      objectKey: "other.csv"
    }
  ];
  const resources = (
    [
      ["card-active", "cost_card", "cost-card:active", null, "cost_cards"],
      ["card-archived", "cost_card", "cost-card:archived", null, "cost_cards"],
      ["source-current", "source_fragment", "current:cost", "current", "cost_cards"],
      ["source-historical", "source_fragment", "historical:cost", "historical", "cost_cards"],
      ["card-other", "cost_card", "cost-card:unrelated", null, "cost_cards"],
      ["source-other", "source_fragment", "other:cost", "other", "cost_cards"],
      ["other-category", "source_fragment", "historical:vip", "historical", "vip"]
    ] as const
  ).map(([id, kind, resourceKey, sourceDocumentId, key]) => ({
    orgId: "org",
    id,
    kind,
    resourceKey,
    sourceDocumentId,
    category: { key, kind: "fixed" }
  }));
  const prisma = {
    processingRun: { findMany: vi.fn().mockResolvedValue([]) },
    costCard: {
      findMany: vi.fn(
        async ({
          where
        }: {
          where: { orgId: string; sourceDocumentId: { in: string[] }; archivedAt?: Date | null };
        }) =>
          cards.filter(
            (card) =>
              card.orgId === where.orgId &&
              where.sourceDocumentId.in.includes(card.sourceDocumentId) &&
              (where.archivedAt === undefined || card.archivedAt === where.archivedAt)
          )
      )
    },
    businessResource: {
      findMany: vi.fn(
        async ({
          where
        }: {
          where: {
            orgId: string;
            kind: string;
            resourceKey?: { in: string[] };
            sourceDocumentId?: { in: (string | null)[] };
            category?: { key: string; kind: string };
          };
        }) =>
          resources.filter(
            (resource) =>
              resource.orgId === where.orgId &&
              resource.kind === where.kind &&
              (!where.resourceKey || where.resourceKey.in.includes(resource.resourceKey)) &&
              (!where.sourceDocumentId ||
                where.sourceDocumentId.in.includes(resource.sourceDocumentId)) &&
              (!where.category ||
                (resource.category.key === where.category.key &&
                  resource.category.kind === where.category.kind))
          )
      )
    }
  };
  const targets = await collectCostCardAcceptanceCleanupTargets(prisma as unknown as PrismaClient, {
    orgId: "org",
    sourceDocumentIds: ["current", "historical"]
  });
  expect(targets.costCardIds).toEqual(["active", "archived"]);
  expect(targets.costCardResourceIds).toEqual(["card-active", "card-archived"]);
  expect(targets).toHaveProperty("costCardSourceResourceIds", [
    "source-current",
    "source-historical"
  ]);
});

describe("cost-card acceptance garbage inventory", () => {
  const replaced = "cost-cards/org_a/job-historical/1/old.csv";
  const candidate = "cost-cards/org_a/job-current/2/candidate.csv";
  function fixture() {
    return {
      costCard: {
        findMany: vi.fn().mockResolvedValue([{ id: "owned-card", objectKey: "current.csv" }]),
        count: vi.fn().mockResolvedValue(0)
      },
      businessResource: { findMany: vi.fn().mockResolvedValue([]) },
      processingRun: {
        findMany: vi.fn().mockResolvedValue([{ id: "job-historical" }, { id: "job-current" }])
      },
      storageGarbage: {
        findMany: vi.fn().mockResolvedValue([
          { objectKey: replaced, processingRunId: null },
          { objectKey: candidate, processingRunId: "job-current" },
          // SQL LIKE may return this neighbor because the organization contains an underscore.
          { objectKey: "cost-cards/orgXa/job-historical/1/foreign.csv" },
          { objectKey: "cost-cards/org_a/job-current-other/1/foreign.csv" }
        ])
      }
    };
  }

  it("includes unlinked replaced CSVs while excluding neighboring organization and job keys", async () => {
    const prisma = fixture();
    const targets = await collectCostCardAcceptanceCleanupTargets(
      prisma as unknown as PrismaClient,
      {
        orgId: "org_a",
        sourceDocumentIds: ["historical", "current"]
      }
    );
    expect(targets).toHaveProperty("costCardGarbageObjectKeys", [replaced, candidate]);
    expect(prisma.processingRun.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_a", documentId: { in: ["historical", "current"] } },
      select: { id: true }
    });
  });

  it("refuses a run-owned garbage key still referenced by a card outside the cleanup scope", async () => {
    const prisma = fixture();
    prisma.costCard.count.mockResolvedValue(1);
    await expect(
      collectCostCardAcceptanceCleanupTargets(prisma as unknown as PrismaClient, {
        orgId: "org_a",
        sourceDocumentIds: ["historical", "current"]
      })
    ).rejects.toThrow("Official cleanup refuses a shared cost-card object");
  });
});
