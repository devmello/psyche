import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGatewayUnit } from "../src/systemd-unit.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

/**
 * The psyche-server packaging (deploy/linux-server; linux-helper-only design §3.2, wave B1): the
 * units it ships, the tarball's release layout, and the manifest names. The packages themselves
 * are built and installed on Linux (the PR lists those runs).
 */

const deploy = resolve(import.meta.dirname, "../../../deploy");
type Mod = Record<string, unknown>;
const build = (await import(join(deploy, "linux-server/build.mjs"))) as Mod;
const inst = (await import(join(deploy, "linux-server/install.mjs"))) as Mod;
const manifest = (await import(join(deploy, "scripts/update-manifest.mjs"))) as Mod;
const bp = (await import(join(deploy, "scripts/build-psyched.mjs"))) as Mod;

const call = <T>(m: Mod, name: string, ...args: unknown[]): T =>
  (m[name] as unknown as (...a: unknown[]) => T)(...args);

afterEach(cleanupTempDirs);

const B0_UNIT = `# psyche-helper-headless.service (B0)
[Unit]
Description=Psyche helper on a computer without a screen

[Service]
Type=simple
ExecStart="/usr/lib/psyche/resources/linux-helper/psyche-helper" --display headless
Restart=no
`;

describe("the headless helper unit is B0's, run from the server package's helper", () => {
  const helper = '"/usr/lib/psyche-server/psyche-helper"';
  const execOf = (text: string) => /^ExecStart=(.*)$/m.exec(text)?.[1];

  const mustAccept: [string, string, string][] = [
    ["a quoted desktop path with arguments", B0_UNIT, `${helper} --display headless`],
    [
      "a bare path",
      "[Service]\nExecStart=/usr/bin/psyche-helper --display headless --idle-exit 300\n",
      `${helper} --display headless --idle-exit 300`,
    ],
    ["no arguments", '[Service]\nExecStart="/opt/x/psyche-helper"\n', helper],
  ];
  it.each(mustAccept)("must accept: %s", (_n, text, want) => {
    expect(execOf(call<string>(build, "headlessUnitFor", text, helper))).toBe(want);
  });

  const mustRefuse: [string, string][] = [
    ["no ExecStart", "[Service]\nType=simple\n"],
    ["two ExecStart lines", `${B0_UNIT}ExecStart=/usr/bin/psyche-helper\n`],
    ["another program", '[Service]\nExecStart="/usr/bin/psyche-helperx" --display headless\n'],
    ["a shell wrapper", "[Service]\nExecStart=/bin/sh -c psyche-helper\n"],
    [
      "a helper inside a quoted shell line",
      '[Service]\nExecStart="/bin/sh" "-c" "psyche-helper"\n',
    ],
  ];
  it.each(mustRefuse)("must refuse: %s", (_n, text) => {
    expect(() => call(build, "headlessUnitFor", text, helper)).toThrow();
  });

  it("renders the Gateway's unit with the shared renderer, pointing into the package", async () => {
    const units = await call<Promise<Record<string, string>>>(build, "renderUnits", {
      psyched: "/usr/lib/psyche-server/psyched/psyched",
      helper: "/usr/lib/psyche-server/psyche-helper",
      headlessTemplate: B0_UNIT,
    });
    const gateway = parseGatewayUnit(units["psyche-gateway.service"] as string);
    expect(gateway?.program).toBe("/usr/lib/psyche-server/psyched/psyched");
    // No PSYCHE_HOME: psyched uses each user's own ~/.psyche.
    expect(gateway?.env).toEqual({});
    expect(units["psyche-gateway.service"]).toMatch(/^WantedBy=default.target$/m);
    expect(execOf(units["psyche-helper-headless.service"] as string)).toBe(
      '"/usr/lib/psyche-server/psyche-helper" --display headless',
    );
  });
});

describe("package metadata", () => {
  it("conflicts with the desktop package and sorts pre-releases first", () => {
    expect(build.DESKTOP_PACKAGE).toBe("psyche");
    expect(build.SERVER_HELPER).toBe("/usr/lib/psyche-server/psyche-helper");
    expect(call(build, "packageVersion", "1.2.0")).toBe("1.2.0");
    expect(call(build, "packageVersion", "1.2.0-alpha.3")).toBe("1.2.0~alpha.3");
    for (const bad of ["1.2", "v1.2.0", "1.2.0 ", "../1.2.0"])
      expect(() => call(build, "packageVersion", bad)).toThrow();
  });

  it("the maintainer scripts never remove ~/.psyche and turn on linger only for the sudo user", () => {
    for (const s of [build.POSTINST, build.PRERM, build.POSTRM] as unknown as string[]) {
      expect(s).not.toMatch(/rm\s+-[a-z]*r/);
      expect(s).toMatch(/^exit 0$/m);
    }
    expect(build.POSTINST).toContain('loginctl enable-linger "$u"');
    expect(build.POSTINST).toContain('u="${SUDO_USER:-}"');
  });

  it("release keys come as a checked list", async () => {
    const dir = tempDir();
    const good = join(dir, "keys.json");
    writeFileSync(
      good,
      JSON.stringify([
        { keyId: "37312dba0e2eddad", publicKey: "hbM9GyfYsfhRfSZX6E6QimBS7GqkV2CMlDpVdxolxNk=" },
      ]),
    );
    expect(await call<Promise<unknown[]>>(build, "releaseKeys", good)).toHaveLength(1);
    const bads: unknown[] = [
      [{ keyId: "0000000000000000", publicKey: "hbM9GyfYsfhRfSZX6E6QimBS7GqkV2CMlDpVdxolxNk=" }],
      [
        {
          keyId: "37312dba0e2eddad",
          publicKey: "hbM9GyfYsfhRfSZX6E6QimBS7GqkV2CMlDpVdxolxNk=",
          x: 1,
        },
      ],
      { keyId: "37312dba0e2eddad" },
    ];
    for (const bad of bads) {
      const f = join(dir, `bad-${Math.random()}.json`);
      writeFileSync(f, JSON.stringify(bad));
      await expect(call<Promise<unknown>>(build, "releaseKeys", f)).rejects.toThrow();
    }
  });
});

describe("the Linux psyched bundle (build-psyched.mjs)", () => {
  it("its launchers keep the hardening and cache under XDG, outside the root-owned tree", () => {
    for (const name of ["PSYCHED_LAUNCHER_LINUX", "PSYCHE_LAUNCHER_LINUX"]) {
      const text = bp[name] as string;
      expect(text).toMatch(/^unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE$/m);
      expect(text).toContain('--require "$here/psyched-harden.cjs"');
      expect(text).toContain('"$XDG_CACHE_HOME/psyche/node-compile-cache"');
      expect(text).toContain('"$HOME/.cache/psyche/node-compile-cache"');
      expect(text).not.toContain("Library/Caches");
    }
  });
  it("an addon must be an ELF of the bundle's arch", () => {
    const ok = (out: string, arch: string) => call<boolean>(bp, "addonMatches", out, arch, "linux");
    const arm = "ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV), dynamically linked";
    const x86 = "ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked";
    expect(ok(arm, "arm64")).toBe(true);
    expect(ok(x86, "x64")).toBe(true);
    expect(ok(arm, "x64")).toBe(false);
    expect(ok(x86, "arm64")).toBe(false);
    expect(ok("Mach-O 64-bit bundle arm64", "arm64")).toBe(false);
    expect(ok("ELF 32-bit LSB shared object, ARM, EABI5", "arm64")).toBe(false);
    expect(call<boolean>(bp, "addonMatches", "Mach-O 64-bit bundle arm64", "arm64")).toBe(true);
  });
});

describe("manifest names (update-manifest.mjs, server section)", () => {
  it("names what classifyArtifact files as the server kinds", () => {
    for (const [format, kind] of Object.entries(
      manifest.SERVER_FORMATS as Record<string, string>,
    )) {
      const name = call<string>(manifest, "serverArtifactName", "1.4.0", "x64", format);
      expect(call(manifest, "classifyArtifact", name)).toEqual({
        platform: "linux",
        kind,
        arch: "x64",
      });
    }
    for (const args of [
      ["1.4", "x64", "deb"],
      ["1.4.0", "amd64", "deb"],
      ["1.4.0", "x64", "zip"],
      ["1.4.0", "x64", "constructor"],
    ])
      expect(() => call(manifest, "serverArtifactName", ...args)).toThrow();
  });

  it("server-check wants every format once per arch, all of this release", () => {
    const entry = (name: string, kind: string) => ({
      name,
      kind,
      sha256: "0".repeat(64),
      bytes: 1,
    });
    const all = (v: string, arch: string) => [
      entry(`psyche-server-${v}-linux-${arch}.deb`, "server-deb"),
      entry(`psyche-server-${v}-linux-${arch}.rpm`, "server-rpm"),
      entry(`psyche-server-${v}-linux-${arch}.tar.zst`, "server-tar-zst"),
    ];
    const text = (platforms: Record<string, unknown[]>) =>
      JSON.stringify({ release: "1.4.0", platforms });
    const ok = call<Record<string, unknown>>(
      manifest,
      "serverEntriesOf",
      text({ "linux-x64": all("1.4.0", "x64"), "linux-arm64": [] }),
    );
    expect(Object.keys(ok)).toEqual(["x64"]);
    // A helper-only file under the same key does not count either way.
    expect(() =>
      call(
        manifest,
        "serverEntriesOf",
        text({
          "linux-x64": [
            ...all("1.4.0", "x64"),
            entry("psyche-helper-1.4.0-linux-x64.deb", "helper-deb"),
          ],
        }),
      ),
    ).not.toThrow();
    const bads: Record<string, unknown[]>[] = [
      { "linux-x64": all("1.4.0", "x64").slice(0, 2) },
      { "linux-x64": [...all("1.4.0", "x64"), all("1.4.0", "x64")[0]] },
      { "linux-x64": all("1.3.9", "x64") },
      { "linux-arm64": all("1.4.0", "x64") },
    ];
    for (const bad of bads) expect(() => call(manifest, "serverEntriesOf", text(bad))).toThrow();
  });
});

/** An unpacked tarball release (what install.mjs installs). */
function release(
  dir: string,
  version: string,
  unitBody = 'ExecStart="@PSYCHE_SERVER_ROOT@/current/psyched/psyched"\n',
) {
  const r = join(dir, `psyche-server-${version}-linux-x64`);
  mkdirSync(join(r, "psyched"), { recursive: true });
  mkdirSync(join(r, "units"));
  writeFileSync(join(r, "psyched", "psyche"), "#!/bin/sh\n");
  writeFileSync(join(r, "psyched", "psyched"), "#!/bin/sh\n");
  writeFileSync(
    join(r, "psyche-server.json"),
    JSON.stringify({ format: "psyche-server-install", kind: "tarball", version, arch: "x64" }),
  );
  for (const u of ["psyche-gateway.service", "psyche-helper-headless.service"])
    writeFileSync(join(r, "units", `${u}.in`), `[Service]\n${unitBody}`);
  return r;
}

describe("the tarball's release layout (install.mjs)", () => {
  const layout = () => {
    const d = tempDir();
    return {
      d,
      root: join(d, "home", ".local", "lib", "psyche-server"),
      unitDir: join(d, "home", ".config", "systemd", "user"),
      binDir: join(d, "home", ".local", "bin"),
    };
  };
  const target = (p: string) => readlinkSync(p);

  it("escapes a release root for a quoted ExecStart, and refuses control characters", () => {
    const rows: [string, string][] = [
      ["/home/a/.local/lib/psyche-server", "/home/a/.local/lib/psyche-server"],
      ["/home/my user/x", "/home/my user/x"],
      ['/home/a"b/x', '/home/a\\"b/x'],
      ["/home/a\\b/x", "/home/a\\\\b/x"],
      ["/home/100%/x", "/home/100%%/x"],
      ["/home/$USER/x", "/home/$$USER/x"],
    ];
    for (const [given, want] of rows) expect(call(inst, "sdEscape", given)).toBe(want);
    for (const bad of ["/home/a\nExecStartPre=/bin/evil", "/home/a\tb", "/home/\u0000"])
      expect(() => call(inst, "sdEscape", bad)).toThrow();
  });

  it("installs, then activate keeps exactly current and previous, by renaming links", () => {
    const l = layout();
    const r1 = release(l.d, "1.4.0");
    const first = call<Record<string, unknown>>(inst, "install", {
      ...l,
      from: r1,
      exists: () => false,
    });
    expect(first).toMatchObject({ current: "1.4.0" });
    expect(target(join(l.root, "current"))).toBe(join("releases", "1.4.0"));
    expect(existsSync(join(l.root, "previous"))).toBe(false);
    expect(target(join(l.binDir, "psyched"))).toBe(join(l.root, "current", "psyched", "psyched"));
    const unit = readFileSync(join(l.unitDir, "psyche-gateway.service"), "utf8");
    expect(unit.startsWith(inst.UNIT_MARKER as string)).toBe(true);
    expect(unit).toContain(`ExecStart="${l.root}/current/psyched/psyched"`);

    for (const v of ["1.5.0", "1.6.0"]) {
      const r = release(l.d, v);
      const dest = join(l.root, "releases", v);
      call(inst, "install", { ...l, from: r, exists: () => false });
      expect(existsSync(dest)).toBe(true);
    }
    expect(call(inst, "status", l.root)).toEqual({
      current: "1.6.0",
      previous: "1.5.0",
      releases: ["1.5.0", "1.6.0"],
    });
    expect(call(inst, "rollback", l)).toEqual({ current: "1.5.0", previous: "1.6.0" });
    expect(target(join(l.root, "current"))).toBe(join("releases", "1.5.0"));
    expect(lstatSync(join(l.root, "current")).isSymbolicLink()).toBe(true);
    // No temporary links left behind.
    expect(
      (call<{ releases: string[] }>(inst, "status", l.root).releases ?? []).every((n) =>
        /^\d/.test(n),
      ),
    ).toBe(true);
  });

  it("refuses next to the deb/rpm or the desktop package (two Gateways on one ~/.psyche)", () => {
    const l = layout();
    const r1 = release(l.d, "1.4.0");
    for (const present of ["/usr/lib/psyche-server", "/usr/lib/psyche"]) {
      expect(() =>
        call(inst, "install", { ...l, from: r1, exists: (p: string) => p === present }),
      ).toThrow(/cannot share ~\/\.psyche/);
    }
    expect(existsSync(l.root)).toBe(false);
  });

  it("never overwrites a unit or a command it did not write", () => {
    const l = layout();
    mkdirSync(l.unitDir, { recursive: true });
    writeFileSync(join(l.unitDir, "psyche-gateway.service"), "# written by psyche start\n");
    expect(() =>
      call(inst, "install", { ...l, from: release(l.d, "1.4.0"), exists: () => false }),
    ).toThrow(/not written by the psyche-server installer/);
    expect(readFileSync(join(l.unitDir, "psyche-gateway.service"), "utf8")).toBe(
      "# written by psyche start\n",
    );

    const m = layout();
    mkdirSync(m.binDir, { recursive: true });
    symlinkSync("/home/u/checkout/psyche", join(m.binDir, "psyche"));
    const done = call<{ skipped: string[] }>(inst, "install", {
      ...m,
      from: release(m.d, "1.4.0"),
      exists: () => false,
    });
    expect(done.skipped).toEqual([join(m.binDir, "psyche")]);
    expect(target(join(m.binDir, "psyche"))).toBe("/home/u/checkout/psyche");
  });

  it("activate refuses a folder that is not that version's tarball, and a missing previous", () => {
    const l = layout();
    call(inst, "install", { ...l, from: release(l.d, "1.4.0"), exists: () => false });
    expect(() => call(inst, "rollback", l)).toThrow(/no previous release/);
    const odd = join(l.root, "releases", "1.5.0");
    mkdirSync(odd, { recursive: true });
    writeFileSync(
      join(odd, "psyche-server.json"),
      JSON.stringify({
        format: "psyche-server-install",
        kind: "deb",
        version: "1.5.0",
        arch: "x64",
      }),
    );
    expect(() => call(inst, "activate", { ...l, version: "1.5.0" })).toThrow();
    expect(() => call(inst, "activate", { ...l, version: "../1.4.0" })).toThrow();
    expect(target(join(l.root, "current"))).toBe(join("releases", "1.4.0"));
  });

  it("activate removes only releases and leftovers it made: the owner's files under --root stay", () => {
    const l = layout();
    call(inst, "install", { ...l, from: release(l.d, "1.4.0"), exists: () => false });
    const rel = join(l.root, "releases");
    // The owner's own things, and look-alikes that are not a tarball release.
    mkdirSync(join(rel, "my-thesis-drafts"), { recursive: true });
    writeFileSync(join(rel, "my-thesis-drafts", "chapter1.md"), "# One\n");
    writeFileSync(join(rel, "notes.txt"), "keep me\n");
    mkdirSync(join(rel, "1.0.0"));
    writeFileSync(join(rel, "1.0.0", "photo.jpg"), "jpg");
    mkdirSync(join(rel, "1.1.0"));
    writeFileSync(
      join(rel, "1.1.0", "psyche-server.json"),
      JSON.stringify({
        format: "psyche-server-install",
        kind: "deb",
        version: "1.1.0",
        arch: "x64",
      }),
    );
    writeFileSync(join(rel, "1.2.0"), "a file named like a release");
    // This installer's own: an older tarball release and a dead staging folder.
    cpSyncDir(release(l.d, "1.3.0"), join(rel, "1.3.0"));
    mkdirSync(join(rel, ".incoming-1.9.0-999999999"));
    mkdirSync(join(rel, "1.3.0.old-999999999"));
    for (const v of ["1.5.0", "1.6.0"])
      call(inst, "install", { ...l, from: release(l.d, v), exists: () => false });
    expect(readFileSync(join(rel, "my-thesis-drafts", "chapter1.md"), "utf8")).toBe("# One\n");
    expect(readFileSync(join(rel, "notes.txt"), "utf8")).toBe("keep me\n");
    for (const kept of ["1.0.0/photo.jpg", "1.1.0/psyche-server.json", "1.2.0", "1.5.0", "1.6.0"])
      expect(existsSync(join(rel, kept)), kept).toBe(true);
    for (const gone of ["1.3.0", "1.4.0", ".incoming-1.9.0-999999999", "1.3.0.old-999999999"])
      expect(existsSync(join(rel, gone)), gone).toBe(false);
  });

  it("install refuses a non-empty --root it did not make; activate and rollback need the marker", () => {
    const l = layout();
    mkdirSync(join(l.root, "releases"), { recursive: true });
    writeFileSync(join(l.root, "releases", "notes.txt"), "mine\n");
    expect(() =>
      call(inst, "install", { ...l, from: release(l.d, "1.4.0"), exists: () => false }),
    ).toThrow(/not a psyche-server install folder/);
    expect(readFileSync(join(l.root, "releases", "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(l.root, inst.ROOT_MARKER as string))).toBe(false);
    expect(() => call(inst, "activate", { ...l, version: "1.4.0" })).toThrow(/not a psyche-server/);
    expect(() => call(inst, "rollback", l)).toThrow(/not a psyche-server/);
    // An empty folder is fine.
    const e = layout();
    mkdirSync(e.root, { recursive: true });
    call(inst, "install", { ...e, from: release(e.d, "1.4.0"), exists: () => false });
    expect(existsSync(join(e.root, inst.ROOT_MARKER as string))).toBe(true);
  });

  it("a refused activate or rollback leaves current and previous as they were", () => {
    const l = layout();
    for (const v of ["1.4.0", "1.5.0"])
      call(inst, "install", { ...l, from: release(l.d, v), exists: () => false });
    cpSyncDir(release(l.d, "1.6.0"), join(l.root, "releases", "1.6.0"));
    // `psyche start` wrote its own unit since: activate must refuse before switching anything.
    writeFileSync(join(l.unitDir, "psyche-gateway.service"), "# written by psyche start\n");
    expect(() => call(inst, "activate", { ...l, version: "1.6.0" })).toThrow(
      /not written by the psyche-server installer/,
    );
    expect(target(join(l.root, "current"))).toBe(join("releases", "1.5.0"));
    expect(target(join(l.root, "previous"))).toBe(join("releases", "1.4.0"));
    expect(() => call(inst, "rollback", l)).toThrow(/not written by the psyche-server installer/);
    expect(target(join(l.root, "current"))).toBe(join("releases", "1.5.0"));
    expect(target(join(l.root, "previous"))).toBe(join("releases", "1.4.0"));
    expect(readFileSync(join(l.unitDir, "psyche-gateway.service"), "utf8")).toBe(
      "# written by psyche start\n",
    );
  });

  it("refuses to run as root", () => {
    expect(() => call(inst, "refuseRoot", 0)).toThrow(/not run this as root/);
    expect(() => call(inst, "refuseRoot", 1000)).not.toThrow();
  });
});

describe("the maintainer scripts on upgrade and removal", () => {
  /** Runs a scriptlet with fake loginctl and systemctl on PATH; returns what they were asked. */
  async function runScript(script: string, args: string[], env: Record<string, string> = {}) {
    const { nodeExec } = await import("../src/exec.ts");
    const dir = tempDir();
    const log = join(dir, "calls.log");
    writeFileSync(
      join(dir, "loginctl"),
      `#!/bin/sh\necho "loginctl $*" >> "${log}"\nif [ "$1" = list-users ]; then printf '0 root no active\\n1000 ann yes active\\n1001 bob no active\\n'; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${log}"\nexit 0\n`, {
      mode: 0o755,
    });
    writeFileSync(join(dir, "runuser"), `#!/bin/sh\necho "runuser $*" >> "${log}"\nexit 0\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(dir, "getent"),
      "#!/bin/sh\necho 'ann:x:1000:1000::/nonexistent:/bin/sh'\n",
      {
        mode: 0o755,
      },
    );
    const file = join(dir, "script.sh");
    writeFileSync(file, script, { mode: 0o755 });
    const r = await nodeExec("/bin/sh", [file, ...args], {
      env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { ...r, calls };
  }
  const POSTINST = build.POSTINST as string;
  const PRERM = build.PRERM as string;

  it.skipIf(process.platform === "win32")(
    "linger only on the first install, for the sudo user; an upgrade restarts Psyche and its helper",
    async () => {
      for (const first of [["configure", ""], ["configure"], ["1"]]) {
        const r = await runScript(POSTINST, first, { SUDO_USER: "ann" });
        expect(r.code).toBe(0);
        expect(r.calls).toContain("loginctl enable-linger ann");
        expect(r.calls.some((c) => c.includes("try-restart"))).toBe(false);
        // The setup code, made as that user, then the Gateway started for them (design §3.6).
        const code = r.calls.indexOf(
          "runuser -u ann -- env HOME=/nonexistent /usr/bin/psyche setup code",
        );
        const start = r.calls.indexOf(
          "systemctl --machine ann@ --user enable --now psyche-gateway.service",
        );
        expect(code).toBeGreaterThanOrEqual(0);
        expect(start).toBeGreaterThan(code);
      }
      // No sudo user: nothing is made or started for anyone; it says what to run.
      const plain = await runScript(POSTINST, ["configure", ""]);
      expect(plain.code).toBe(0);
      expect(plain.calls.some((c) => c.includes("runuser") || c.includes("enable --now"))).toBe(
        false,
      );
      expect(plain.stdout).toContain("psyche setup code");
      for (const upgrade of [["configure", "1.4.0"], ["2"]]) {
        const r = await runScript(POSTINST, upgrade, { SUDO_USER: "ann" });
        expect(r.code).toBe(0);
        expect(r.calls.some((c) => c.includes("enable-linger"))).toBe(false);
        // An upgrade never makes a new code (that would stop the one the owner has).
        expect(r.calls.some((c) => c.includes("setup code"))).toBe(false);
        for (const u of ["ann", "bob"])
          expect(r.calls).toContain(
            `systemctl --machine ${u}@ --user try-restart psyche-gateway.service psyche-helper-headless.service`,
          );
        expect(r.calls.some((c) => c.includes("--machine root@"))).toBe(false);
      }
      // Other dpkg actions do nothing.
      expect((await runScript(POSTINST, ["abort-upgrade", "1.5.0"])).calls).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "removal stops the units of every user whose manager runs, not just the sudo user",
    async () => {
      const r = await runScript(PRERM, ["remove"], { SUDO_USER: "ann" });
      expect(r.code).toBe(0);
      for (const u of ["ann", "bob"])
        expect(r.calls).toContain(
          `systemctl --machine ${u}@ --user disable --now psyche-gateway.service psyche-helper-headless.service`,
        );
      expect((await runScript(PRERM, ["upgrade", "1.5.0"])).calls).toEqual([]);
      expect((await runScript(PRERM, ["1"])).calls).toEqual([]);
    },
  );
});

function cpSyncDir(from: string, to: string) {
  cpSync(from, to, { recursive: true });
}
