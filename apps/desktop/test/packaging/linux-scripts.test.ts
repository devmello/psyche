import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * deploy/linux/psyche-system-setup (the root-run installer, tested with DESTDIR) and
 * deploy/linux/AppRun (tested with a fake PATH: notify-send and pkexec record what they get).
 * POSIX tools only, so these skip on Windows.
 */

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const SETUP = join(REPO, "deploy/linux/psyche-system-setup");
const APPRUN = join(REPO, "deploy/linux/AppRun");
const posix = process.platform !== "win32";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-linux-scripts-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (file: string, text: string | Buffer, mode = 0o644) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
};

// Built here so no policy-looking literal sits in the repo's test data.
const policy = (defaults: string, id = "com.psyche.presence", extra = "") =>
  `<?xml version="1.0"?>\n<policyconfig>\n<action id="${id}">\n<defaults>${defaults}</defaults>\n${extra}</action>\n</policyconfig>\n`;
const GOOD = [`<allow_any>auth_self</allow_any>`, `<allow_inactive>auth_self</allow_inactive>`, `<allow_active>auth_self</allow_active>`].join("");
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("rest of an elf")]);

function setup(args: string[], env: Record<string, string>, input?: Buffer) {
  const r = spawnSync("/bin/sh", [SETUP, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, input, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function payload(over: { policy?: string; sandbox?: Buffer; unit?: boolean; profile?: boolean } = {}) {
  const p = temp();
  if (over.policy !== undefined) write(join(p, "usr/share/polkit-1/actions/com.psyche.presence.policy"), over.policy);
  if (over.unit !== false) write(join(p, "usr/lib/systemd/user/psyche-gateway.service"), "[Service]\nExecStart=/x\n");
  if (over.profile !== false) write(join(p, "etc/apparmor.d/psyche"), "profile psyche {}\n");
  if (over.sandbox) write(join(p, "chrome-sandbox"), over.sandbox, 0o755);
  return p;
}

describe.skipIf(!posix)("psyche-system-setup", () => {
  it("installs the policy, unit and sandbox helper under DESTDIR with the right modes", () => {
    const d = temp();
    const p = payload({ policy: policy(GOOD), sandbox: ELF });
    const r = setup(["install", p], { DESTDIR: d });
    expect(r.code).toBe(0);
    expect(readFileSync(join(d, "usr/share/polkit-1/actions/com.psyche.presence.policy"), "utf8")).toBe(policy(GOOD));
    expect(statSync(join(d, "usr/share/polkit-1/actions/com.psyche.presence.policy")).mode & 0o7777).toBe(0o644);
    expect(existsSync(join(d, "usr/lib/systemd/user/psyche-gateway.service"))).toBe(true);
    expect(statSync(join(d, "usr/local/lib/psyche/chrome-sandbox")).mode & 0o7777).toBe(0o4755);
    expect(existsSync(join(d, "usr/local/lib/psyche/chrome-sandbox.new"))).toBe(false);
  });

  it("installs the AppArmor profile only where AppArmor 4 is", () => {
    const without = temp();
    const p = payload();
    expect(setup(["install", p], { DESTDIR: without }).code).toBe(0);
    expect(existsSync(join(without, "etc/apparmor.d/psyche"))).toBe(false);
    const withAa = temp();
    mkdirSync(join(withAa, "etc/apparmor.d/abi"), { recursive: true });
    write(join(withAa, "etc/apparmor.d/abi/4.0"), "abi\n");
    expect(setup(["install", p], { DESTDIR: withAa }).code).toBe(0);
    expect(readFileSync(join(withAa, "etc/apparmor.d/psyche"), "utf8")).toContain("profile psyche");
  });

  it("links /usr/bin/psyche-desktop to the app when it is installed", () => {
    const d = temp();
    write(join(d, "usr/lib/psyche/psyche"), "bin", 0o755);
    expect(setup(["install", payload()], { DESTDIR: d }).code).toBe(0);
    expect(execFileSync("readlink", [join(d, "usr/bin/psyche-desktop")], { encoding: "utf8" }).trim()).toBe(
      "/usr/lib/psyche/psyche",
    );
  });

  it.each([
    ["a policy that approves with no password", policy("<allow_active>yes</allow_active>"), /without a fresh password/],
    ["a policy that keeps the authorization", policy("<allow_active>auth_self_keep</allow_active>"), /without a fresh password/],
    [
      "a policy that also defines someone else's action",
      policy(GOOD).replace("</policyconfig>", `<action id="org.example.other"><defaults>${GOOD}</defaults></action>
</policyconfig>`),
      /not Psyche's/,
    ],
    ["a policy for someone else's action only", policy(GOOD, "org.example.other"), /no com.psyche action/],
    ["a policy that runs a program as root", policy(GOOD, "com.psyche.x", '<annotate key="org.freedesktop.policykit.exec.path">/bin/sh</annotate>\n'), /as root/],
    ["a policy with entities", `<!DOCTYPE x [<!ENTITY a "b">]>\n${policy(GOOD)}`, /entities/],
    ["a policy with no action", "<policyconfig/>", /no com.psyche action/],
  ])("refuses %s", (_name, text, why) => {
    const d = temp();
    const r = setup(["install", payload({ policy: text })], { DESTDIR: d });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(why);
    expect(existsSync(join(d, "usr/share/polkit-1"))).toBe(false);
  });

  it("will not make a script or a link setuid", () => {
    const d = temp();
    expect(setup(["install", payload({ sandbox: Buffer.from("#!/bin/sh\nid\n") })], { DESTDIR: d }).out).toMatch(/not an ELF/);
    expect(existsSync(join(d, "usr/local/lib/psyche/chrome-sandbox"))).toBe(false);
    const p = payload();
    symlinkSync("/bin/sh", join(p, "chrome-sandbox"));
    expect(setup(["install", p], { DESTDIR: d }).out).toMatch(/not a plain file/);
  });

  it("install-stdin reads a tar stream, and refuses links or devices inside it", () => {
    const p = payload({ policy: policy(GOOD), sandbox: ELF });
    const tar = execFileSync("tar", ["-cf", "-", "-C", p, "."], { maxBuffer: 1 << 24 });
    const d = temp();
    expect(setup(["install-stdin"], { DESTDIR: d }, tar).code).toBe(0);
    expect(existsSync(join(d, "usr/local/lib/psyche/chrome-sandbox"))).toBe(true);
    const evil = payload();
    symlinkSync("/etc/shadow", join(evil, "usr/lib/leak"));
    const bad = execFileSync("tar", ["-cf", "-", "-C", evil, "."], { maxBuffer: 1 << 24 });
    const d2 = temp();
    const r = setup(["install-stdin"], { DESTDIR: d2 }, bad);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/links or special files/);
    expect(existsSync(join(d2, "usr/lib/systemd"))).toBe(false);
  });

  it("remove takes the files out and leaves other things alone", () => {
    const d = temp();
    const p = payload({ policy: policy(GOOD), sandbox: ELF });
    setup(["install", p], { DESTDIR: d });
    write(join(d, "usr/share/polkit-1/actions/other.policy"), "keep");
    expect(setup(["remove"], { DESTDIR: d }).code).toBe(0);
    expect(existsSync(join(d, "usr/share/polkit-1/actions/com.psyche.presence.policy"))).toBe(false);
    expect(existsSync(join(d, "usr/lib/systemd/user/psyche-gateway.service"))).toBe(false);
    expect(existsSync(join(d, "usr/local/lib/psyche"))).toBe(false);
    expect(readFileSync(join(d, "usr/share/polkit-1/actions/other.policy"), "utf8")).toBe("keep");
  });

  it("shows usage for a bad command, and needs root without DESTDIR", () => {
    expect(setup(["bogus"], {}).code).toBe(64);
    expect(setup(["install"], { DESTDIR: temp() }).code).toBe(64);
    if (process.getuid?.() !== 0) expect(setup(["remove"], {}).out).toMatch(/needs root/);
  });
});

/** An app folder as the AppImage mounts it, plus a fake PATH. */
function appFolder(opts: { proc?: Record<string, string> } = {}) {
  const root = temp();
  const app = join(root, "app");
  const log = join(root, "log");
  mkdirSync(log, { recursive: true });
  mkdirSync(app, { recursive: true });
  copyFileSync(APPRUN, join(app, "AppRun"));
  chmodSync(join(app, "AppRun"), 0o755);
  write(join(app, "psyche"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}/psyche.args"\nprintf '%s' "\${CHROME_DEVEL_SANDBOX:-unset}" > "${log}/psyche.sandbox"\n`, 0o755);
  write(join(app, "chrome-sandbox"), ELF, 0o755);
  write(join(app, "resources/psyched/psyched"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}/psyched.args"\n`, 0o755);
  write(join(app, "resources/psyche-system-setup"), "#!/bin/sh\necho setup\n", 0o755);
  write(join(app, "resources/system/usr/share/polkit-1/actions/a.policy"), "p");
  write(join(app, "resources/system/usr/lib/systemd/user/psyche-gateway.service"), "unit");
  write(join(app, "resources/system/etc/apparmor.d/psyche"), "profile");
  const bin = join(root, "bin");
  write(join(bin, "notify-send"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}/notify.args"\n`, 0o755);
  write(join(bin, "pkexec"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}/pkexec.args"\ntar -tf - > "${log}/pkexec.tar"\n`, 0o755);
  const proc = join(root, "proc");
  mkdirSync(proc);
  for (const [k, v] of Object.entries(opts.proc ?? {})) write(join(proc, k), `${v}\n`);
  const run = (args: string[], env: Record<string, string> = {}, path = `${bin}:/usr/bin:/bin`) =>
    spawnSync(join(app, "AppRun"), args, {
      env: { PATH: path, PSYCHE_APPRUN_PROC: proc, PSYCHE_APPRUN_SANDBOX_DIR: join(root, "sys"), LANG: "en_US.UTF-8", ...env },
      encoding: "utf8",
    });
  const read = (f: string) => (existsSync(join(log, f)) ? readFileSync(join(log, f), "utf8") : undefined);
  return { app, root, run, read };
}

const BLOCKED = { apparmor_restrict_unprivileged_userns: "1" };

describe.skipIf(!posix)("AppRun", () => {
  it("starts the app with its arguments, and never with --no-sandbox", () => {
    const a = appFolder({ proc: { apparmor_restrict_unprivileged_userns: "0" } });
    const r = a.run(["--hidden", "psyche://x"]);
    expect(r.status).toBe(0);
    expect(a.read("psyche.args")).toBe("--hidden\npsyche://x\n");
    expect(a.read("psyche.sandbox")).toBe("unset");
    expect(a.read("psyche.args")).not.toContain("no-sandbox");
  });

  it("starts the app when the kernel files do not exist at all", () => {
    const a = appFolder();
    expect(a.run([]).status).toBe(0);
    expect(a.read("psyche.args")).toBe("\n");
  });

  it("--psyched starts the bundled Gateway and nothing else", () => {
    const a = appFolder({ proc: BLOCKED });
    expect(a.run(["--psyched", "--port", "0"]).status).toBe(0);
    expect(a.read("psyched.args")).toBe("--port\n0\n");
    expect(a.read("psyche.args")).toBeUndefined();
  });

  it("on a restricted Ubuntu without the setup it tells the owner and does not start", () => {
    const a = appFolder({ proc: BLOCKED });
    const r = a.run([], { APPIMAGE: "/home/me/Psyche.AppImage" });
    expect(r.status).toBe(1);
    expect(a.read("psyche.args")).toBeUndefined();
    expect(r.stderr).toContain("/home/me/Psyche.AppImage --setup-system");
    const notify = a.read("notify.args") ?? "";
    expect(notify).toContain("--setup-system");
    expect(notify).toContain("--app-name=Psyche");
  });

  it("also stops where the kernel has unprivileged user namespaces off", () => {
    const a = appFolder({ proc: { unprivileged_userns_clone: "0" } });
    expect(a.run([]).status).toBe(1);
  });

  it("still says it on stderr when notify-send is not installed", () => {
    const a = appFolder({ proc: BLOCKED });
    const r = a.run([], {}, "/usr/bin:/bin");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--setup-system");
  });

  it("the message is translated into all ten languages, and English otherwise", () => {
    const seen = new Map<string, string>();
    for (const lang of ["en", "ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh"]) {
      const a = appFolder({ proc: BLOCKED });
      const r = a.run([], { LANG: `${lang}_XX.UTF-8` });
      expect(r.status).toBe(1);
      seen.set(lang, r.stderr);
    }
    expect(new Set(seen.values()).size).toBe(11);
    expect(seen.get("de")).toContain("Sicherheits-Sandbox");
    expect(seen.get("ja")).toContain("サンドボックス");
    expect(seen.get("zh")).toContain("沙盒");
    const fallback = appFolder({ proc: BLOCKED }).run([], { LANG: "sv_SE.UTF-8" });
    expect(fallback.stderr).toBe(seen.get("en"));
    // LC_ALL wins over LANG.
    expect(appFolder({ proc: BLOCKED }).run([], { LANG: "de_DE", LC_ALL: "fr_FR.UTF-8" }).stderr).toContain("bac à sable");
  });

  it("a setuid-looking file that is not root's, setuid and identical does not count", () => {
    const a = appFolder({ proc: BLOCKED });
    write(join(a.root, "sys/chrome-sandbox"), ELF, 0o755); // ours, not setuid, not root's
    expect(a.run([]).status).toBe(1);
    write(join(a.root, "sys/chrome-sandbox"), Buffer.concat([ELF, Buffer.from("x")]), 0o4755);
    expect(a.run([]).status).toBe(1);
  });

  it.skipIf(!posix || process.getuid?.() !== 0)("with root's identical setuid copy it starts, pointing Chromium at it", () => {
    const a = appFolder({ proc: BLOCKED });
    write(join(a.root, "sys/chrome-sandbox"), ELF, 0o4755);
    chmodSync(join(a.root, "sys/chrome-sandbox"), 0o4755);
    expect(a.run([]).status).toBe(0);
    expect(a.read("psyche.sandbox")).toBe(join(a.root, "sys/chrome-sandbox"));
  });

  it("--setup-system pipes polkit policy and the sandbox helper (not the unit or profile) through pkexec", () => {
    const a = appFolder({ proc: BLOCKED });
    const r = a.run(["--setup-system"]);
    expect(r.status).toBe(0);
    const args = (a.read("pkexec.args") ?? "").split("\n");
    expect(args[0]).toBe("/bin/sh");
    expect(args[1]).toBe("-c");
    expect(args.slice(-3, -1)).toEqual(["psyche-system-setup", "install-stdin"]);
    expect(args.join("\n")).toContain("echo setup");
    const listing = (a.read("pkexec.tar") ?? "").split("\n");
    expect(listing).toContain("chrome-sandbox");
    expect(listing.some((l) => l.endsWith("a.policy"))).toBe(true);
    expect(listing.some((l) => l.includes("systemd") || l.includes("apparmor"))).toBe(false);
  });

  it("--setup-system without pkexec says so and fails", () => {
    const a = appFolder();
    const r = a.run(["--setup-system"], {}, "/usr/bin:/bin");
    // /usr/bin/pkexec may exist on a desktop; only assert the failure path when it does not.
    if (!existsSync("/usr/bin/pkexec") && !existsSync("/bin/pkexec")) {
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("pkexec");
    }
  });

  it("finds the app through a symlink to AppRun", () => {
    const a = appFolder();
    const link = join(a.root, "bin", "psyche-apprun");
    symlinkSync(join(a.app, "AppRun"), link);
    const r = spawnSync(link, ["x"], { env: { PATH: "/usr/bin:/bin", PSYCHE_APPRUN_PROC: join(a.root, "proc") }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(a.read("psyche.args")).toBe("x\n");
  });
});
