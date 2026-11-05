import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * deploy/macos/install-local.sh against a temporary HOME and a temporary "/Applications", with
 * fake launchctl, security, codesign, pgrep and friends first on PATH. Nothing here can reach the
 * real /Applications/Psyche.app, the real com.psyche.gateway agent, the real Keychain or the real
 * ~/.psyche: the fakes only write to a log file.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "deploy",
  "macos",
  "install-local.sh",
);

let root: string;
let home: string;
let apps: string;
let bin: string;
let log: string;
let src: string;

const FAKES: Record<string, string> = {
  // Never loaded, never running.
  launchctl: "exit 1",
  pgrep: "exit 1",
  pkill: "exit 0",
  osascript: "exit 0",
  open: "exit 0",
  defaults: "exit 0",
  xattr: "exit 0",
  codesign: "exit 0",
  hdiutil: "exit 0",
  // The "Keychain": a service exists while its marker file does.
  security: `
state="$FAKE_STATE"
cmd="$1"; shift
svc=""
while [ $# -gt 0 ]; do if [ "$1" = "-s" ]; then svc="$2"; shift; fi; shift; done
case "$cmd" in
  find-generic-password) [ -e "$state/kc-$svc" ] ;;
  delete-generic-password) rm -f "$state/kc-$svc" ;;
esac`,
  ditto: 'rm -rf "$2" && cp -R "$1" "$2"',
};

function setup(): void {
  root = mkdtempSync(join(tmpdir(), "psyche-install-test-"));
  home = join(root, "home");
  apps = join(root, "Applications");
  bin = join(root, "bin");
  log = join(root, "calls.log");
  src = join(root, "build", "Psyche.app");
  for (const d of [home, apps, bin, join(src, "Contents")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, "Contents", "marker"), "new build");
  writeFileSync(log, "");
  for (const [name, body] of Object.entries(FAKES)) {
    const f = join(bin, name);
    writeFileSync(f, `#!/bin/bash\necho "${name} $*" >> "$FAKE_LOG"\n${body}\n`);
    chmodSync(f, 0o755);
  }
  // An existing install and existing owner data, all under the temporary home.
  mkdirSync(join(apps, "Psyche.app", "Contents"), { recursive: true });
  writeFileSync(join(apps, "Psyche.app", "Contents", "marker"), "old build");
  mkdirSync(join(home, ".psyche"), { recursive: true });
  writeFileSync(join(home, ".psyche", "psyche.db"), "chats");
  mkdirSync(join(home, "Library", "Application Support", "Psyche"), { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.psyche.gateway.plist"), "<plist/>");
}

function run(args: string[], env: Record<string, string> = {}) {
  const state = join(root, "kc");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "kc-com.psyche.vault"), "");
  const res = spawnSync("/bin/bash", [SCRIPT, src, "--no-launch", ...args], {
    encoding: "utf8",
    input: "",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      PSYCHE_INSTALL_DIR: apps,
      FAKE_LOG: log,
      FAKE_STATE: state,
      ...env,
    },
  });
  return {
    code: res.status,
    out: `${res.stdout}${res.stderr}`,
    calls: readFileSync(log, "utf8"),
    keychain: existsSync(join(state, "kc-com.psyche.vault")),
  };
}

const data = () => join(home, ".psyche", "psyche.db");
const installed = () => readFileSync(join(apps, "Psyche.app", "Contents", "marker"), "utf8");

beforeEach(setup);
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("install-local.sh", () => {
  it("keeps your data by default and installs the new build", () => {
    const r = run([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Keeping your data");
    expect(existsSync(data())).toBe(true);
    expect(existsSync(join(home, "Library", "Application Support", "Psyche"))).toBe(true);
    expect(r.keychain).toBe(true);
    expect(installed()).toBe("new build");
    expect(r.calls).not.toContain("delete-generic-password");
  });

  it("--keep-data is accepted and changes nothing", () => {
    const r = run(["--keep-data"]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(data())).toBe(true);
  });

  it("a dry run changes nothing, with or without --reset", () => {
    for (const args of [["--dry-run"], ["--dry-run", "--reset"]]) {
      const r = run(args);
      expect(r.code, r.out).toBe(0);
      expect(existsSync(data())).toBe(true);
      expect(r.keychain).toBe(true);
      expect(installed()).toBe("old build");
    }
  });

  it("--reset prints exactly what it will delete", () => {
    const r = run(["--dry-run", "--reset"]);
    expect(r.out).toContain("PERMANENTLY DELETE");
    expect(r.out).toContain(`    ${join(home, ".psyche")}\n`);
    expect(r.out).toContain(`    ${join(home, "Library", "Application Support", "Psyche")}\n`);
    expect(r.out).toContain(
      `    ${join(home, "Library", "LaunchAgents", "com.psyche.gateway.plist")}\n`,
    );
    expect(r.out).toContain("Keychain item(s) for service com.psyche.vault");
    // Only what exists is listed.
    expect(r.out).not.toContain("com.psyche.helper.plist");
  });

  it("--reset without --yes and without a terminal cancels before anything is stopped or deleted", () => {
    const r = run(["--reset"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("needs a terminal to confirm");
    expect(existsSync(data())).toBe(true);
    expect(r.keychain).toBe(true);
    expect(installed()).toBe("old build");
    expect(r.calls).not.toContain("launchctl bootout");
  });

  it("--reset --yes wipes the data (under the temporary home) and installs", () => {
    const r = run(["--reset", "--yes"]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(home, ".psyche"))).toBe(false);
    expect(existsSync(join(home, "Library", "Application Support", "Psyche"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.psyche.gateway.plist"))).toBe(
      false,
    );
    expect(r.keychain).toBe(false);
    expect(installed()).toBe("new build");
  });

  it("refuses to treat the home folder as PSYCHE_HOME", () => {
    const r = run(["--reset", "--yes"], { PSYCHE_HOME: home });
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to delete");
    expect(existsSync(data())).toBe(true);
  });

  it("only talks to the fakes: launchctl is never given the real agent to boot out", () => {
    // The fake launchctl reports the agent as not loaded, so the script must not bootout.
    const r = run([]);
    expect(r.calls).toContain("launchctl print");
    expect(r.calls).not.toContain("launchctl bootout");
  });
});
