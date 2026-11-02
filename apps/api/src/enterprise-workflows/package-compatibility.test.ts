import { describe, expect, it } from "vitest";
import { supportsWorkflowPackageVersion } from "./package-compatibility.js";

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
