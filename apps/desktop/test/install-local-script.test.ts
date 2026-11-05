import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  mkdirSync(join(home, ".psyche", "state"), { recursive: true });
  writeFileSync(join(home, ".psyche", "state", "psyche.sqlite"), "marker");
  mkdirSync(join(home, "Library", "Application Support", "Psyche"), { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.psyche.gateway.plist"), "<plist/>");
}

function run(args: string[], env: Record<string, string> = {}, inRoot = false) {
  const state = join(root, "kc");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "kc-com.psyche.vault"), "");
  const res = spawnSync("/bin/bash", [SCRIPT, src, "--no-launch", ...args], {
    encoding: "utf8",
    input: "",
    cwd: inRoot ? root : undefined,
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

// Bash with fake macOS tools: runs on macOS and Linux; the Windows script has install-local-ps1.test.ts.
describe.skipIf(process.platform === "win32")("install-local.sh", () => {
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
    // Paths are shown resolved (/var is /private/var on a Mac).
    const real = realpathSync(home);
    expect(r.out).toContain(`    ${join(real, ".psyche")}\n`);
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

  it("refuses PSYCHE_HOME=$HOME// (a trailing slash must not slip past the guard)", () => {
    for (const bad of [`${home}//`, `${home}/`, home, `${home}/./`]) {
      const r = run(["--reset", "--yes"], { PSYCHE_HOME: bad });
      expect(r.code, bad).toBe(1);
      expect(r.out).toContain("refusing to delete");
      expect(existsSync(data()), bad).toBe(true);
      expect(installed()).toBe("old build");
    }
  });

  it("refuses folders outside the home folder, ancestors of it, and the personal folders", () => {
    const outside = join(root, "elsewhere");
    mkdirSync(join(outside, "state"), { recursive: true });
    writeFileSync(join(outside, "state", "psyche.sqlite"), "x");
    for (const d of ["Documents", "Desktop", "Downloads", "Library"]) {
      mkdirSync(join(home, d, "state"), { recursive: true });
      writeFileSync(join(home, d, "state", "psyche.sqlite"), "x");
    }
    for (const bad of [
      root, // an ancestor of HOME
      dirname(home),
      "/",
      "/Users",
      "/Applications",
      "/Volumes",
      outside,
      join(home, "Documents"),
      join(home, "Desktop"),
      join(home, "Downloads"),
      join(home, "Library"),
      "relative/path",
    ]) {
      if (bad === "relative/path") mkdirSync(join(root, "relative", "path"), { recursive: true });
      const r = run(["--reset", "--yes"], { PSYCHE_HOME: bad }, bad === "relative/path");
      expect(r.code, bad).toBe(1);
      expect(r.out, bad).toContain("refusing");
      expect(existsSync(data()), bad).toBe(true);
    }
  });

  it("refuses a folder with no Psyche marker file", () => {
    const f = join(home, "photos");
    mkdirSync(f);
    writeFileSync(join(f, "a.jpg"), "x");
    const r = run(["--reset", "--yes"], { PSYCHE_HOME: f });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no Psyche marker");
    expect(existsSync(join(f, "a.jpg"))).toBe(true);
  });

  it("accepts a marker of config.json", () => {
    const f = join(home, "custom-psyche");
    mkdirSync(f);
    writeFileSync(join(f, "config.json"), "{}");
    const r = run(["--reset"], { PSYCHE_HOME: f, FAKE_TTY: "1" });
    // Not a terminal, so it stops at the question, but the guard passed and listed it.
    expect(r.out).toContain(f);
    expect(r.out).toContain("needs a terminal");
  });

  it("refuses --yes when the folder is not the default ~/.psyche", () => {
    const f = join(home, "custom-psyche");
    mkdirSync(join(f, "state"), { recursive: true });
    writeFileSync(join(f, "state", "psyche.sqlite"), "x");
    const r = run(["--reset", "--yes"], { PSYCHE_HOME: f });
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing --yes");
    expect(existsSync(f)).toBe(true);
  });

  it("prefers the data folder in the LaunchAgent plist and warns when PSYCHE_HOME differs", () => {
    const other = join(home, "other-env");
    mkdirSync(join(other, "state"), { recursive: true });
    writeFileSync(join(other, "state", "psyche.sqlite"), "x");
    writeFileSync(
      join(home, "Library", "LaunchAgents", "com.psyche.gateway.plist"),
      `<plist><dict><key>EnvironmentVariables</key><dict>\n<key>PSYCHE_HOME</key>\n<string>${join(home, ".psyche")}</string>\n</dict></dict></plist>`,
    );
    const r = run(["--reset", "--yes"], { PSYCHE_HOME: other });
    expect(r.out).toContain("differs from the LaunchAgent");
    expect(existsSync(join(home, ".psyche"))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("keeps going past a path it cannot remove, then reports it and exits non-zero", () => {
    const caches = join(home, "Library", "Caches");
    const stuck = join(caches, "Psyche");
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, "f"), "x");
    chmodSync(caches, 0o555);
    try {
      const r = run(["--reset", "--yes"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("could not be removed");
      expect(r.out).toContain(stuck);
      // The rest still went, and the new build is in.
      expect(existsSync(join(home, ".psyche"))).toBe(false);
      expect(installed()).toBe("new build");
    } finally {
      chmodSync(caches, 0o755);
    }
  });

  it("checks each fixed path again after the stop (one that vanished is not an error)", () => {
    const r = run(["--reset", "--yes"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("could not be removed");
  });

  it("only talks to the fakes: launchctl is never given the real agent to boot out", () => {
    // The fake launchctl reports the agent as not loaded, so the script must not bootout.
    const r = run([]);
    expect(r.calls).toContain("launchctl print");
    expect(r.calls).not.toContain("launchctl bootout");
  });
});
