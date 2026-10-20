import { defineConfig } from "vitest/config";

// Keep the packaged Gateway (deploy/scripts/build-psyched.mjs writes a workspace subset, tests
// included, under dist-bin/) out of this package's test run.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-bin/**", "**/out/**", "**/.vite/**"],
  },
});
