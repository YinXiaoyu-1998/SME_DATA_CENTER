import { expect, it } from "vitest";
import { SMEDC_MCP_TOOL_CONTRACTS } from "./index.js";
const tool = (name: string) => SMEDC_MCP_TOOL_CONTRACTS.find((t) => t.name === name)!;
it("offers closed workflow coordination operations without organization or command overrides", () => {
  const schema = tool("manage_workflow_run").inputSchema;
  const valid = {
    workflowId: "workflow-1",
    operation: {
      kind: "renew",
      installationId: "installation-1",
      runId: "run-1",
      assignmentEpoch: 1,
      controlVersion: 1
    }
  };
  expect(schema.parse(valid)).toEqual(valid);
  expect(schema.safeParse({ ...valid, orgId: "another-org" }).success).toBe(false);
  expect(
    schema.safeParse({ ...valid, operation: { kind: "execute", command: "anything" } }).success
  ).toBe(false);
  expect(
    schema.safeParse({
      ...valid,
      operation: { ...valid.operation, payload: { command: "anything" } }
    }).success
  ).toBe(false);
  expect(
    tool("save_enterprise_workflow").inputSchema.safeParse({
      enterpriseKey: "enterprise",
      expectedVersion: 1
    }).success
  ).toBe(false);
});
it("accepts declared in-store scope only and rejects historical unknown as a new claim", () => {
  const schema = tool("upload_structured_dataset").inputSchema;
  const upload = {
    file: {
      name: "orders.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      encoding: "base64",
      contentBase64: "eA=="
    },
    dataset: "in_store_orders",
    enterpriseName: "Synthetic",
    startDate: "20261101",
    endDate: "20261101",
    idempotencyKey: "source-1",
    orderScope: "settled_only"
  };
  expect(schema.parse(upload)).toEqual(upload);
  expect(schema.safeParse({ ...upload, orderScope: "all_statuses" }).success).toBe(true);
  expect(schema.safeParse({ ...upload, orderScope: "legacy_unknown" }).success).toBe(false);
  expect(schema.safeParse({ ...upload, dataset: "business" }).success).toBe(false);
});

it("does not import a failed or unresolved receipt as a completed migration action", () => {
  const schema = tool("manage_workflow_installation").inputSchema;
  const actionId = "old-action-1";
  const migration = {
    workflowId: "workflow-1",
    operation: {
      kind: "migration_preview",
      manifest: {
        sourceSnapshotHash: "a".repeat(64),
        targetVersion: 1,
        integration: {
          schemaVersion: 1,
          timezone: "Asia/Shanghai",
          sourceAccounts: [],
          storeMappings: [],
          exclusions: []
        },
        workflows: [
          {
            workflowId: "workflow-1",
            configuration: {
              schemaVersion: 1,
              type: "weekly-business-report",
              storeNames: ["甲店"],
              notificationPolicy: "action_required",
              groups: [],
              delivery: { enabled: false, recipients: [] },
              cleanupPolicy: "retain_final_report"
            },
            authorizations: [],
            hostSnapshot: {
              host: "codex",
              platform: "macos",
              taskId: "old-task",
              projectRef: "old-project",
              cron: "30 5 * * 1",
              timezone: "Asia/Shanghai",
              model: "configured-model",
              reasoningEffort: "high",
              state: "paused",
              verifiedAt: "2026-11-02T00:00:00Z"
            },
            completedActions: [
              {
                legacyKeyHash: "b".repeat(64),
                intent: {
                  actionId,
                  identity: {
                    kind: "email",
                    purpose: "weekly_report",
                    storeNames: ["甲店"],
                    window: { startDate: "2026-10-26", endDate: "2026-11-01" },
                    recipients: ["report@example.com"],
                    sender: "sender@example.com",
                    deliveryVersion: 1
                  }
                },
                receipt: {
                  actionId,
                  state: "unknown",
                  evidence: "transport_unknown",
                  verifiedAt: "2026-11-02T00:00:00Z"
                }
              }
            ],
            unresolved: []
          }
        ]
      }
    }
  };
  expect(schema.safeParse(migration).success).toBe(false);
  const receipt = migration.operation.manifest.workflows[0]!.completedActions[0]!.receipt;
  Object.assign(receipt, {
    state: "confirmed",
    evidence: "provider_readback",
    receiptId: "gmail-message-1"
  });
  expect(schema.safeParse(migration).success).toBe(true);
});

it("refuses an ERP source identity for a public review reply", () => {
  const schema = tool("record_workflow_action").inputSchema;
  const intent = {
    workflowId: "workflow-1",
    operation: {
      kind: "intent",
      installationId: "installation-1",
      runId: "run-1",
      assignmentEpoch: 1,
      controlVersion: 1,
      actions: [
        {
          actionId: "action-1",
          identity: {
            kind: "review_publish",
            storeName: "甲店",
            source: {
              product: "meituan_erp",
              channel: "erp",
              accountRef: "account-1",
              sourceStoreId: "1",
              sourceStoreName: "甲店"
            },
            feedbackId: "feedback-1",
            purpose: "customer_reply"
          }
        }
      ]
    }
  };
  expect(schema.safeParse(intent).success).toBe(false);
  Object.assign(intent.operation.actions[0]!.identity.source, {
    product: "meituan_reviews",
    channel: "meituan"
  });
  expect(schema.safeParse(intent).success).toBe(true);
});
