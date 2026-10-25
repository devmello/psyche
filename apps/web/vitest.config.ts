import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@psyche/web",
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
