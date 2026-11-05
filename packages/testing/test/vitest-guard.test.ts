import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureSecret } from "../src/index.ts";
import { SECRET_LEAK_SETUP_FILE, secretLeakGuard } from "../src/vitest.ts";

const require = createRequire(import.meta.url);

describe("vitest secret-leak guard", () => {
  it("plugin adds an existing setup file", () => {
    const plugin = secretLeakGuard();
    expect(plugin.name).toBe("psyche:secret-leak-guard");
    expect(plugin.config().test.setupFiles).toEqual([SECRET_LEAK_SETUP_FILE]);
    expect(existsSync(SECRET_LEAK_SETUP_FILE)).toBe(true);
  });

  it("fails exactly the test that leaked, without printing the value", () => {
    const dir = join(import.meta.dirname, "guard-fixture");
    // Vitest's own CLI with this Node: no `pnpm` lookup (on Windows only an `.exe` on PATH can be
    // spawned without a shell, and a stray pnpm that runs in the package root would pick up this
    // package's config and run this test again, recursively), and an absolute config and root.
    const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
    let output = "";
    let status = 0;
    try {
      const args = [vitest, "run", "--config", join(dir, "vitest.config.ts"), "--root", dir];
      output = execFileSync(process.execPath, args, {
        cwd: dir,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, CI: "1", NO_COLOR: "1", PSYCHE_CAPTURE_DIR: "" },
      });
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      status = e.status;
      output = `${e.stdout}\n${e.stderr}`;
    }
    expect(status).toBe(1);
    expect(output).toMatch(/1 failed/);
    expect(output).toMatch(/1 passed/);
    expect(output).toContain("Model-visible leak in leaky turn");
    expect(output).toContain("cred:mail-login.password");
    expect(output).not.toContain(fixtureSecret("mail-login", "password"));
  }, 60_000);
});
