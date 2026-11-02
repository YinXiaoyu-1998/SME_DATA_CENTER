import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("preserves unseen selections and saved optional review identities while editing the visible store page", async () => {
  const { workflowModelSource } = await import("./workflow-model.js");
  const model = runInNewContext(`${workflowModelSource}; workflowModel`);
  expect(model.selectVisible(["old-unloaded", "A"], ["A", "B"], ["B"])).toEqual([
    "old-unloaded",
    "B"
  ]);
  const saved = {
    type: "meituan-review-operations",
    storeNames: ["A"],
    ignoredReviewIdentities: [{ feedbackId: "original", reason: "explicit exclusion" }],
    publication: { enabled: false, storeNames: [] }
  };
  const draft = model.draft(saved.type, saved);
  draft.storeNames.push("B");
  expect(draft.ignoredReviewIdentities).toEqual([
    { feedbackId: "original", reason: "explicit exclusion" }
  ]);
  expect(saved.storeNames).toEqual(["A"]);
});

it("keeps ungrouped stores in weekly reports while rejecting overlapping groups and publication outside collection scope", async () => {
  const { workflowModelSource } = await import("./workflow-model.js");
  const model = runInNewContext(`${workflowModelSource}; workflowModel`);
  const report = {
    ...model.draft("weekly-business-report"),
    storeNames: ["A", "B"],
    groups: [{ name: "Main", storeNames: ["A"] }]
  };
  expect(model.validate(report)).toBeNull();
  report.groups.push({ name: "Other", storeNames: ["A"] });
  expect(model.validate(report)).toBe("groupsInvalid");
  const reviews = {
    ...model.draft("meituan-review-operations"),
    storeNames: ["A"],
    channels: ["meituan"],
    publication: { enabled: true, storeNames: ["B"] }
  };
  expect(model.validate(reviews)).toBe("publicationInvalid");
});
