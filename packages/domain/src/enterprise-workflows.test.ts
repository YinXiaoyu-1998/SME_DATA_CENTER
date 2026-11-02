import { describe, expect, it } from "vitest";
import { enterpriseIntegrationSchema, workflowConfigurationSchema } from "./index.js";

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
