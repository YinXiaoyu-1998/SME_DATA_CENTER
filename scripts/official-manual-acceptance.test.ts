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

it("inventories only the run's exact source cards/resources, including archived cards", async () => {
  const costCards = [
    { id: "card-active", objectKey: "cost-cards/active.csv" },
    { id: "card-archived", objectKey: "cost-cards/archived.csv" }
  ];
  const prisma = {
    costCard: { findMany: vi.fn(async () => costCards) },
    businessResource: { findMany: vi.fn(async () => [{ id: "resource-1" }]) }
  };
  await expect(
    collectCostCardAcceptanceCleanupTargets(prisma as unknown as PrismaClient, {
      orgId: "synthetic-org",
      sourceDocumentIds: ["run-doc"]
    })
  ).resolves.toEqual({
    costCards,
    costCardIds: ["card-active", "card-archived"],
    costCardResourceIds: ["resource-1"]
  });
  expect(prisma.costCard.findMany).toHaveBeenCalledWith({
    where: { orgId: "synthetic-org", sourceDocumentId: { in: ["run-doc"] } },
    select: { id: true, objectKey: true }
  });
  expect(prisma.businessResource.findMany).toHaveBeenCalledWith({
    where: { orgId: "synthetic-org", kind: "cost_card", sourceDocumentId: { in: ["run-doc"] } },
    select: { id: true }
  });
});
