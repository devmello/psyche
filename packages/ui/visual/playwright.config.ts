import { defineConfig } from "@playwright/test";

/**
 * Visual regression over the static Storybook (S12 definition of done). Run after
 * `pnpm build-storybook`: `pnpm test:visual` (compare) or `pnpm test:visual:update` (baseline).
 * Baselines are per platform (`-darwin`, `-linux`); CI has no browser yet, so this suite is
 * local until a Playwright job exists. `PORT` moves the static server off 6106 when another
 * checkout already serves there (`reuseExistingServer` would otherwise test its build). Locally it drives the installed Chrome
 * (`PSYCHE_VISUAL_CHANNEL=chromium` uses Playwright's bundled browser instead).
 */
const port = Number(process.env.PORT ?? 6106);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{platform}{ext}",
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: "../test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PSYCHE_VISUAL_CHANNEL ?? "chrome",
    viewport: { width: 960, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled", caret: "hide" } },
  webServer: {
    command: "node --experimental-strip-types serve.ts",
    cwd: ".",
    url: `http://127.0.0.1:${port}/index.json`,
    reuseExistingServer: true,
  },
});
