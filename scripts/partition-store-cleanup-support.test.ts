import { describe, expect, it } from "vitest";
import {
  normalizeStoreCleanupScope,
  assertStoreCleanupRuntime,
  parseStoreCleanupArgs
} from "./partition-store-cleanup-support.js";
import { STAGING_RDS_HOST } from "./staging-runtime-targets.js";
const scope = {
  orgId: "org",
  enterpriseName: "Enterprise",
  datasets: ["business"],
  storeNames: [" Store "]
};
describe("exact store operator cleanup guard", () => {
  it("requires unambiguous organization, supported datasets and explicit store scope", () => {
    for (const bad of [
      { ...scope, orgId: "" },
      { ...scope, datasets: ["vip"] },
      { ...scope, storeNames: undefined },
      { ...scope, storeNames: [] },
      { ...scope, storeNames: [" "] },
      { ...scope, startDate: "2026-02-30" }
    ])
      expect(() => normalizeStoreCleanupScope(bad)).toThrow();
    expect(normalizeStoreCleanupScope(scope)).toEqual({ ...scope, storeNames: ["Store"] });
    expect(
      normalizeStoreCleanupScope({ ...scope, storeNames: undefined, storeNameContains: ["%_甲"] })
        .storeNameContains
    ).toEqual(["%_甲"]);
  });
  it("requires exact staging database and OSS identity", () => {
    const env = {
      DATABASE_URL: `mysql://smedc_app@${STAGING_RDS_HOST}:3306/smedc`,
      STORAGE_DRIVER: "oss",
      AWS_S3_BUCKET: "yxy-test-sme-data-center",
      AWS_REGION: "oss-cn-beijing",
      AWS_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com"
    };
    expect(() => assertStoreCleanupRuntime(env)).not.toThrow();
    for (const bad of [
      { ...env, DATABASE_URL: "mysql://root@127.0.0.1:3307/smedc" },
      { ...env, DATABASE_URL: `mysql://smedc_app@other:3306/smedc` },
      { ...env, STORAGE_DRIVER: "local" },
      { ...env, AWS_S3_BUCKET: "other" },
      { ...env, DATABASE_URL: `${env.DATABASE_URL}?host=other` }
    ])
      expect(() => assertStoreCleanupRuntime(bad)).toThrow("STORE_CLEANUP_RUNTIME_MISMATCH");
  });
  it("defaults to dry run and rejects execute without saved inventory and confirmation", () => {
    expect(
      parseStoreCleanupArgs([
        "--target",
        "staging",
        "--org-id",
        "org",
        "--inventory",
        "preview.json"
      ]).execute
    ).toBe(false);
    for (const args of [
      [],
      ["--target", "production"],
      ["--execute", "--target", "staging", "--org-id", "org", "--inventory", "preview.json"]
    ])
      expect(() => parseStoreCleanupArgs(args)).toThrow();
  });
});

it("saves the reviewed inventory privately and refuses overwrite", async () => {
  const { mkdtemp, stat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveStoreCleanupInventory } = await import("./partition-store-cleanup.js");
  const directory = await mkdtemp(join(tmpdir(), "store-cleanup-"));
  const path = join(directory, "inventory.json");
  try {
    const inventory = {
      version: 1 as const,
      scope: normalizeStoreCleanupScope(scope),
      targets: [],
      preserved: { partitions: 0, importJobs: 1, employees: 1 },
      fingerprint: "a".repeat(64)
    };
    await saveStoreCleanupInventory(path, inventory);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(saveStoreCleanupInventory(path, inventory)).rejects.toMatchObject({
      code: "EEXIST"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
