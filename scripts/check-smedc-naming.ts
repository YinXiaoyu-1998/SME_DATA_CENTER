import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NamingViolation {
  file: string;
  line: number;
  token: string;
  text: string;
}

const forbiddenPatterns: Array<{ token: string; pattern: RegExp }> = [
  { token: "Enterprise Hub", pattern: /\bEnterprise\s+Hub\b/i },
  { token: "enterprise-hub", pattern: /\benterprise-hub\b/i },
  { token: "enterprise_hub", pattern: /\benterprise_hub\b/i },
  { token: "enterprisehub", pattern: /\benterprisehub\b/i },
  { token: "enterpricehub", pattern: /\benterpricehub\b/i },
  { token: "maijia", pattern: /\bmaijia\b/i },
  { token: "麦家", pattern: /麦家/ }
];

const excludedPathPatterns = [
  /^\.git\//,
  /^\.worktrees\//,
  /^node_modules\//,
  /^\.data\//,
  /^coverage\//,
  /^dist\//,
  /^docs\/adr\//,
  /^docs\/superpowers\//,
  /^docs\/implementation\/progress\.md$/,
  /^docs\/implementation\/agent-handoffs\.md$/,
  /^scripts\/check-smedc-naming\.ts$/,
  /^scripts\/check-smedc-naming\.test\.ts$/
];

function isExcluded(file: string): boolean {
  const normalized = file.split(path.sep).join("/");
  return excludedPathPatterns.some((pattern) => pattern.test(normalized));
}

function trackedFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8"
  });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function findNamingViolations(root = process.cwd(), files = trackedFiles(root)) {
  const violations: NamingViolation[] = [];

  for (const file of files) {
    if (isExcluded(file)) {
      continue;
    }

    for (const { token, pattern } of forbiddenPatterns) {
      if (pattern.test(file)) {
        violations.push({
          file,
          line: 0,
          token,
          text: file
        });
      }
    }

    let content: string;
    try {
      content = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { token, pattern } of forbiddenPatterns) {
        if (pattern.test(line)) {
          violations.push({
            file,
            line: index + 1,
            token,
            text: line.trim()
          });
        }
      }
    });
  }

  return violations;
}

function main() {
  const violations = findNamingViolations();
  if (violations.length === 0) {
    return;
  }

  console.error(`Found ${violations.length} old SMEDC naming violation(s):`);
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.token}: ${violation.text}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
