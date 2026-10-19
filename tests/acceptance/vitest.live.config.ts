import { defineConfig } from "vitest/config";
import { secretLeakGuard } from "../../packages/testing/src/vitest.ts";

/** Live model gates: `PSYCHE_LIVE_TESTS=1 pnpm --filter @psyche/acceptance-tests live`. */
export default defineConfig({
  plugins: [secretLeakGuard()],
  test: {
    include: ["live/**/*.live.test.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
