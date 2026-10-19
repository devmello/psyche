import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { drainCaptures, ModelVisibleLeakError, scanCaptures } from "./capture.ts";

/**
 * Vitest integration of the secret-leak checker (imported from `@psyche/testing/vitest`
 * because it depends on vitest). Every test starts with an empty capture buffer and fails if
 * anything it captured as model-visible holds a fixture secret, a registered secret, or a card /
 * ID / key pattern. Packages enable it with the plugin or the setup file:
 *
 * ```ts
 * // vitest.config.ts
 * import { secretLeakGuard } from "@psyche/testing/vitest";
 * export default defineConfig({ plugins: [secretLeakGuard()] });
 * // or: test: { setupFiles: ["@psyche/testing/vitest-setup"] }
 * ```
 */
export function installSecretLeakGuard(): void {
  beforeEach(() => {
    drainCaptures();
  });
  afterEach((ctx) => {
    const leaks = scanCaptures(drainCaptures());
    if (leaks.length > 0) throw new ModelVisibleLeakError(leaks, ctx.task.name);
  });
}

export const SECRET_LEAK_SETUP_FILE = fileURLToPath(new URL("./vitest-setup.ts", import.meta.url));

/** A Vite / Vitest plugin that adds the guard's setup file to `test.setupFiles`. */
export function secretLeakGuard(): {
  name: string;
  config: () => { test: { setupFiles: string[] } };
} {
  return {
    name: "psyche:secret-leak-guard",
    config: () => ({ test: { setupFiles: [SECRET_LEAK_SETUP_FILE] } }),
  };
}
