import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * deploy/macos/make-signing-cert.sh and check-designated-requirements.sh. The check script runs
 * against a fake Psyche.app with a fake `codesign` (a file per path holds its requirement), so no
 * certificate, keychain or Mac is needed. The certificate script runs for real with openssl and a
 * password file in a temp folder; it is never given --import-to, so it touches no keychain.
 */

const MACOS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "macos");
const CHECK = join(MACOS, "check-designated-requirements.sh");
const MAKE_CERT = join(MACOS, "make-signing-cert.sh");

const HASH = "70ae89ae6be8c7e90b31e81e38ae892402b33f04";
const DESKTOP = `identifier "com.psyche.desktop" and certificate leaf = H"${HASH}"`;
const HELPER = `identifier "com.psyche.helper" and certificate leaf = H"${HASH}"`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "psyche-signing-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// POSIX shell scripts with fake codesign/plutil on PATH: macOS and Linux hosts only.
describe.skipIf(process.platform === "win32")("check-designated-requirements.sh", () => {
  let app: string;
  let state: string;
  let bin: string;
  let file: string;

  const key = (p: string) => p.replaceAll("/", "_").replaceAll(" ", "-");
  /** Sets what the fake codesign reports for `p` (a path inside the app). */
  const sign = (p: string, req: string) => writeFileSync(join(state, key(p)), req);

  beforeEach(() => {
    app = join(root, "Psyche.app");
    state = join(root, "state");
    bin = join(root, "bin");
    mkdirSync(state);
    mkdirSync(bin);
    mkdirSync(join(app, "Contents", "Resources", "PsycheHelper.app"), { recursive: true });
    mkdirSync(join(app, "Contents", "Resources", "psyched", "runtime"), { recursive: true });
    writeFileSync(join(app, "Contents", "Resources", "psyched", "runtime", "node"), "node");
    writeFileSync(join(app, "Contents", "Resources", "psyched", "addon.node"), "addon");
    writeFileSync(join(app, "Contents", "Info.plist"), "plist");
    file = join(root, "requirements.txt");
    writeFileSync(file, `# c\ndesktop\t${DESKTOP}\nhelper\t${HELPER}\n`);
    writeFileSync(
      join(bin, "codesign"),
      `#!/bin/sh
key() { printf '%s' "$1" | tr '/ ' '_-'; }
case "$1" in
  -d)
    case "$2" in
      -r-) f="$STATE/$(key "$3")"; [ -f "$f" ] && printf 'designated => %s\\n' "$(cat "$f")"; exit 0 ;;
      --entitlements) f="$STATE/$(key "$4").ent"; [ -f "$f" ] && cat "$f"; exit 0 ;;
    esac ;;
  -dv) f="$STATE/$(key "$2").noruntime"; if [ -f "$f" ]; then echo "flags=0x0(none)" >&2; else echo "flags=0x10000(runtime)" >&2; fi; exit 0 ;;
  --verify) f="$STATE/$(key "$5")"; [ -f "$f" ] && [ "$4" = "=$(cat "$f")" ] && exit 0; exit 3 ;;
esac
exit 1
`,
    );
    chmodSync(join(bin, "codesign"), 0o755);
    // PlistBuddy: the key is absent unless FAKE_QUARANTINE=1.
    writeFileSync(join(bin, "PlistBuddy"), '#!/bin/sh\n[ "$FAKE_QUARANTINE" = 1 ]\n');
    chmodSync(join(bin, "PlistBuddy"), 0o755);
    sign(app, DESKTOP);
    sign(join(app, "Contents", "Resources", "PsycheHelper.app"), HELPER);
    sign(join(app, "Contents", "Resources", "psyched", "runtime", "node"), DESKTOP);
    sign(join(app, "Contents", "Resources", "psyched", "addon.node"), DESKTOP);
  });

  const run = (extra: string[] = [], env: Record<string, string> = {}) =>
    spawnSync("bash", [CHECK, "--file", file, ...extra, app], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CODESIGN: join(bin, "codesign"),
        PLISTBUDDY: join(bin, "PlistBuddy"),
        STATE: state,
        ...env,
      },
    });

  it("passes when the app, the helper and every Gateway binary carry the pinned requirement", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/ok\s+desktop/);
    expect(r.stdout).toMatch(/ok\s+helper/);
    expect(r.stdout).toMatch(/ok\s+2 Gateway binaries/);
    expect(r.stdout).toMatch(/no LSFileQuarantineEnabled/);
  });

  it("fails when the app's requirement differs (a different certificate)", () => {
    sign(app, DESKTOP.replace(HASH, "0".repeat(40)));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL desktop: designated requirement differs/);
    expect(r.stderr).toContain(`expected: ${DESKTOP}`);
  });

  it("fails for an ad-hoc or unsigned helper", () => {
    rmSync(join(state, key(join(app, "Contents", "Resources", "PsycheHelper.app"))));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL helper: .*differs/);
    expect(r.stderr).toMatch(/unsigned or ad-hoc/);
  });

  it("fails when a native addon was left signed by another key", () => {
    sign(join(app, "Contents", "Resources", "psyched", "addon.node"), 'cdhash H"abc"');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL .*addon\.node: not signed with the release certificate/);
    expect(r.stdout).not.toMatch(/Gateway binaries .* carry the same certificate/);
  });

  const ent = (p: string, text: string) => writeFileSync(join(state, `${key(p)}.ent`), text);
  const helperPath = () => join(app, "Contents", "Resources", "PsycheHelper.app");

  it("fails when the hardened runtime is off for the app, the helper or psyched's Node", () => {
    writeFileSync(join(state, `${key(helperPath())}.noruntime`), "");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /FAIL \/Contents\/Resources\/PsycheHelper\.app: the hardened runtime is not on/,
    );
    const node = join(app, "Contents", "Resources", "psyched", "runtime", "node");
    rmSync(join(state, `${key(helperPath())}.noruntime`));
    writeFileSync(join(state, `${key(node)}.noruntime`), "");
    expect(run().stderr).toMatch(/runtime\/node: the hardened runtime is not on/);
  });

  it("fails on allow-dyld-environment-variables or get-task-allow, and on library validation off for the helper", () => {
    ent(app, "<key>com.apple.security.get-task-allow</key>");
    expect(run().stderr).toMatch(
      /Psyche\.app: has the entitlement com\.apple\.security\.get-task-allow/,
    );
    ent(app, "");
    ent(helperPath(), "<key>com.apple.security.cs.allow-dyld-environment-variables</key>");
    expect(run().stderr).toMatch(/PsycheHelper\.app: has the entitlement .*allow-dyld/);
    ent(helperPath(), "<key>com.apple.security.cs.disable-library-validation</key>");
    expect(run().stderr).toMatch(/PsycheHelper\.app has disable-library-validation/);
  });

  it("allows disable-library-validation on the app and psyched's Node (the self-signed design)", () => {
    ent(app, "<key>com.apple.security.cs.disable-library-validation</key>");
    ent(
      join(app, "Contents", "Resources", "psyched", "runtime", "node"),
      "<key>com.apple.security.cs.disable-library-validation</key>",
    );
    expect(run().status).toBe(0);
  });

  it("requires both names, and reads a last line with no trailing newline", () => {
    writeFileSync(file, `desktop\t${DESKTOP}\n`);
    const one = run();
    expect(one.status).toBe(1);
    expect(one.stderr).toMatch(/no "helper" line/);
    writeFileSync(file, `desktop\t${DESKTOP}\nhelper\t${HELPER}`);
    expect(run().status).toBe(0);
    writeFileSync(file, `helper\t${HELPER}`);
    expect(run().stderr).toMatch(/no "desktop" line/);
  });

  it("fails when Info.plist would quarantine downloaded updates", () => {
    const r = run([], { FAKE_QUARANTINE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/LSFileQuarantineEnabled/);
  });

  it("refuses (exit 3) while the file still has the certificate placeholder", () => {
    writeFileSync(
      file,
      'desktop\tidentifier "com.psyche.desktop" and certificate leaf = H"SHA1_OF_PSYCHE_RELEASE_CERT"\n',
    );
    const r = run();
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/make-signing-cert\.sh/);
  });

  it("the committed requirements file names both components and is either the template or a real hash", () => {
    const text = spawnSync("cat", [join(MACOS, "designated-requirements.txt")], {
      encoding: "utf8",
    }).stdout;
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(lines.map((l) => l.split("\t")[0])).toEqual(["desktop", "helper"]);
    for (const l of lines) {
      expect(l).toMatch(
        /\tidentifier "com\.psyche\.(desktop|helper)" and certificate leaf = H"([0-9a-f]{40}|SHA1_OF_PSYCHE_RELEASE_CERT)"$/,
      );
    }
  });
});

describe("make-signing-cert.sh", () => {
  const openssl = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";
  let pw: string;
  beforeEach(() => {
    pw = join(root, "pw");
    writeFileSync(pw, "correct horse battery staple\n", { mode: 0o600 });
  });

  const make = (args: string[]) =>
    spawnSync("bash", [MAKE_CERT, "--password-file", pw, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: root },
    });

  it.runIf(process.platform === "darwin")(
    "writes a 0600 .p12 with a code-signing certificate and prints its hashes and requirement",
    () => {
      const out = join(root, "out");
      const r = make(["--out", out]);
      expect(r.status, r.stderr).toBe(0);
      const p12 = join(out, "psyche-release.p12");
      expect(existsSync(p12)).toBe(true);
      expect(statSync(p12).mode & 0o777).toBe(0o600);
      expect(statSync(out).mode & 0o777).toBe(0o700);
      // Only the .p12 stays behind: no key or certificate PEM, no temp dir.
      expect(readdirSync(out)).toEqual(["psyche-release.p12"]);
      expect(readdirSync(root).filter((n) => n.startsWith("psyche-cert."))).toEqual([]);

      const sha1 = /SHA-1\s+([0-9a-f]{40})/.exec(r.stdout)?.[1];
      const sha256 = /SHA-256\s+([0-9a-f]{64})/.exec(r.stdout)?.[1];
      expect(sha1).toBeDefined();
      expect(sha256).toBeDefined();
      expect(r.stdout).toContain(
        `identifier "com.psyche.desktop" and certificate leaf = H"${sha1}"`,
      );
      expect(r.stdout).toContain(
        `identifier "com.psyche.helper" and certificate leaf = H"${sha1}"`,
      );
      // The password is never echoed.
      expect(r.stdout + r.stderr).not.toContain("correct horse");

      const pem = spawnSync(openssl, ["pkcs12", "-in", p12, "-nokeys", "-passin", `file:${pw}`], {
        encoding: "utf8",
      });
      expect(pem.status).toBe(0);
      const text = spawnSync(openssl, ["x509", "-noout", "-text", "-fingerprint", "-sha1"], {
        input: pem.stdout,
        encoding: "utf8",
      }).stdout;
      expect(text).toMatch(/Code Signing/);
      expect(text).toMatch(/CA:FALSE/);
      expect(text).toMatch(/CN\s*=\s*Psyche Release/);
      expect(text.replaceAll(":", "").toLowerCase()).toContain(`fingerprint=${sha1}`);
    },
  );

  it.skipIf(process.platform === "win32")("refuses to overwrite an existing .p12", () => {
    const out = join(root, "out2");
    mkdirSync(out, { mode: 0o700 });
    writeFileSync(join(out, "psyche-release.p12"), "old");
    const r = make(["--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to overwrite/);
    expect(spawnSync("cat", [join(out, "psyche-release.p12")], { encoding: "utf8" }).stdout).toBe(
      "old",
    );
  });

  // macOS-only: needs the `security` tool and the login keychain.
  it.skipIf(process.platform !== "darwin")(
    "refuses the login keychain in every spelling, short passwords, and needs --out",
    () => {
      for (const kc of [
        "login.keychain-db",
        "login",
        "login.keychain",
        "/x/y/login",
        `${root}/Library/Keychains/login.keychain-db`,
      ]) {
        const login = make(["--out", join(root, "o3"), "--import-to", kc]);
        expect(login.status, kc).toBe(1);
        expect(login.stderr, kc).toMatch(/login|system/);
      }
      expect(existsSync(join(root, "o3"))).toBe(false);

      writeFileSync(pw, "fifteen-chars-ok\n".slice(0, 15));
      const short = make(["--out", join(root, "o4")]);
      expect(short.status).toBe(1);
      expect(short.stderr).toMatch(/at least 16 characters/);

      expect(make([]).status).toBe(64);
    },
  );

  it("refuses an existing folder that is not 0700, and one inside a git work tree", () => {
    const loose = join(root, "loose");
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    const r = make(["--out", loose]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must be mode 0700/);
    expect(existsSync(join(loose, "psyche-release.p12"))).toBe(false);

    const repo = join(root, "repo");
    mkdirSync(repo);
    spawnSync("git", ["init", "-q", repo]);
    const inside = make(["--out", join(repo, "keys")]);
    expect(inside.status).toBe(1);
    expect(inside.stderr).toMatch(/inside a git work tree/);
    expect(existsSync(join(repo, "keys"))).toBe(false);
  });

  it("never puts the password or a -P flag in the script's own command lines", () => {
    const text = spawnSync("cat", [MAKE_CERT], { encoding: "utf8" }).stdout;
    expect(text).not.toMatch(/-P "\$PSYCHE_P12/);
    expect(text).not.toMatch(/-P ""/);
    expect(text).not.toMatch(/-k "\$PSYCHE_KEYCHAIN_PASSWORD"/);
    expect(text).not.toContain("/usr/bin/security");
  });
});
