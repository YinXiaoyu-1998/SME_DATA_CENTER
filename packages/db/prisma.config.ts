import { existsSync } from "node:fs";

import "dotenv/config";
import { defineConfig } from "prisma/config";

const seedCommand = existsSync("packages/db/src/seed.ts")
  ? "tsx packages/db/src/seed.ts"
  : "tsx src/seed.ts";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: seedCommand
  },
  datasource: {
    url: process.env["DATABASE_URL"]
  }
});
