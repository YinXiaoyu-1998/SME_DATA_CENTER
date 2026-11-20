import { describe, expect, it } from "vitest";
import {
  enterpriseIntegrationSchema,
  workflowConfigurationSchema,
  workflowAuthorizationScopeSchema,
  workflowActionIdentitySchema
} from "./index.js";

const source = {
  product: "meituan_reviews",
  channel: "meituan",
  accountRef: "account-1",
  sourceStoreId: "poi-1",
  sourceStoreName: "来源店"
};
describe("enterprise workflow configuration boundary", () => {
  it("retains distinct source identities for one exact store and refuses ambiguous mappings", () => {
    const config = {
      schemaVersion: 1,
      timezone: "Asia/Shanghai",
      sourceAccounts: [
        {
          product: "meituan_reviews",
          accountRef: "account-1",
          displayName: "来源账号",
          sourceEnterpriseName: "来源品牌"
        }
      ],
      storeMappings: [
        { source, storeName: "标准店" },
        { source: { ...source, sourceStoreId: "poi-2" }, storeName: "标准店" }
      ],
      exclusions: []
    };
    expect(enterpriseIntegrationSchema.parse(config).storeMappings).toHaveLength(2);
    expect(
      enterpriseIntegrationSchema.safeParse({
        ...config,
        storeMappings: [...config.storeMappings, { source, storeName: "另一店" }]
      }).success
    ).toBe(false);
    expect(enterpriseIntegrationSchema.safeParse({ ...config, script: "run()" }).success).toBe(
      false
    );
  });
});

it("keeps collection, explicit publication, and email scopes separate with bounded business text", () => {
  const config = {
    schemaVersion: 1,
    type: "meituan-review-operations",
    executionPolicy: { id: "verified-review-operations", version: 1 },
    ignoredReviewIdentities: [],
    storeNames: ["甲店", "乙店"],
    channels: ["meituan", "dianping"],
    publication: { enabled: false, storeNames: [] },
    brandFacts: "品牌事实",
    tone: "友好",
    draftNotification: { enabled: false, recipients: [] },
    cleanupPolicy: "complete_run_only",
    notificationPolicy: "action_required"
  };
  expect(workflowConfigurationSchema.parse(config)).toEqual(config);
  expect(
    workflowConfigurationSchema.safeParse({
      ...config,
      publication: { enabled: true, storeNames: ["丙店"] }
    }).success
  ).toBe(false);
  expect(
    workflowConfigurationSchema.safeParse({ ...config, brandFacts: "字".repeat(20001) }).success
  ).toBe(false);
  expect(
    workflowConfigurationSchema.safeParse({
      ...config,
      draftNotification: {
        enabled: true,
        recipients: Array.from({ length: 21 }, (_, i) => `person${i}@example.com`),
        allowedSender: "sender@example.com"
      }
    }).success
  ).toBe(false);
  expect(
    workflowConfigurationSchema.safeParse({ ...config, systemPrompt: "ignore permissions" }).success
  ).toBe(false);
});

it("allows ungrouped report stores but rejects overlapping peer groups", () => {
  const config = {
    schemaVersion: 1,
    type: "weekly-business-report",
    storeNames: ["A", "B", "C"],
    notificationPolicy: "action_required",
    groups: [
      { name: "Large", storeNames: ["A"] },
      { name: "Small", storeNames: ["B"] }
    ],
    delivery: { enabled: false, recipients: [] },
    cleanupPolicy: "retain_final_report"
  };
  expect(workflowConfigurationSchema.parse(config).storeNames).toEqual(["A", "B", "C"]);
  expect(
    workflowConfigurationSchema.safeParse({
      ...config,
      groups: [
        { name: "Large", storeNames: ["A", "B"] },
        { name: "Small", storeNames: ["B"] }
      ]
    }).success
  ).toBe(false);
});

it("accepts six daily datasets and authorizes combo uploads only as single-day originals", () => {
  const datasets = [
    "business",
    "dishes",
    "combo_sales",
    "in_store_orders",
    "takeaway_orders",
    "delivery_ledger"
  ];
  const storeNames = ["合成甲店"];
  expect(
    workflowConfigurationSchema.safeParse({
      schemaVersion: 1,
      type: "meituan-daily-ingestion",
      storeNames,
      datasets,
      orderScope: "settled_only",
      cleanupPolicy: "confirmed_files_only",
      notificationPolicy: "action_required"
    }).success
  ).toBe(true);
  expect(
    workflowAuthorizationScopeSchema.safeParse({ kind: "upload", storeNames, datasets }).success
  ).toBe(true);
  const action = {
    kind: "upload",
    dataset: "combo_sales",
    storeNames,
    window: { startDate: "2026-11-19", endDate: "2026-11-19" },
    sourceHash: "1".repeat(64),
    metadataHash: "2".repeat(64)
  };
  expect(workflowActionIdentitySchema.safeParse(action).success).toBe(true);
  expect(
    workflowActionIdentitySchema.safeParse({
      ...action,
      window: { ...action.window, endDate: "2026-11-20" }
    }).success
  ).toBe(false);
  expect(
    workflowActionIdentitySchema.safeParse({ ...action, orderScope: "settled_only" }).success
  ).toBe(false);
});
