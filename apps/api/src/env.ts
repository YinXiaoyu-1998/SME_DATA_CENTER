import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

export function loadApiEnv(cwd = process.cwd()): void {
  const envPath = path.join(cwd, ".env");

  if (!existsSync(envPath)) {
    return;
  }

  config({ path: envPath, override: false, quiet: true });
}
