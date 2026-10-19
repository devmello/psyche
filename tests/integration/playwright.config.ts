import { defineConfig } from "@playwright/test";

// Playwright for Electron: the walking skeleton in the packaged desktop app (INT-1). Build first
// with `pnpm --filter @psyche/desktop package`; run with `pnpm --filter @psyche/integration-tests e2e`.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
});
