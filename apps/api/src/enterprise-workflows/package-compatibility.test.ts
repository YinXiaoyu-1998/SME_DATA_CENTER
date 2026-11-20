import { describe, expect, it } from "vitest";
import { workflowConfigurationSchema } from "@smedc/domain";
import {
  supportsWorkflowPackageVersion,
  supportsWorkflowConfiguration
} from "./package-compatibility.js";

describe("workflow package compatibility", () => {
  it("accepts stable patches independently of the capability version", () => {
    for (const version of ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.12"])
      expect(supportsWorkflowPackageVersion(version), version).toBe(true);
  });

  it("rejects unsupported lines, prereleases and malformed versions", () => {
    for (const version of [
      "0.9.0",
      "1.1.0",
      "2.0.0",
      "1.0.3-rc.1",
      "1.0.3+local",
      "1.0",
      "1.0.03",
      "v1.0.3",
      "1.0.3\n"
    ])
      expect(supportsWorkflowPackageVersion(version), version).toBe(false);
  });
});

it("requires newer versions only for runs selecting combo sales", () => {
  const daily = {
    schemaVersion: 1,
    type: "meituan-daily-ingestion",
    storeNames: ["合成门店"],
    orderScope: "settled_only",
    cleanupPolicy: "confirmed_files_only",
    notificationPolicy: "action_required"
  };
  const original = workflowConfigurationSchema.parse({ ...daily, datasets: ["dishes"] });
  const combo = workflowConfigurationSchema.parse({
    ...daily,
    datasets: ["dishes", "combo_sales"]
  });
  const oldInstallation = { launcherVersion: "0.22.1", workflowPackageVersion: "1.0.11" };
  expect(supportsWorkflowConfiguration(original, oldInstallation)).toBe(true);
  expect(supportsWorkflowConfiguration(combo, oldInstallation)).toBe(false);
  expect(
    supportsWorkflowConfiguration(combo, {
      ...oldInstallation,
      launcherVersion: "0.22.2"
    })
  ).toBe(false);
  expect(
    supportsWorkflowConfiguration(combo, {
      launcherVersion: "0.22.2",
      workflowPackageVersion: "1.0.12"
    })
  ).toBe(true);
});
