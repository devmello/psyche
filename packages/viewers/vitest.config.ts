import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PDF.js and SheetJS cold starts are slow on CI runners.
    testTimeout: 30_000,
    passWithNoTests: true,
    setupFiles: ["./test/setup-dom.ts"],
  },
});
