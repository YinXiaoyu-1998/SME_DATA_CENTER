import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWebApiContract, serializeWebApiContract } from "./emit.js";
import { WEB_API_ERROR_CODES } from "./errors.js";
import { WEB_API_ROUTES, validateWebApiRoutes } from "./registry.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("contract.json", () => {
  it("matches the registry byte for byte", async () => {
    validateWebApiRoutes({ routes: WEB_API_ROUTES });
    const committed = await readFile(resolve(packageRoot, "contract.json"), "utf8");
    expect(committed).toBe(serializeWebApiContract(buildWebApiContract()));
  });

  it("registers the department duplicate-name conflict on the department route only", () => {
    expect(WEB_API_ERROR_CODES).toContain("DIRECTORY_DUPLICATE_NAME");
    expect(
      WEB_API_ROUTES.find((candidate) => candidate.id === "directory.manageDepartment")?.errors
    ).toContain("DIRECTORY_DUPLICATE_NAME");
    expect(
      WEB_API_ROUTES.find((candidate) => candidate.id === "directory.listDirectory")?.errors
    ).not.toContain("DIRECTORY_DUPLICATE_NAME");
  });

  it("is deterministic", () => {
    expect(serializeWebApiContract(buildWebApiContract())).toBe(
      serializeWebApiContract(buildWebApiContract())
    );
  });
});
