import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the `desktop` image is told, checked as text (the real image is exercised by
 * apps/gateway/test/separate-desktop.real.test.ts): the settings that keep a task's leftovers in
 * /workspace from changing what later tasks run.
 */
const dir = resolve(import.meta.dirname, "../../../deploy/sandbox-image");
const read = (rel: string) => readFileSync(resolve(dir, rel), "utf8");

describe("the desktop image's lockdown files", () => {
  it("Firefox blocks every extension, so none can be planted to persist", () => {
    const policies = JSON.parse(read("desktop/firefox-policies.json")).policies;
    expect(policies.ExtensionSettings).toEqual({ "*": { installation_mode: "blocked" } });
    // The proxy stays locked to the egress shim.
    expect(policies.Proxy).toMatchObject({ Locked: true, HTTPProxy: "127.0.0.1:3128" });
  });

  it("LibreOffice macros are off at the highest level, finalized so the profile can't undo it", () => {
    const xcd = read("desktop/libreoffice-lockdown.xcd");
    expect(xcd).toMatch(/oor:name="MacroSecurityLevel" oor:finalized="true"><value>3</);
    expect(xcd).toMatch(/oor:name="DisableMacrosExecution" oor:finalized="true"><value>true</);
    expect(xcd).toContain('oor:package="org.openoffice.Office"');
    // Installed in the registry folder, after main.xcd.
    expect(read("Dockerfile")).toContain(
      "/usr/lib/libreoffice/share/registry/zz-psyche-lockdown.xcd",
    );
  });

  it("the trusted daemons get a home under /tmp; apps and the helper keep /workspace", () => {
    const sh = read("desktop/entrypoint.sh");
    expect(sh).toContain("TRUSTED_HOME=/tmp/trusted-home");
    for (const daemon of ["dbus-daemon", "Xvfb", "at-spi-bus-launcher"]) {
      expect(sh, daemon).toMatch(new RegExp(`^trusted /usr/(bin|libexec)/${daemon}`, "m"));
    }
    // The helper (and what it launches) is not wrapped.
    expect(sh).toMatch(/^exec \/usr\/local\/bin\/psyche-helper/m);
    expect(sh).toContain("HOME=/workspace");
  });

  it("every program the entrypoint starts is named by its absolute path", () => {
    const sh = read("desktop/entrypoint.sh");
    const calls = sh
      .split("\n")
      .filter((l) => /^\s*(trusted\s+)?\/?[A-Za-z]/.test(l) && !l.trim().startsWith("#"))
      .map((l) => l.trim())
      .filter((l) =>
        /^(trusted )?(mkdir|chmod|mkfifo|sleep|dbus-daemon|Xvfb|at-spi|psyche-helper|cat|stat)\b/.test(
          l,
        ),
      );
    expect(calls).toEqual([]);
  });
});
