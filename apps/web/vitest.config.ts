import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@psyche/web",
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // The composed-app tests mount the whole shell; on a loaded Windows runner one took 5–8 s
    // and timed out at the 5 s default (2026-11-05). The kit's suite allows the same.
    testTimeout: 30_000,
  },
});
