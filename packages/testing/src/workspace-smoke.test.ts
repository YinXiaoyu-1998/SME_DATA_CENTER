import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const expectedWorkspaceNames = [
  "@smedc/admin-web",
  "@smedc/api",
  "@smedc/db",
  "@smedc/domain",
  "@smedc/ledger-archive",
  "@smedc/mcp-contract",
  "@smedc/release-ops",
  "@smedc/storage",
  "@smedc/structured-ingestion",
  "@smedc/testing",
  "@smedc/worker",
  "smedc-mcp-launcher"
];

describe("workspace skeleton", () => {
  it("declares only the supported workspace packages", async () => {
    await expect(readWorkspaceNames()).resolves.toEqual(expectedWorkspaceNames);
  });
});

async function readWorkspaceNames(): Promise<string[]> {
  const workspaceRoots = ["apps", "packages"];
  const names: string[] = [];

  for (const workspaceRoot of workspaceRoots) {
    const rootPath = path.join(process.cwd(), workspaceRoot);
    const entries = await readdir(rootPath, { withFileTypes: true });

    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const packageJsonPath = path.join(rootPath, entry.name, "package.json");
      const rawPackageJson = await readOptionalTextFile(packageJsonPath);

      if (!rawPackageJson) {
        continue;
      }

      const packageJson = JSON.parse(rawPackageJson) as { name: string };
      names.push(packageJson.name);
    }
  }

  return names.sort();
}

async function readOptionalTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
