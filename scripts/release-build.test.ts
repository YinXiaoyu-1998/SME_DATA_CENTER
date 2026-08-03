import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseEntries } from "../tsup.release.config.js";

const releaseArtifacts = ["api", "worker", "readiness", "staging-smoke"] as const;

describe("release build", () => {
  it("compiles service and release-operation entrypoints with internal packages bundled", async () => {
    expect(releaseEntries).toEqual({
      api: "apps/api/src/index.ts",
      worker: "apps/worker/src/dev-loop.ts",
      readiness: "scripts/readiness.ts",
      "staging-smoke": "scripts/staging-smoke.ts"
    });

    execFileSync("npm", ["run", "build:release"], {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    const cleanRoot = mkdtempSync(join(tmpdir(), "enterprise-hub-release-"));
    try {
      const cleanReleaseDir = join(cleanRoot, "dist", "release");
      mkdirSync(cleanReleaseDir, { recursive: true });
      symlinkSync(resolve(process.cwd(), "node_modules"), join(cleanRoot, "node_modules"), "dir");

      for (const artifact of releaseArtifacts) {
        const artifactPath = resolve(process.cwd(), "dist/release", `${artifact}.js`);

        expect(existsSync(artifactPath)).toBe(true);
        expect(readFileSync(artifactPath, "utf8")).not.toContain("@enterprise-hub/");
        copyFileSync(artifactPath, join(cleanReleaseDir, `${artifact}.js`));
      }

      for (const artifact of ["worker", "readiness", "staging-smoke"] as const) {
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", `await import('./dist/release/${artifact}.js')`],
          { cwd: cleanRoot, stdio: "pipe" }
        );
      }

      await expectCompiledApiStarts(cleanRoot);
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

async function expectCompiledApiStarts(cleanRoot: string): Promise<void> {
  const port = await findAvailablePort();
  const child = spawn(process.execPath, ["dist/release/api.js"], {
    cwd: cleanRoot,
    env: {
      ...process.env,
      CURSOR_SIGNING_SECRET: "release-artifact-smoke-cursor-secret",
      DATABASE_URL:
        "mysql://enterprise_hub:enterprise_hub_local_password@127.0.0.1:3307/enterprise_hub",
      ENTERPRISE_HUB_PUBLIC_ORIGIN: "https://api.smedatacenter.xyz",
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
