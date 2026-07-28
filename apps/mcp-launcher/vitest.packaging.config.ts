import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/packaging.verify.ts"],
    fileParallelism: false,
    passWithNoTests: false
  }
});
