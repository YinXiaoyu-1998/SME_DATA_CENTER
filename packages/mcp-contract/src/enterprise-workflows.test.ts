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
                  artifactHash: "a".repeat(64),
                  correlationMarker: actionId,
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
          artifactHash: "a".repeat(64),
          correlationMarker: "action-1",
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

it("rejects external actions without immutable recovery metadata before checking permission", () => {
  const schema = tool("record_workflow_action").inputSchema;
  const intent = {
    workflowId: "workflow-1",
    operation: {
      kind: "intent",
      installationId: "mac",
      runId: "run",
      assignmentEpoch: 1,
      controlVersion: 1,
      actions: [
        {
          actionId: "mail",
          identity: {
            kind: "email",
            purpose: "weekly_report",
            storeNames: ["Store A"],
            window: { startDate: "2026-10-26", endDate: "2026-11-01" },
            recipients: ["recipient@example.invalid"],
            sender: "sender@example.invalid",
            deliveryVersion: 1
          }
        }
      ]
    }
  };
  expect(schema.safeParse(intent).success).toBe(false);
  expect(
    schema.safeParse({
      ...intent,
      operation: {
        ...intent.operation,
        actions: [{ ...intent.operation.actions[0], artifactHash: "a".repeat(64) }]
      }
    }).success
  ).toBe(false);
  expect(
    schema.safeParse({
      ...intent,
      operation: {
        ...intent.operation,
        actions: [
          {
            ...intent.operation.actions[0],
            artifactHash: "a".repeat(64),
            correlationMarker: "mail"
          }
        ]
      }
    }).success
  ).toBe(true);
});

it("carries bounded typed recovery metadata without turning waived work into an action claim", () => {
  const schema = tool("manage_workflow_installation").inputSchema;
  const recoveryItem = {
    itemId: "missing-pdf",
    kind: "business",
    disposition: "open",
    stage: "delivering",
    scope: {
      kind: "dataset",
      dataset: "delivery_ledger",
      storeNames: ["Store A"],
      window: { startDate: "2026-10-31", endDate: "2026-10-31" }
    },
    evidenceRef: "old-job",
    evidenceHash: "b".repeat(64)
  };
  const operation = {
    kind: "migration_append",
    migrationId: "migration",
    expectedVersion: 1,
    sequence: 1,
    chunk: [
      {
        workflowId: "workflow",
        completedActions: [],
        unresolved: [],
        recoveryItems: [recoveryItem]
      }
    ],
    chunkHash: "a".repeat(64)
  };
  expect(schema.safeParse({ workflowId: "workflow", operation }).success).toBe(true);
  const withItems = (items: unknown[]) => ({
    workflowId: "workflow",
    operation: { ...operation, chunk: [{ ...operation.chunk[0], recoveryItems: items }] }
  });
  expect(schema.safeParse(withItems([{ ...recoveryItem, disposition: "waived" }])).success).toBe(
    false
  );
  expect(
    schema.safeParse(
      withItems([
        {
          ...recoveryItem,
          disposition: "waived",
          resolutionReason: "Explicitly declined historical backfill"
        }
      ])
    ).success
  ).toBe(true);
  expect(
    schema.safeParse(withItems([{ ...recoveryItem, localPath: "/private/file" }])).success
  ).toBe(false);
  expect(
    schema.safeParse(
      withItems(Array.from({ length: 101 }, (_, i) => ({ ...recoveryItem, itemId: `item-${i}` })))
    ).success
  ).toBe(false);
});

it("registers a DSH installation without accepting a mismatched host snapshot", () => {
  const schema = tool("manage_workflow_installation").inputSchema;
  const hostSnapshot = {
    host: "dsh",
    platform: "macos",
    taskId: "schedule-test",
    projectRef: "session-test",
    cron: "DTSTART;TZID=Asia/Shanghai:20261203T090000\nRRULE:FREQ=DAILY",
    timezone: "Asia/Shanghai",
    model: "deepseek-flash",
    reasoningEffort: "high",
    state: "paused",
    verifiedAt: "2026-11-13T13:00:00Z"
  };
  const installation = {
    installationId: "installation-test",
    deviceAlias: "synthetic",
    host: "dsh",
    platform: "macos",
    launcherVersion: "0.20.1",
    workflowPackageVersion: "1.0.7",
    hostSnapshot
  };
  const input = {
    workflowId: "workflow-test",
    operation: { kind: "register", installation }
  };
  expect(schema.safeParse(input).success).toBe(true);
  expect(
    schema.safeParse({
      ...input,
      operation: { ...input.operation, installation: { ...installation, host: "codex" } }
    }).success
  ).toBe(false);
});

it("accepts an SMTP receipt only with matching acceptance evidence", () => {
  const schema = tool("record_workflow_action").inputSchema;
  const messageId = "<smedc-test@example.test>";
  const receipt = {
    actionId: "action-test",
    state: "confirmed",
    evidence: "smtp_accepted",
    receiptId: messageId,
    verifiedAt: "2026-11-13T13:00:00Z",
    smtpAcceptance: {
      identityHash: "a".repeat(64),
      artifactHash: "b".repeat(64),
      correlationMarker: "marker",
      messageId,
      responseCode: 250
    }
  };
  const operation = {
    kind: "record_receipts",
    installationId: "installation-test",
    runId: "run-test",
    assignmentEpoch: 1,
    controlVersion: 1
  };
  const parse = (value: unknown) =>
    schema.safeParse({
      workflowId: "workflow-test",
      operation: { ...operation, receipts: [value] }
    }).success;
  expect(parse(receipt)).toBe(true);
  expect(parse({ ...receipt, smtpAcceptance: undefined })).toBe(false);
  expect(parse({ ...receipt, state: "unknown" })).toBe(false);
  expect(parse({ ...receipt, receiptId: "different-message" })).toBe(false);
});
