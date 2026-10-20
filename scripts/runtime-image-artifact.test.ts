import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeImageManifest, loadRuntimeImages } from "./runtime-image-artifact.js";
import { publishVerifiedRuntimeImages } from "./deploy-staging.js";

const commit = "a".repeat(40);
const components = ["api", "worker", "release-ops"] as const;
const directories: string[] = [];
const id = (component: string) =>
  `sha256:${String(components.indexOf(component as (typeof components)[number]) + 1).repeat(64)}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "smedc-image-artifact-"));
  directories.push(directory);
  await writeFile(join(directory, "images.tar.gz"), "synthetic archive bytes");
  const docker = vi.fn(async (args: string[]) => {
    if (args[0] !== "image" || args[1] !== "inspect") return "";
    const component = components.find((value) => args[2] === `smedc-${value}:ci`)!;
    return JSON.stringify([
      {
        Id: id(component),
        Os: "linux",
        Architecture: "amd64",
        Config: { Labels: { "org.opencontainers.image.revision": commit } }
      }
    ]);
  });
  await createRuntimeImageManifest(directory, commit, docker);
  docker.mockClear();
  return { directory, docker };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("tested main runtime image handoff", () => {
  it("publishes the verified image IDs without rebuilding", async () => {
    const { directory, docker } = await fixture();
    const images = {
      api: "registry.example/api:aaaaaaaaaaaa",
      worker: "registry.example/worker:aaaaaaaaaaaa",
      "release-ops": "registry.example/api:ops-aaaaaaaaaaaa"
    };
    await publishVerifiedRuntimeImages(directory, commit, images, docker);
    expect(docker.mock.calls.map(([args]) => args)).toEqual([
      ["load", "--input", join(directory, "images.tar.gz")],
      ...components.map((component) => ["image", "inspect", `smedc-${component}:ci`]),
      ...components.flatMap((component) => [
        ["tag", id(component), images[component]],
        ["push", images[component]]
      ])
    ]);
  });

  it("rejects another commit or altered archive before loading or publishing", async () => {
    const { directory, docker } = await fixture();
    await expect(loadRuntimeImages(directory, "b".repeat(40), docker)).rejects.toThrow(/commit/);
    expect(docker).not.toHaveBeenCalled();
    await writeFile(join(directory, "images.tar.gz"), "altered bytes");
    await expect(loadRuntimeImages(directory, commit, docker)).rejects.toThrow(/checksum/);
    expect(docker).not.toHaveBeenCalled();
  });

  it("rejects an image different from the tested manifest before publishing any image", async () => {
    const { directory, docker } = await fixture();
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    manifest.images.worker = `sha256:${"f".repeat(64)}`;
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await expect(
      publishVerifiedRuntimeImages(
        directory,
        commit,
        { api: "api:target", worker: "worker:target", "release-ops": "ops:target" },
        docker
      )
    ).rejects.toThrow(/image/);
    expect(docker.mock.calls.some(([args]) => ["tag", "push"].includes(args[0]!))).toBe(false);
  });

  it("refuses to attest images of the wrong architecture or revision", async () => {
    const { directory } = await fixture();
    for (const change of [
      { Architecture: "arm64" },
      { Config: { Labels: { "org.opencontainers.image.revision": "b".repeat(40) } } }
    ]) {
      const docker = async () =>
        JSON.stringify([
          {
            Id: id("api"),
            Os: "linux",
            Architecture: "amd64",
            Config: { Labels: { "org.opencontainers.image.revision": commit } },
            ...change
          }
        ]);
      await expect(createRuntimeImageManifest(directory, commit, docker)).rejects.toThrow(/image/);
    }
  });
});
