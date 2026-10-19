import { defineConfig } from "vitest/config";
import { secretLeakGuard } from "./src/vitest.ts";

// Every test in this package runs under the secret-leak guard. The guard's own fixture project
// (test/guard-fixture) is run by test/vitest-guard.test.ts, not here.
export default defineConfig({
  plugins: [secretLeakGuard()],
  test: { exclude: ["**/node_modules/**", "test/guard-fixture/**"] },
});
