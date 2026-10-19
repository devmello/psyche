import { defineConfig } from "vitest/config";
import { secretLeakGuard } from "../../packages/testing/src/vitest.ts";

/**
 * Offline acceptance checks (INT-3). Everything here runs in `pnpm -r test` with the scripted
 * provider and fixtures: no network, no model keys.
 *
 * Two projects: the Node one (scenarios, injection, resumability, performance, the live driver's
 * plumbing) runs under S18's secret-leak guard, and with `PSYCHE_CAPTURE_DIR` set its captures
 * are written for `pnpm check:secrets --captures`. The jsdom one renders the kit's screens with
 * fixture data for the accessibility pass (the guard's file-URL registry loader does not run
 * under jsdom's URL, and nothing model-visible is produced there).
 *
 * Files run one at a time: the kill-point sweep, the injection rig and the composed Gateway each
 * hold a SQLite file and a few hundred ms of CPU; a 4-vCPU runner should not run them at once.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        plugins: [secretLeakGuard()],
        test: {
          name: "node",
          include: ["offline/**/*.test.ts", "perf/**/*.test.ts", "live/**/*.test.ts"],
          exclude: ["**/node_modules/**", "live/**/*.live.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "a11y",
          environment: "jsdom",
          setupFiles: ["./a11y/setup.ts"],
          include: ["a11y/**/*.test.tsx"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
