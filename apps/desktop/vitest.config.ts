import { defineConfig } from "vitest/config";

// Unit tests run under plain Node; no Electron launch. The shared renderer shell's tests
// (test/shell, test/compose, ...) opt into happy-dom per file and mount React.
export default defineConfig({
  test: {
    name: "@psyche/desktop",
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // The composed-app tests mount the whole shell; on a loaded Windows runner one took 5-8 s
    // and timed out at the 5 s default (2026-11-05). The kit's suite allows the same.
    testTimeout: 30_000,
  },
});
