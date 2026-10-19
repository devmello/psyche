// Fixture project for test/vitest-guard.test.ts: proves the guard fails a leaking test.
import { defineConfig } from "vitest/config";
import { secretLeakGuard } from "../../src/vitest.ts";

export default defineConfig({
  plugins: [secretLeakGuard()],
  test: { include: ["*.fixture.ts"], root: import.meta.dirname },
});
