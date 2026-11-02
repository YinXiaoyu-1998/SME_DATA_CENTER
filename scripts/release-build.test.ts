import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { satisfies } from "semver";
import { releaseEntries } from "../tsup.release.config.js";

const releaseArtifacts = [
  "api",
  "worker",
  "ledger-pdf-render-check",
  "ledger-pdf",
  "ledger-shelf-life",
  "shelf-life-catalog",
  "readiness",
  "staging-smoke",
  "official-manual-acceptance",
  "auth-operator",
  "permissions-operator",
  "staging-upload-domain-cleanup",
  "partition-store-cleanup",
  "evidence-reindex"
] as const;

describe("release build", () => {
  it("compiles service and release-operation entrypoints with internal packages bundled", async () => {
    expect(releaseEntries).toEqual({
      api: "apps/api/src/index.ts",
      worker: "apps/worker/src/dev-loop.ts",
      "ledger-pdf-render-check": "apps/worker/src/ledger-pdf/renderer.integration.ts",
      "ledger-pdf": "scripts/ledger-pdf.ts",
      "ledger-shelf-life": "scripts/ledger-shelf-life.ts",
      "shelf-life-catalog": "scripts/shelf-life-catalog.ts",
      readiness: "scripts/readiness.ts",
      "staging-smoke": "scripts/staging-smoke.ts",
      "official-manual-acceptance": "scripts/official-manual-acceptance.ts",
      "permissions-operator": "apps/api/src/permissions-operator/cli.ts",
      "auth-operator": "apps/api/src/auth/operator-cli.ts",
      "staging-upload-domain-cleanup": "scripts/staging-upload-domain-cleanup.ts",
      "partition-store-cleanup": "scripts/partition-store-cleanup.ts",
      "evidence-reindex": "scripts/reindex-evidence.ts"
    });

    execFileSync("npm", ["run", "build:release"], {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    const buildGraph = JSON.parse(
      readFileSync(resolve("dist/release/metafile-esm.json"), "utf8")
    ) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }>;
    };
    const inputs = Object.keys(buildGraph.inputs);
    expect(inputs).toContain("node_modules/exceljs/lib/doc/workbook.js");
    expect(
      inputs.filter((input) =>
        /node_modules\/(?:archiver|archiver-utils|glob|minimatch|readdir-glob|rimraf|unzipper|zip-stream)\//.test(
          input
        )
      )
    ).toEqual([]);
    expect(inputs.some((input) => input.includes("exceljs/lib/stream/"))).toBe(false);
    const workerImports = buildGraph.outputs["dist/release/worker.js"]!.imports;
    expect(workerImports).toContainEqual(
      expect.objectContaining({ path: "readable-stream-v3", external: true })
    );
    expect(workerImports.some((entry) => entry.path === "readable-stream")).toBe(false);
    for (const workspace of ["worker", "release-ops"]) {
      const manifest = JSON.parse(
        readFileSync(resolve(`apps/${workspace}/package.json`), "utf8")
      ) as { dependencies: Record<string, string> };
      expect(manifest.dependencies).not.toHaveProperty("exceljs");
      for (const dependency of [
        "dayjs",
        "fast-csv",
        "jszip",
        "readable-stream-v3",
        "saxes",
        "uuid"
      ])
        expect(manifest.dependencies).toHaveProperty(dependency);
    }

    const cleanRoot = mkdtempSync(join(tmpdir(), "smedc-release-"));
    try {
      const cleanReleaseDir = join(cleanRoot, "dist", "release");
      mkdirSync(cleanReleaseDir, { recursive: true });
      symlinkSync(resolve(process.cwd(), "node_modules"), join(cleanRoot, "node_modules"), "dir");

      for (const artifact of releaseArtifacts) {
        const artifactPath = resolve(process.cwd(), "dist/release", `${artifact}.js`);

        expect(existsSync(artifactPath)).toBe(true);
        expect(readFileSync(artifactPath, "utf8")).not.toContain("@smedc/");
        copyFileSync(artifactPath, join(cleanReleaseDir, `${artifact}.js`));
      }

      for (const artifact of [
        "worker",
        "ledger-pdf-render-check",
        "readiness",
        "staging-smoke",
        "official-manual-acceptance",
        "auth-operator",
        "permissions-operator",
        "staging-upload-domain-cleanup",
        "partition-store-cleanup",
        "evidence-reindex"
      ] as const) {
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", `await import('./dist/release/${artifact}.js')`],
          { cwd: cleanRoot, stdio: "pipe" }
        );
      }

      const permissionsHelp = execFileSync(
        process.execPath,
        ["dist/release/permissions-operator.js", "--help"],
        { cwd: cleanRoot, encoding: "utf8" }
      );
      expect(permissionsHelp).toContain("Apply previews by default");
      expect(permissionsHelp).toContain("--requested-by-admin-id");
      const help = execFileSync(process.execPath, ["dist/release/ledger-pdf.js", "--help"], {
        cwd: cleanRoot,
        encoding: "utf8"
      });
      expect(help).toContain("retry-failed");
      expect(help).toContain("--all-dates");
      const shelfLifeHelp = execFileSync(
        process.execPath,
        ["dist/release/ledger-shelf-life.js", "--help"],
        {
          cwd: cleanRoot,
          encoding: "utf8"
        }
      );
      expect(shelfLifeHelp).toContain("--org-name");
      expect(shelfLifeHelp).toContain("updatedRows");
      const catalogHelp = execFileSync(
        process.execPath,
        ["dist/release/shelf-life-catalog.js", "--help"],
        { cwd: cleanRoot, encoding: "utf8" }
      );
      expect(catalogHelp).toContain("物品名,保质期");
      expect(catalogHelp).toContain("--operator");
      expect(readFileSync(join(cleanReleaseDir, "ledger-pdf.js"), "utf8")).not.toMatch(
        /from ["'](?:exceljs|pdf-lib)["']/
      );
      await expectCompiledApiStarts(cleanRoot);
      expectProductionWorkbookRoundTrips();
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

function expectProductionWorkbookRoundTrips() {
  const scratch = mkdtempSync(join(tmpdir(), "smedc-workbook-release-"));
  try {
    const entry = join(scratch, "workbook-smoke.ts");
    writeFileSync(
      entry,
      `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Workbook } from ${JSON.stringify(resolve("apps/worker/src/ledger-pdf/workbook.ts"))};
const workbook = new Workbook();
const sheet = workbook.addWorksheet("食品进货台账", { pageSetup: { orientation: "landscape" } });
sheet.getCell("A1").value = "合成台账";
sheet.getCell("A1").font = { bold: true };
sheet.getCell("A2").value = "=SUM(A1:A2)";
const image = workbook.addImage({ buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64"), extension: "png" });
sheet.addImage(image, { tl: { col: 0, row: 3 }, ext: { width: 20, height: 20 } });
const loaded = new Workbook();
await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
assert.equal(loaded.worksheets[0].getCell("A1").value, "合成台账");
assert.equal(loaded.worksheets[0].getCell("A1").font.bold, true);
assert.equal(loaded.worksheets[0].getCell("A2").value, "=SUM(A1:A2)");
assert.equal(loaded.worksheets[0].pageSetup.orientation, "landscape");
assert.equal(loaded.worksheets[0].getImages().length, 1);
for (const name of ["exceljs", "archiver", "glob", "minimatch", "unzipper"]) assert.throws(() => require.resolve(name));
const versions = {};
for (const name of ["dayjs", "fast-csv", "jszip", "readable-stream-v3", "saxes", "uuid"]) {
  assert.ok(require.resolve(name).startsWith(resolve("node_modules", name) + sep));
  versions[name] = JSON.parse(readFileSync(resolve("node_modules", name, "package.json"), "utf8")).version;
}
console.log(JSON.stringify(versions));
`
    );
    execFileSync(
      "npm",
      [
        "exec",
        "--",
        "tsup",
        entry,
        "--config",
        "tsup.release.config.ts",
        "--out-dir",
        join(scratch, "built")
      ],
      { stdio: "pipe" }
    );
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      packages: Record<string, unknown>;
    };
    for (const workspace of ["worker", "release-ops"]) {
      const directory = join(scratch, workspace);
      mkdirSync(directory);
      for (const file of ["package.json", "package-lock.json"])
        copyFileSync(file, join(directory, file));
      for (const location of Object.keys(lock.packages)) {
        if (!location || location.includes("node_modules")) continue;
        mkdirSync(join(directory, location), { recursive: true });
        copyFileSync(join(location, "package.json"), join(directory, location, "package.json"));
      }
      // The initial repository npm ci has cached this exact lock; never use the network here.
      execFileSync(
        "npm",
        [
          "ci",
          "--offline",
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--workspace",
          `@smedc/${workspace}`,
          "--include-workspace-root=false"
        ],
        { cwd: directory, stdio: "pipe" }
      );
      mkdirSync(join(directory, "dist/release"), { recursive: true });
      copyFileSync(
        join(scratch, "built/workbook-smoke.js"),
        join(directory, "dist/release/workbook-smoke.js")
      );
      const versions = JSON.parse(
        execFileSync(process.execPath, ["dist/release/workbook-smoke.js"], {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, NODE_PATH: "" }
        })
      ) as Record<string, string>;
      const manifest = JSON.parse(readFileSync(`apps/${workspace}/package.json`, "utf8")) as {
        dependencies: Record<string, string>;
      };
      for (const [name, version] of Object.entries(versions)) {
        const range = manifest.dependencies[name]!.replace(/^npm:[^@]+@/, "");
        expect(
          satisfies(version, range),
          `${workspace}: ${name}@${version} must satisfy ${range}`
        ).toBe(true);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function expectCompiledApiStarts(cleanRoot: string): Promise<void> {
  const port = await findAvailablePort();
  const child = spawn(process.execPath, ["dist/release/api.js"], {
    cwd: cleanRoot,
    env: {
      ...process.env,
      CURSOR_SIGNING_SECRET: "release-artifact-smoke-cursor-secret",
      DATABASE_URL: "mysql://smedc:smedc_local_password@127.0.0.1:3307/smedc",
      SMEDC_PUBLIC_ORIGIN: "https://api.smedatacenter.xyz",
      HOST: "127.0.0.1",
      LOCAL_STORAGE_ROOT: join(cleanRoot, "storage"),
      NODE_ENV: "production",
      PORT: String(port),
      STORAGE_DRIVER: "local"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Compiled API exited before health check:\n${output}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          return;
        }
      } catch {
        // The listener may still be starting.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error(`Compiled API did not become healthy:\n${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await new Promise<void>((resolveClose) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveClose();
        return;
      }
      child.once("close", () => resolveClose());
    });
  }
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolvePort(address.port);
          return;
        }
        reject(new Error("Unable to allocate a release-artifact smoke port."));
      });
    });
  });
}
