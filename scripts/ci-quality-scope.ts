import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function qualityScope(event: string, paths: string[]) {
  const full = { code: true, node_images: true, pdf: true, integration: true };
  // Only PRs may omit checks. Main and manual qualification always run everything.
  if (event !== "pull_request") return full;
  const scope = { code: false, node_images: false, pdf: false, integration: false };
  for (const path of paths) {
    // Markdown fixtures are executable evidence, not documentation.
    if (
      path.startsWith("docs/") ||
      (!path.startsWith("fixtures/") &&
        (/(^|\/)(README|AGENTS)\.md$/.test(path) ||
          (!path.includes("/") && path.endsWith(".md")) ||
          (path.startsWith("skills/") && path.endsWith(".md"))))
    )
      continue;
    scope.code = true;
    if (/^(eslint\.config\.|vitest\.config\.|\.prettier)/.test(path)) continue;
    if (path.startsWith("services/pdf-parser/")) {
      scope.pdf = true;
      scope.integration = true;
      continue;
    }
    if (/^(apps|packages|scripts|fixtures|native|deploy)\//.test(path)) {
      scope.integration = true;
      if (!path.endsWith(".test.ts")) scope.node_images = true;
      if (
        /^(apps\/worker\/|packages\/(domain|db|storage|mcp-contract)\/|deploy\/|fixtures\/evidence\/pdf\/|scripts\/(pdf-|test-pdf-|official-manual-|deploy-staging|readiness|check-vulnerability-policy))/.test(
          path
        ) ||
        /^apps\/api\/.*(evidence|pdf|source-documents|app-context|server)/.test(path)
      )
        scope.pdf = true;
      // These scripts define the gates themselves; changes must exercise every gate.
      if (/^scripts\/(ci-quality-scope|staging-deploy-workflow)/.test(path)) return full;
      continue;
    }
    // Unknown paths (including workflow, lockfile and build config changes) fail safe.
    return full;
  }
  return scope;
}

export function changedPaths(base: string, head: string, cwd = process.cwd()): string[] {
  for (const sha of [base, head]) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected a full commit SHA");
  }
  // Three-dot compares the entire PR to its merge base, not just its latest push.
  // No rename folding: moving executable code into docs must retain the old path.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  })
    .split("\0")
    .filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = process.env["GITHUB_EVENT_NAME"] ?? "";
  const paths =
    event === "pull_request"
      ? changedPaths(process.env["PR_BASE_SHA"] ?? "", process.env["PR_HEAD_SHA"] ?? "")
      : [];
  const scope = qualityScope(event, paths);
  const output = Object.entries(scope)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env["GITHUB_OUTPUT"]) appendFileSync(process.env["GITHUB_OUTPUT"], output);
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    appendFileSync(
      process.env["GITHUB_STEP_SUMMARY"],
      `### Selected quality checks\n\n${output
        .split("\n")
        .filter(Boolean)
        .map((line) => `- ${line}`)
        .join("\n")}\n`
    );
  }
  process.stdout.write(output);
}
