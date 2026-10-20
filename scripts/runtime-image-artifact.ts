import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RUNTIME_IMAGE_COMPONENTS = ["api", "worker", "release-ops"] as const;
export type RuntimeComponent = (typeof RUNTIME_IMAGE_COMPONENTS)[number];
export type DockerCommand = (args: string[]) => Promise<string>;
type ImageIds = Record<RuntimeComponent, string>;
const imageId = /^sha256:[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function checksum(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectImages(commit: string, docker: DockerCommand): Promise<ImageIds> {
  const images = {} as ImageIds;
  for (const component of RUNTIME_IMAGE_COMPONENTS) {
    const result: unknown = JSON.parse(await docker(["image", "inspect", `smedc-${component}:ci`]));
    const image: unknown = Array.isArray(result) ? result[0] : undefined;
    const config = isRecord(image) && isRecord(image["Config"]) ? image["Config"] : {};
    const labels = isRecord(config["Labels"]) ? config["Labels"] : {};
    if (
      !isRecord(image) ||
      typeof image["Id"] !== "string" ||
      !imageId.test(image["Id"]) ||
      image["Os"] !== "linux" ||
      image["Architecture"] !== "amd64" ||
      labels["org.opencontainers.image.revision"] !== commit
    ) {
      throw new Error(`Runtime image ${component} must match the tested linux/amd64 commit.`);
    }
    images[component] = image["Id"];
  }
  return images;
}

export async function createRuntimeImageManifest(
  directory: string,
  commit: string,
  docker: DockerCommand
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full commit SHA.");
  const images = await inspectImages(commit, docker);
  const archiveSha256 = await checksum(join(directory, "images.tar.gz"));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, commit, archiveSha256, images })
  );
}

export async function loadRuntimeImages(
  directory: string,
  commit: string,
  docker: DockerCommand
): Promise<ImageIds> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full commit SHA.");
  const manifest: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (
    !isRecord(manifest) ||
    manifest["schemaVersion"] !== 1 ||
    manifest["commit"] !== commit ||
    !isRecord(manifest["images"])
  ) {
    throw new Error("Runtime image manifest must belong to the exact successful main commit.");
  }
  const expected = manifest["images"];
  if (
    Object.keys(expected).length !== RUNTIME_IMAGE_COMPONENTS.length ||
    RUNTIME_IMAGE_COMPONENTS.some(
      (component) => typeof expected[component] !== "string" || !imageId.test(expected[component])
    )
  ) {
    throw new Error("Runtime image manifest must contain all three tested image IDs.");
  }
  const archive = join(directory, "images.tar.gz");
  if (manifest["archiveSha256"] !== (await checksum(archive)))
    throw new Error("Runtime image archive checksum mismatch.");
  await docker(["load", "--input", archive]);
  const actual = await inspectImages(commit, docker);
  if (RUNTIME_IMAGE_COMPONENTS.some((component) => actual[component] !== expected[component])) {
    throw new Error("Loaded runtime image differs from the tested manifest.");
  }
  return actual;
}

async function docker(args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolveResult(output) : reject(new Error("Docker image inspection failed."))
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, commit, ...extra] = process.argv.slice(2);
  if (command !== "create" || !directory || !commit || extra.length)
    throw new Error("Usage: runtime-image-artifact.ts create <directory> <full-commit-sha>");
  await createRuntimeImageManifest(directory, commit, docker);
}
