import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Every story is rendered and checked with axe; give the suite room on slow CI runners.
    testTimeout: 30_000,
  },
});
