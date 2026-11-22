import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeSetupCode } from "@psyche/protocol";
import { markClaimed, readSetupCode } from "@psyche/protocol/claim-node";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { setupState, setupText } from "../src/commands/service.ts";
import { cleanupTempDirs, err, FIXED_NOW, makeDeps, out, POSIX_MODES, runJson } from "./helpers.ts";

afterEach(cleanupTempDirs);

describe("psyche setup code (remote-gateway design §3.6)", () => {
  it("prints a new code once and keeps only a hash of it, at 0600", async () => {
    const deps = makeDeps();
    expect(await run(["setup", "code"], deps)).toBe(0);
    const shown = /Setup code: (\S+)/.exec(out(deps))?.[1] ?? "";
    expect(shown).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    const file = join(deps.env.PSYCHE_HOME as string, "identity", "setup-code.json");
    const stored = readFileSync(file, "utf8");
    expect(stored).not.toContain(shown.replace("-", ""));
    expect(stored).not.toContain(shown);
    if (POSIX_MODES) expect(statSync(file).mode & 0o777).toBe(0o600);
    const code = readSetupCode(deps.env.PSYCHE_HOME as string, FIXED_NOW);
    expect(code).not.toBe("expired");
    expect(code === null || code === "expired" ? null : code.expiresAt).toBe(
      "2026-10-20T12:00:00.000Z",
    );
  });

  it("a new code replaces the old one", async () => {
    const deps = makeDeps();
    const a = await runJson(["setup", "code"], deps);
    const b = await runJson(["setup", "code"], deps);
    expect(a.code).toBe(0);
    const first = normalizeSetupCode(String(a.json.code));
    const second = normalizeSetupCode(String(b.json.code));
    expect(first).not.toBe(second);
  });

  it("is refused once the server is set up", async () => {
    const deps = makeDeps();
    markClaimed(deps.env.PSYCHE_HOME as string, "terminal", FIXED_NOW);
    expect(await run(["setup", "code"], deps)).not.toBe(0);
    expect(err(deps)).toContain("set up already");
  });

  it("is its own command, with its own help", async () => {
    // `setup code` is its own command; `setup` alone is not mistaken for it.
    const deps = makeDeps();
    expect(await run(["setup", "code", "--help"], deps)).toBe(0);
    expect(out(deps)).toContain("Usage: psyche setup code");
  });
});

describe("psyche status on a server that is not set up", () => {
  it("says a code is waiting, that it expired, or that there is none, and nothing once set up", async () => {
    const deps = makeDeps();
    const home = deps.env.PSYCHE_HOME as string;
    const ctx = { home, deps };
    expect(setupText(setupState(ctx) ?? { state: "no_code" })).toContain("psyche setup code");
    expect(setupState(ctx)).toEqual({ state: "no_code" });
    await run(["setup", "code"], deps);
    expect(setupState(ctx)).toEqual({ state: "waiting", expiresAt: "2026-10-20T12:00:00.000Z" });
    const later = { home, deps: { ...deps, now: () => new Date("2026-10-21T00:00:00.000Z") } };
    expect(setupState(later)).toEqual({ state: "expired" });
    expect(setupText({ state: "expired" })).toContain("expired");
    markClaimed(home, "claim", FIXED_NOW);
    expect(setupState(ctx)).toBeUndefined();
  });
});
