import { defineConfig } from "vitest/config";

// Root config: runs every workspace package's tests in one process (`pnpm -w test`).
// `pnpm -r test` runs each package on its own, which is what CI uses.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "!apps/mac-helper"],
    passWithNoTests: true,
  },
});
