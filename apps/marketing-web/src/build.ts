import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientSource } from "./client.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export async function buildSite(outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await cp(resolve(sourceDirectory, "../public"), outputDirectory, { recursive: true });
  const html = await readFile(resolve(sourceDirectory, "index.html"), "utf8");
  const css = await readFile(resolve(sourceDirectory, "styles.css"), "utf8");
  const revision = createHash("sha256")
    .update(html)
    .update(css)
    .update(clientSource)
    .digest("hex")
    .slice(0, 16);
  await Promise.all([
    writeFile(resolve(outputDirectory, "index.html"), html.replaceAll("__REVISION__", revision)),
    writeFile(resolve(outputDirectory, "styles.css"), css),
    writeFile(resolve(outputDirectory, "client.js"), clientSource),
    writeFile(resolve(outputDirectory, "version.json"), JSON.stringify({ revision }) + "\n")
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSite(resolve(sourceDirectory, "../../../dist/marketing"));
}
