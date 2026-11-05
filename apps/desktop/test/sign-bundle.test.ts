import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
 * deploy/macos/sign-bundle.sh against a fake Psyche.app (real Mach-O stubs copied from /usr/bin/true)
 * and a fake `codesign` that only logs its arguments: the order, entitlements and flags are the
 * contract the release `sign` job and build-local.sh share.
 */

const MACOS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "macos");
const SCRIPT = join(MACOS, "sign-bundle.sh");
const HASH = "70ae89ae6be8c7e90b31e81e38ae892402b33f04";
const REQ = `identifier "com.psyche.desktop" and certificate leaf = H"${HASH}"`;

let root: string;
let app: string;
let log: string;
let codesign: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "psyche-signbundle-"));
  app = join(root, "Psyche.app");
  log = join(root, "codesign.log");
  codesign = join(root, "codesign");
  writeFileSync(codesign, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(codesign, 0o755);
  const macho = (rel: string) => {
    const f = join(app, rel);
    mkdirSync(dirname(f), { recursive: true });
    copyFileSync("/usr/bin/true", f);
    chmodSync(f, 0o755);
  };
  macho("Contents/MacOS/Psyche");
  macho("Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework");
  macho("Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib");
  macho("Contents/Frameworks/Psyche Helper.app/Contents/MacOS/Psyche Helper");
  macho("Contents/Resources/PsycheHelper.app/Contents/MacOS/psyche-helper");
  macho("Contents/Resources/psyched/runtime/node");
  macho("Contents/Resources/psyched/app/node_modules/x/x.node");
  macho("Contents/Resources/app.asar.unpacked/node_modules/node-pty/pty.node");
  writeFileSync(join(app, "Contents/Resources/psyched/psyched"), "#!/bin/sh\n");
  chmodSync(join(app, "Contents/Resources/psyched/psyched"), 0o755);
  writeFileSync(join(root, "reqs.txt"), `desktop\t${REQ}\nhelper\tx\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (args: string[]) =>
  spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", CODESIGN: codesign },
  });
const calls = () => readFileSync(log, "utf8").trim().split("\n");
const target = (line: string) =>
  line
    .slice(line.lastIndexOf(" --sign ") + 8)
    .split(" ")
    .slice(1)
    .join(" ");

describe.runIf(process.platform === "darwin")("sign-bundle.sh", () => {
  it("signs inside out with the hardened runtime, the right entitlements and the pinned requirement", () => {
    const r = run([
      "--app",
      app,
      "--identity",
      HASH,
      "--keychain",
      "/k/ci.keychain-db",
      "--timestamp",
      "--requirements",
      join(root, "reqs.txt"),
    ]);
    expect(r.status, r.stderr).toBe(0);
    const c = calls().filter((l) => !l.startsWith("--verify"));
    const idx = (needle: string) => c.findIndex((l) => l.endsWith(needle));
    // Every signing call: hardened runtime, the keychain, the identity, a timestamp.
    for (const l of c) {
      expect(l).toContain("--options runtime");
      expect(l).toContain("--timestamp");
      expect(l).toContain("--keychain /k/ci.keychain-db");
      expect(l).toContain(`--sign ${HASH}`);
    }
    // Gateway files first, with the two-key entitlements.
    const node = c[idx("psyched/runtime/node")] ?? "";
    expect(node).toContain("entitlements.self-signed.psyched.plist");
    expect(c[idx("x.node")]).toContain("entitlements.self-signed.psyched.plist");
    // Electron and node-pty with the app's.
    expect(c[idx("Libraries/libffmpeg.dylib")]).toContain("entitlements.self-signed.plist");
    expect(c[idx("pty.node")]).toContain("entitlements.self-signed.plist");
    // The Mac helper has its own entitlements and identifier, and is NOT given the app's.
    const helper = c[idx("Resources/PsycheHelper.app")] ?? "";
    expect(helper).toContain("PsycheHelper.entitlements");
    expect(helper).toContain("--identifier com.psyche.helper");
    expect(helper).not.toContain("self-signed");
    // The inner helper executable was not signed on its own with the app's entitlements.
    expect(c.some((l) => l.endsWith("PsycheHelper.app/Contents/MacOS/psyche-helper"))).toBe(false);
    // The app is last, with the pinned requirement.
    const last = c[c.length - 1] ?? "";
    expect(last).toContain(`-r=designated => ${REQ}`);
    expect(last.endsWith(app.replace("/private", ""))).toBe(true);
    // Order: gateway, then nested Electron code, then the bundles, then the helper, then the app.
    expect(idx("psyched/runtime/node")).toBeLessThan(idx("Electron Framework.framework"));
    expect(idx("Psyche Helper.app")).toBeLessThan(idx("Resources/PsycheHelper.app"));
    expect(idx("Resources/PsycheHelper.app")).toBeLessThan(c.length - 1);
    expect(calls().some((l) => l.startsWith("--verify --deep --strict"))).toBe(true);
    expect(target(node)).toBeTruthy();
  });

  it("uses no timestamp by default and no requirement while the file is the placeholder", () => {
    writeFileSync(
      join(root, "ph.txt"),
      'desktop\tidentifier "x" and certificate leaf = H"SHA1_OF_PSYCHE_RELEASE_CERT"\n',
    );
    const r = run([
      "--app",
      app,
      "--identity",
      "Psyche Release",
      "--requirements",
      join(root, "ph.txt"),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/no pinned requirement/);
    for (const l of calls().filter((x) => !x.startsWith("--verify"))) {
      expect(l).toContain("--timestamp=none");
      expect(l).not.toContain("-r=");
    }
  });

  it("refuses a hash that is not the pinned one", () => {
    const r = run([
      "--app",
      app,
      "--identity",
      "0".repeat(40),
      "--requirements",
      join(root, "reqs.txt"),
    ]);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/not the SHA-1 pinned/);
    expect(
      run([
        "--app",
        app,
        "--identity",
        HASH.toUpperCase(),
        "--requirements",
        join(root, "reqs.txt"),
      ]).status,
    ).toBe(0);
  });

  it("refuses a Developer ID, another name, a short hash and a missing app", () => {
    for (const id of ["Developer ID Application: X (TEAM)", "Some Cert", "70ae89ae"]) {
      const r = run(["--app", app, "--identity", id]);
      expect(r.status, id).toBe(64);
    }
    expect(run(["--app", join(root, "nope.app"), "--identity", HASH]).status).toBe(64);
  });
});
