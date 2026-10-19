import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureSecret } from "../src/index.ts";
import { SECRET_LEAK_SETUP_FILE, secretLeakGuard } from "../src/vitest.ts";

describe("vitest secret-leak guard", () => {
  it("plugin adds an existing setup file", () => {
    const plugin = secretLeakGuard();
    expect(plugin.name).toBe("psyche:secret-leak-guard");
    expect(plugin.config().test.setupFiles).toEqual([SECRET_LEAK_SETUP_FILE]);
    expect(existsSync(SECRET_LEAK_SETUP_FILE)).toBe(true);
  });

  it("fails exactly the test that leaked, without printing the value", () => {
    const dir = join(import.meta.dirname, "guard-fixture");
    let output = "";
    let status = 0;
    try {
      output = execFileSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.config.ts"], {
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
