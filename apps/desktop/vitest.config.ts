import { defineConfig } from "vitest/config";

// Unit tests for the pure logic in src/lib run under plain Node; no Electron launch.
export default defineConfig({
  test: {
    name: "@psyche/desktop",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
