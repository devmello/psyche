import { defineConfig } from "@playwright/test";

// Playwright-for-Electron smoke tests (S11 definition of done). They launch the built app
// (`pnpm --filter @psyche/desktop package` first, which leaves .vite/ behind) against the mock
// Gateway. Run with `pnpm --filter @psyche/desktop e2e`; CI runs them in the macOS desktop job.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
});
