import { generateKeyPairSync } from "node:crypto";
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type Exec, nodeExec } from "../src/exec.ts";
import {
  findKeptPackage,
  findServerInstall,
  keepManifest,
  keyIdOf,
  PINNED_BASE,
  planServerUpdate,
  pruneKeptPackages,
  type ReleaseKey,
  type ServerInstall,
  serverInstallStatus,
  serverInstallText,
  serverUpdate,
  shQuote,
  type UpdateDeps,
  verifiedInstallCommand,
  verifyArtifactFile,
  verifyServerManifest,
  waitHealthyThroughUpdate,
} from "../src/server-update.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

/**
 * `psyche update` on a psyche-server install (linux-helper-only design §3.2, wave B1). Manifests
 * are built and signed by deploy/scripts/update-manifest.mjs with throwaway keys; the release key
 * is never read. Must-refuse rows are tampering a same-user attacker or a bad mirror could try.
 */

const deploy = resolve(import.meta.dirname, "../../../deploy");
type Mod = Record<string, (...args: never[]) => unknown>;
const um = (await import(join(deploy, "scripts/update-manifest.mjs"))) as Mod;
const buildManifest = um.buildManifest as unknown as (o: Record<string, unknown>) => string;
const signManifest = um.signManifest as unknown as (b: Buffer, pem: string) => string;

afterEach(cleanupTempDirs);

function throwaway(): { key: ReleaseKey; pem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    key: { keyId: keyIdOf(raw), publicKey: raw.toString("base64") },
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

const TRUSTED = throwaway();
const OTHER = throwaway();

/** A release folder with files named as the release job names them; returns the folder. */
function releaseDir(release: string, files: Record<string, Buffer | string>, key = TRUSTED) {
  const dir = tempDir("psyche-release-");
  const paths = Object.entries(files).map(([name, bytes]) => {
    writeFileSync(join(dir, name), bytes);
    return join(dir, name);
  });
  const text = buildManifest({
    release,
    base: `${PINNED_BASE}v${release}/`,
    files: paths,
    linuxOnly: true,
  });
  writeFileSync(join(dir, "update-manifest.json"), text);
  writeFileSync(join(dir, "update-manifest.json.sig"), signManifest(Buffer.from(text), key.pem));
  return dir;
}

/** An installed bundle with the files the package or the tarball puts beside it. */
function installed(kind: "deb" | "rpm" | "tarball", version = "1.4.0", keys = [TRUSTED.key]) {
  const base = tempDir("psyche-install-");
  const dir =
    kind === "tarball"
      ? join(base, "psyche-server", "releases", version)
      : join(base, "psyche-server");
  mkdirSync(join(dir, "psyched"), { recursive: true });
  writeFileSync(join(dir, "psyched", "build-info.json"), JSON.stringify({ version, arch: "x64" }));
  writeFileSync(
    join(dir, "psyche-server.json"),
    JSON.stringify({ format: "psyche-server-install", kind, version, arch: "x64" }),
  );
  writeFileSync(join(dir, "release-keys.json"), JSON.stringify(keys));
  return { base, dir, bundle: join(dir, "psyched") };
}

const sig = (dir: string) => readFileSync(join(dir, "update-manifest.json.sig"), "utf8");
const bytes = (dir: string) => readFileSync(join(dir, "update-manifest.json"));
const install = (kind: ServerInstall["kind"] = "deb", version = "1.4.0") =>
  findServerInstall(installed(kind, version).bundle);

describe("the signed manifest and the file it names", () => {
  const files = {
    "psyche-server-1.5.0-linux-x64.deb": "deb bytes",
    "psyche-server-1.5.0-linux-x64.rpm": "rpm bytes",
    "psyche-server-1.5.0-linux-x64.tar.zst": "tar bytes",
    "psyche-server-1.5.0-linux-arm64.deb": "arm deb bytes",
  };

  it("must accept: each install kind gets its own file of a newer release", () => {
    const dir = releaseDir("1.5.0", files);
    const m = verifyServerManifest(bytes(dir), sig(dir), [OTHER.key, TRUSTED.key]);
    for (const [kind, name] of [
      ["deb", "psyche-server-1.5.0-linux-x64.deb"],
      ["rpm", "psyche-server-1.5.0-linux-x64.rpm"],
      ["tarball", "psyche-server-1.5.0-linux-x64.tar.zst"],
    ] as const) {
      const plan = planServerUpdate(m, { kind, arch: "x64", version: "1.4.0" });
      expect(plan).toMatchObject({ action: "update", release: "1.5.0", artifact: { name } });
      if (plan.action === "update") {
        expect(plan.url).toBe(`${PINNED_BASE}v1.5.0/${name}`);
        verifyArtifactFile(join(dir, name), plan.artifact);
      }
    }
    // A pre-release of 1.4.0 updates to 1.4.0 itself.
    expect(planServerUpdate(m, { kind: "deb", arch: "x64", version: "1.5.0-alpha.2" }).action).toBe(
      "update",
    );
  });

  it("must refuse: a manifest that is not exactly what a trusted key signed", () => {
    const dir = releaseDir("1.5.0", files);
    const good = bytes(dir);
    const edited = Buffer.from(
      good.toString("utf8").replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${"0".repeat(64)}"`),
    );
    const rows: [string, Buffer, string | undefined, ReleaseKey[]][] = [
      ["no signature", good, undefined, [TRUSTED.key]],
      ["an empty signature", good, "", [TRUSTED.key]],
      ["a signature that is not JSON", good, "nope", [TRUSTED.key]],
      ["signed by a key the install does not trust", good, sig(dir), [OTHER.key]],
      ["an install that trusts no key", good, sig(dir), []],
      ["a file hash changed after signing", edited, sig(dir), [TRUSTED.key]],
      [
        "one byte added after signing",
        Buffer.concat([good, Buffer.from(" ")]),
        sig(dir),
        [TRUSTED.key],
      ],
      [
        "a signature by another key under the trusted key's id",
        good,
        JSON.stringify({ ...JSON.parse(signManifest(good, OTHER.pem)), keyId: TRUSTED.key.keyId }),
        [TRUSTED.key],
      ],
      [
        "an RSA-looking envelope",
        good,
        JSON.stringify({ ...JSON.parse(sig(dir)), alg: "rsa" }),
        [TRUSTED.key],
      ],
    ];
    for (const [name, b, s, keys] of rows)
      expect(() => verifyServerManifest(b, s, keys), name).toThrow(/refused|not/);
  });

  it("must refuse: nothing to install from an older, equal or listing-less release", () => {
    const dir = releaseDir("1.5.0", files);
    const m = verifyServerManifest(bytes(dir), sig(dir), [TRUSTED.key]);
    expect(planServerUpdate(m, { kind: "deb", arch: "x64", version: "1.5.0" })).toMatchObject({
      action: "none",
      reason: "up_to_date",
    });
    expect(planServerUpdate(m, { kind: "deb", arch: "x64", version: "1.6.0" })).toMatchObject({
      action: "none",
      reason: "older",
    });
    expect(planServerUpdate(m, { kind: "rpm", arch: "arm64", version: "1.4.0" })).toMatchObject({
      action: "none",
      reason: "no_artifact",
    });
  });

  it("must refuse: a signed manifest whose entry or host is wrong", () => {
    const base = {
      release: "1.5.0",
      baseUrl: `${PINNED_BASE}v1.5.0/`,
      platforms: {
        "linux-x64": [
          {
            name: "psyche-server-1.5.0-linux-x64.deb",
            kind: "server-deb",
            sha256: "a".repeat(64),
            bytes: 9,
          },
        ],
      },
    };
    const i = { kind: "deb", arch: "x64", version: "1.4.0" } as const;
    expect(planServerUpdate(base, i).action).toBe("update");
    const wrongName = structuredClone(base);
    (wrongName.platforms["linux-x64"][0] as { name: string }).name =
      "psyche-server-1.4.9-linux-x64.deb";
    expect(() => planServerUpdate(wrongName, i)).toThrow(/refused/);
    const traversal = structuredClone(base);
    (traversal.platforms["linux-x64"][0] as { name: string }).name =
      "../../evil/psyche-server-1.5.0-linux-x64.deb";
    expect(() => planServerUpdate(traversal, i)).toThrow(/refused/);
    for (const host of [
      "https://example.com/devmello/psyche/releases/download/v1.5.0/",
      "https://github.com/devmello/psyche-evil/releases/download/v1.5.0/",
      "https://github.com/devmello/psyche/releases/download/../../other/",
      "http://github.com/devmello/psyche/releases/download/v1.5.0/",
      "https://user@github.com/devmello/psyche/releases/download/v1.5.0/",
    ]) {
      expect(() => planServerUpdate({ ...base, baseUrl: host }, i), host).toThrow(/refused/);
    }
    // --from <dir> reads the file by name from that folder: the host pin does not apply.
    expect(planServerUpdate({ ...base, baseUrl: "https://example.com/" }, i, null).action).toBe(
      "update",
    );
    const two = structuredClone(base);
    two.platforms["linux-x64"].push({ ...base.platforms["linux-x64"][0] } as never);
    expect(planServerUpdate(two, i)).toMatchObject({ action: "none", reason: "ambiguous" });
  });

  it("must refuse: a file that differs from the signed size or hash", () => {
    const dir = releaseDir("1.5.0", files);
    const m = verifyServerManifest(bytes(dir), sig(dir), [TRUSTED.key]);
    const plan = planServerUpdate(m, { kind: "deb", arch: "x64", version: "1.4.0" });
    if (plan.action !== "update") throw new Error("no plan");
    const file = join(dir, plan.artifact.name);
    writeFileSync(file, "deb bytez");
    expect(() => verifyArtifactFile(file, plan.artifact)).toThrow(/does not match/);
    writeFileSync(file, "deb bytes!");
    expect(() => verifyArtifactFile(file, plan.artifact)).toThrow(/does not match/);
  });

  it("an install is only what its own files say", () => {
    const deb = installed("deb");
    expect(findServerInstall(deb.bundle)).toMatchObject({
      kind: "deb",
      version: "1.4.0",
      arch: "x64",
    });
    const tar = installed("tarball");
    expect(findServerInstall(tar.bundle).root).toBe(realpathSync(join(tar.base, "psyche-server")));
    // A tarball release that is not in releases/<its version>.
    const odd = installed("tarball", "1.4.0");
    const moved = join(odd.base, "elsewhere");
    cpSync(odd.dir, moved, { recursive: true });
    expect(() => findServerInstall(join(moved, "psyched"))).toThrow(/releases folder/);
    // No description beside the bundle: a checkout, Docker or the desktop.
    expect(() => findServerInstall(tempDir())).toThrow(/not part of a psyche-server install/);
    const badKeys = installed("deb", "1.4.0", [
      { keyId: "0".repeat(16), publicKey: TRUSTED.key.publicKey },
    ]);
    expect(() => findServerInstall(badKeys.bundle)).toThrow(/not a valid release key/);
  });
});

/** Fake service control, recording what happened in order. */
function fakeDeps(home: string, over: Partial<UpdateDeps> = {}) {
  const events: string[] = [];
  let running = true;
  const exec: Exec = async (cmd, args) => {
    events.push(`exec ${cmd.split("/").slice(-2).join("/")} ${args.join(" ")}`);
    if (cmd.endsWith("/psyched") && args[0] === "snapshot") {
      const dir = join(
        home,
        ".psyche",
        "backups",
        "pre-update",
        `1.4.0-to-${args[1]}-2026-11-20T00-00-00-000Z`,
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), "{}");
      return { code: 0, stdout: `${dir}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps: UpdateDeps = {
    stop: async () => {
      events.push("stop");
      running = false;
    },
    start: async () => {
      events.push("start");
      running = true;
    },
    healthy: async () => true,
    running: async () => running,
    exec,
    fetch: async () => {
      throw new Error("no network in tests");
    },
    env: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
    home: join(home, ".psyche"),
    log: (l) => events.push(`log ${l}`),
    ...over,
  };
  return { deps, events };
}

describe("psyche update on a deb or rpm install", () => {
  it("verifies, snapshots with the Gateway stopped, starts it again and prints the command", async () => {
    const i = installed("deb");
    const dir = releaseDir("1.5.0", { "psyche-server-1.5.0-linux-x64.deb": "deb bytes" });
    const home = tempDir();
    const { deps, events } = fakeDeps(home);
    const r = await serverUpdate(i.bundle, { from: dir }, deps);
    expect(r.exitCode ?? 0).toBe(0);
    const file = join(home, ".cache", "psyche", "updates", "psyche-server-1.5.0-linux-x64.deb");
    expect(r.data).toMatchObject({ release: "1.5.0", file });
    const command = r.data.command as string;
    // Copied out of the account's cache and checked as root before apt reads it.
    expect(command).toMatch(/^sudo sh -c '/);
    expect(command).toContain('install -m 0600 -o root -g root "$1" /var/cache/psyche-server/');
    expect(command).toMatch(
      /echo "[0-9a-f]{64} {2}\/var\/cache\/psyche-server\/psyche-server-1\.5\.0-linux-x64\.deb" \| sha256sum -c -/,
    );
    expect(command).toContain(
      "apt install /var/cache/psyche-server/psyche-server-1.5.0-linux-x64.deb",
    );
    expect(command.endsWith(` sh ${shQuote(file)}`)).toBe(true);
    expect(r.human).toContain(command);
    expect(r.human).toContain("systemctl --user restart psyche-gateway.service");
    expect(r.human).toContain("systemctl --user try-restart psyche-helper-headless.service");
    // The release that ran is recorded, so a rollback offers only it.
    expect(readFileSync(`${file}.from`, "utf8").trim()).toBe("1.4.0");
    expect(events.filter((e) => !e.startsWith("log"))).toEqual([
      "stop",
      "exec psyched/psyched snapshot 1.5.0",
      "start",
    ]);
    expect(readFileSync(file, "utf8")).toBe("deb bytes");
    expect(existsSync(`${file}.manifest.json.sig`)).toBe(true);
    // ~/.psyche is touched only by the snapshot.
    expect(existsSync(join(home, ".psyche", "state"))).toBe(false);
  });

  it("a tampered package is refused before the Gateway is stopped or any copy is made", async () => {
    const i = installed("deb");
    const dir = releaseDir("1.5.0", { "psyche-server-1.5.0-linux-x64.deb": "deb bytes" });
    writeFileSync(join(dir, "psyche-server-1.5.0-linux-x64.deb"), "evil bytes");
    const home = tempDir();
    const { deps, events } = fakeDeps(home);
    await expect(serverUpdate(i.bundle, { from: dir }, deps)).rejects.toThrow(/does not match/);
    expect(events).toEqual([]);
    expect(
      existsSync(join(home, ".cache", "psyche", "updates", "psyche-server-1.5.0-linux-x64.deb")),
    ).toBe(false);
  });

  it("a manifest signed by another key is refused the same way", async () => {
    const i = installed("rpm");
    const dir = releaseDir("1.5.0", { "psyche-server-1.5.0-linux-x64.rpm": "rpm bytes" }, OTHER);
    const { deps, events } = fakeDeps(tempDir());
    await expect(serverUpdate(i.bundle, { from: dir }, deps)).rejects.toThrow(/does not trust/);
    expect(events).toEqual([]);
  });

  it("a failed snapshot stops the update and starts the Gateway again", async () => {
    const i = installed("deb");
    const dir = releaseDir("1.5.0", { "psyche-server-1.5.0-linux-x64.deb": "deb bytes" });
    const home = tempDir();
    const { deps, events } = fakeDeps(home, {
      exec: async () => ({ code: 1, stdout: "error: disk full\n", stderr: "" }),
    });
    await expect(serverUpdate(i.bundle, { from: dir }, deps)).rejects.toThrow(
      /snapshot failed.*disk full/,
    );
    expect(events.filter((e) => !e.startsWith("log"))).toEqual(["stop", "start"]);
  });

  it("--check only reports", async () => {
    const i = installed("deb");
    const dir = releaseDir("1.5.0", { "psyche-server-1.5.0-linux-x64.deb": "deb bytes" });
    const { deps, events } = fakeDeps(tempDir());
    const r = await serverUpdate(i.bundle, { from: dir, check: true }, deps);
    expect(r.data).toMatchObject({ update: true, release: "1.5.0" });
    expect(events).toEqual([]);
  });

  it("--rollback offers only the kept release that ran before, after verifying it again", async () => {
    const home = tempDir();
    const env = { HOME: home, XDG_CACHE_HOME: join(home, ".cache") };
    const cache = join(home, ".cache", "psyche", "updates");
    mkdirSync(cache, { recursive: true });
    const keep = (release: string, from?: string) => {
      const dir = releaseDir(release, {
        [`psyche-server-${release}-linux-x64.deb`]: `deb ${release}`,
      });
      const file = join(cache, `psyche-server-${release}-linux-x64.deb`);
      cpSync(join(dir, `psyche-server-${release}-linux-x64.deb`), file);
      keepManifest(file, bytes(dir), sig(dir), from);
      return { dir, file };
    };
    const old = keep("1.4.0", "1.3.0");
    keep("1.5.0", "1.4.0");
    // A planted older signed release is never the target: only what 1.5.0 was updated from.
    keep("1.2.0");
    const now = install("deb", "1.5.0");
    expect(findKeptPackage(cache, now)).toMatchObject({ file: old.file, release: "1.4.0" });
    // The Gateway names its snapshot after its own version, which need not be the package's.
    const snaps = join(home, ".psyche", "backups", "pre-update");
    for (const name of [
      "0.3.0-alpha.0-to-1.5.0-2026-11-20T09-14-06-315Z",
      "0.3.0-alpha.0-to-1.5.0-2026-11-20T10-00-00-000Z",
      "0.3.0-alpha.0-to-1.6.0-2026-11-21T00-00-00-000Z",
    ]) {
      mkdirSync(join(snaps, name), { recursive: true });
      writeFileSync(join(snaps, name, "manifest.json"), "{}");
    }
    mkdirSync(join(snaps, ".partial-x-to-1.5.0-2026-11-22T00-00-00-000Z"), { recursive: true });
    const { deps } = fakeDeps(home, { env });
    const r = await serverUpdate(installed("deb", "1.5.0").bundle, { rollback: true }, deps);
    expect(r.data.command as string).toContain(
      "apt install --allow-downgrades /var/cache/psyche-server/psyche-server-1.4.0-linux-x64.deb",
    );
    expect(r.data.command as string).toContain("sha256sum -c -");
    expect(r.human).toContain("try-restart psyche-helper-headless.service");
    expect(r.data.snapshot).toBe(join(snaps, "0.3.0-alpha.0-to-1.5.0-2026-11-20T10-00-00-000Z"));
    // The kept file changed on disk, or its kept manifest did: not offered.
    writeFileSync(old.file, "old deb, edited");
    expect(findKeptPackage(cache, now)).toBeUndefined();
    cpSync(join(old.dir, "psyche-server-1.4.0-linux-x64.deb"), old.file);
    expect(findKeptPackage(cache, now)).toBeDefined();
    writeFileSync(
      `${old.file}.manifest.json`,
      `${readFileSync(`${old.file}.manifest.json`, "utf8")} `,
    );
    expect(findKeptPackage(cache, now)).toBeUndefined();
    // No record of what ran before: nothing is offered.
    expect(findKeptPackage(cache, install("deb", "1.6.0"))).toBeUndefined();
  });

  it("keeps only the last two packages", () => {
    const cache = tempDir();
    for (const v of ["1.2.0", "1.3.0", "1.4.0", "1.5.0"])
      for (const suffix of ["", ".manifest.json", ".manifest.json.sig", ".from"])
        writeFileSync(join(cache, `psyche-server-${v}-linux-x64.deb${suffix}`), "x");
    writeFileSync(join(cache, "psyche-server-1.2.0-linux-x64.rpm"), "another kind");
    writeFileSync(join(cache, "notes.txt"), "not ours");
    pruneKeptPackages(cache, { kind: "deb", arch: "x64" }, ["1.5.0", "1.4.0"]);
    const left = readdirSync(cache).sort();
    expect(left.filter((n) => n.endsWith(".deb"))).toEqual([
      "psyche-server-1.4.0-linux-x64.deb",
      "psyche-server-1.5.0-linux-x64.deb",
    ]);
    expect(left).toContain("psyche-server-1.2.0-linux-x64.rpm");
    expect(left).toContain("notes.txt");
    expect(left.some((n) => n.startsWith("psyche-server-1.3.0"))).toBe(false);
  });

  it("the printed command quotes the cache path, and refuses names and hashes it cannot trust", async () => {
    const sha = "a".repeat(64);
    for (const path of [
      "/home/ann/.cache/psyche/updates/psyche-server-1.5.0-linux-x64.deb",
      "/home/my user/.cache/x.deb",
      "/home/o'brien/$(touch pwned)/`id`;rm -rf ~/x.deb",
    ]) {
      const cmd = verifiedInstallCommand("deb", path, {
        name: "psyche-server-1.5.0-linux-x64.deb",
        sha256: sha,
      });
      // What the shell hands sh -c as $1 is exactly the path.
      const echoed = await nodeExec("/bin/sh", [
        "-c",
        `printf %s ${cmd.slice(cmd.lastIndexOf(" sh ") + 4)}`,
      ]);
      expect(echoed.stdout).toBe(path);
    }
    expect(
      verifiedInstallCommand("rpm", "/x.rpm", {
        name: "psyche-server-1.5.0-linux-x64.rpm",
        sha256: sha,
      }),
    ).toContain("dnf install /var/cache/psyche-server/psyche-server-1.5.0-linux-x64.rpm");
    expect(() =>
      verifiedInstallCommand("deb", "/x", { name: "psyche-server-1.5.0;id.deb", sha256: sha }),
    ).toThrow();
    expect(() =>
      verifiedInstallCommand("deb", "/x", {
        name: "psyche-server-1.5.0-linux-x64.deb",
        sha256: "zz",
      }),
    ).toThrow();
  });

  it("refuses to run as root, before reading anything", async () => {
    const i = installed("deb");
    const dir = releaseDir("1.5.0", { "psyche-server-1.5.0-linux-x64.deb": "deb bytes" });
    const { deps, events } = fakeDeps(tempDir(), { uid: 0 });
    await expect(serverUpdate(i.bundle, { from: dir }, deps)).rejects.toThrow(
      /not run psyche update as root/,
    );
    await expect(serverUpdate(i.bundle, { rollback: true }, deps)).rejects.toThrow(/as root/);
    expect(events).toEqual([]);
  });

  it("no data folder yet: the update goes on and says nothing was copied", async () => {
    const i = installed("deb");
    const dir = releaseDir("1.5.0", { "psyche-server-1.5.0-linux-x64.deb": "deb bytes" });
    const { deps } = fakeDeps(tempDir(), {
      exec: async () => ({
        code: 5,
        stdout: "no data folder at /x: nothing to copy\n",
        stderr: "",
      }),
    });
    const r = await serverUpdate(i.bundle, { from: dir }, deps);
    expect(r.data.snapshot).toBeNull();
    expect(r.human).toContain("there is no data yet");
    expect(r.human).not.toContain("copied to no data folder");
  });

  it("psyche status names the install, and a tarball's helper as not verified", () => {
    const tar = serverInstallStatus(installed("tarball").bundle);
    expect(tar).toEqual({ kind: "tarball", version: "1.4.0", helper: "not_verified_tarball" });
    expect(serverInstallText(tar as never)).toBe(
      "psyche-server tarball 1.4.0; helper not verified (tarball install)",
    );
    expect(serverInstallStatus(installed("deb").bundle)).toEqual({ kind: "deb", version: "1.4.0" });
    expect(serverInstallStatus(tempDir())).toBeUndefined();
    expect(serverInstallStatus(undefined)).toBeUndefined();
  });
});

describe("waiting for a new Gateway that is copying or migrating the data", () => {
  it("keeps waiting while run/update-progress.json is fresh, up to the ceiling", async () => {
    const home = tempDir();
    mkdirSync(join(home, "run"));
    let t = 0;
    let calls = 0;
    const progress = (phase: string) =>
      writeFileSync(
        join(home, "run", "update-progress.json"),
        JSON.stringify({ phase, build: "b", at: new Date(t).toISOString() }),
      );
    const base = fakeDeps(home).deps;
    const deps: UpdateDeps = {
      ...base,
      home,
      now: () => t,
      healthy: async (ms) => {
        calls++;
        t += ms;
        progress(calls < 3 ? "snapshot" : "migrating");
        return calls >= 5;
      },
    };
    expect(await waitHealthyThroughUpdate(deps, 90_000)).toBe(true);
    expect(calls).toBe(5);
    // No progress note: the first deadline is the answer.
    calls = 0;
    rmSync(join(home, "run", "update-progress.json"));
    const quiet: UpdateDeps = {
      ...deps,
      healthy: async (ms) => {
        t += ms;
        calls++;
        return false;
      },
    };
    expect(await waitHealthyThroughUpdate(quiet, 90_000)).toBe(false);
    expect(calls).toBe(1);
    // Progress that never ends stops at the ceiling.
    calls = 0;
    const forever: UpdateDeps = {
      ...deps,
      ceilingMs: 60_000,
      healthy: async (ms) => {
        calls++;
        t += ms;
        progress("migrating");
        return false;
      },
    };
    expect(await waitHealthyThroughUpdate(forever, 10_000)).toBe(false);
    expect(calls).toBeLessThanOrEqual(7);
    // A stale note does not count.
    calls = 0;
    const stale: UpdateDeps = {
      ...deps,
      healthy: async (ms) => {
        calls++;
        writeFileSync(
          join(home, "run", "update-progress.json"),
          JSON.stringify({ phase: "migrating", at: new Date(t - 10 * 60_000).toISOString() }),
        );
        t += ms;
        return false;
      },
    };
    expect(await waitHealthyThroughUpdate(stale, 1_000)).toBe(false);
    expect(calls).toBe(1);
  });
});

/** A real tarball (tar + Node's zstd) of a release that install.mjs can activate. */
async function tarball(dir: string, version: string): Promise<string> {
  const top = `psyche-server-${version}-linux-x64`;
  const r = join(dir, "src", top);
  mkdirSync(join(r, "psyched", "runtime"), { recursive: true });
  mkdirSync(join(r, "units"));
  writeFileSync(join(r, "psyched", "build-info.json"), JSON.stringify({ version, arch: "x64" }));
  writeFileSync(join(r, "psyched", "psyche"), "#!/bin/sh\n");
  writeFileSync(join(r, "psyched", "psyched"), "#!/bin/sh\n");
  writeFileSync(
    join(r, "psyche-server.json"),
    JSON.stringify({ format: "psyche-server-install", kind: "tarball", version, arch: "x64" }),
  );
  writeFileSync(join(r, "release-keys.json"), JSON.stringify([TRUSTED.key]));
  cpSync(join(deploy, "linux-server", "install.mjs"), join(r, "install.mjs"));
  for (const u of ["psyche-gateway.service", "psyche-helper-headless.service"])
    writeFileSync(
      join(r, "units", `${u}.in`),
      '[Service]\nExecStart="@PSYCHE_SERVER_ROOT@/current/psyched/psyched"\n',
    );
  const tar = join(dir, `${top}.tar`);
  const made = await nodeExec("tar", ["-C", join(dir, "src"), "-cf", tar, top]);
  if (made.code !== 0) throw new Error(made.stderr);
  const out = join(dir, `${top}.tar.zst`);
  await pipeline(createReadStream(tar), createZstdCompress(), createWriteStream(out));
  return out;
}

describe("psyche update on a tarball install", () => {
  /** A tarball install of 1.4.0 at <home>/.local/lib/psyche-server, done by its own install.mjs. */
  async function setup() {
    const home = tempDir();
    const work = tempDir();
    const root = join(home, ".local", "lib", "psyche-server");
    const env = {
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: process.env.PATH,
    };
    const first = await tarball(work, "1.4.0");
    // Unpacked with Node's zstd (no zstd binary needed on the test machine).
    const { unpackTarZst } = await import("../src/server-update.ts");
    const src = await unpackTarZst(
      readFileSync(first),
      join(work, "u"),
      "psyche-server-1.4.0-linux-x64",
    );
    const inst = (await import(join(deploy, "linux-server/install.mjs"))) as Mod;
    (inst.install as unknown as (o: Record<string, unknown>) => unknown)({
      from: src,
      root,
      unitDir: join(home, ".config", "systemd", "user"),
      binDir: join(home, ".local", "bin"),
      exists: () => false,
    });
    const rel = releaseDir("1.5.0", {
      "psyche-server-1.5.0-linux-x64.tar.zst": readFileSync(await tarball(work, "1.5.0")),
    });
    // Release scripts run on "their own Node": this test's Node stands in for runtime/node.
    const nodeAsRuntime: Exec = async (cmd, args, opts) =>
      cmd.endsWith("/runtime/node")
        ? nodeExec(process.execPath, args, { ...opts, env: { ...env } })
        : nodeExec(cmd, args, opts);
    return { home, root, env, rel, nodeAsRuntime };
  }

  it("unpacks the verified tarball, switches by renaming a link, and keeps the old release", async () => {
    const s = await setup();
    const { deps, events } = fakeDeps(s.home, { env: s.env });
    const fake = deps.exec;
    deps.exec = async (cmd, args, opts) => {
      if (cmd === "tar" || cmd.endsWith("/runtime/node")) {
        await fake(cmd, args, opts); // records the call
        return s.nodeAsRuntime(cmd, args, opts);
      }
      return fake(cmd, args, opts);
    };
    const r = await serverUpdate(join(s.root, "current", "psyched"), { from: s.rel }, deps);
    expect(r).toMatchObject({ data: { from: "1.4.0", to: "1.5.0", healthy: true } });
    expect(readlinkSync(join(s.root, "current"))).toBe(join("releases", "1.5.0"));
    expect(readlinkSync(join(s.root, "previous"))).toBe(join("releases", "1.4.0"));
    const order = events.filter((e) => !e.startsWith("log") && !e.startsWith("exec tar"));
    expect(order[0]).toBe("stop");
    expect(order[1]).toBe("exec psyched/psyched snapshot 1.5.0");
    // The helper restarts too, so it runs from the new release.
    expect(order.slice(-2)).toEqual([
      "start",
      "exec systemctl --user try-restart psyche-helper-headless.service",
    ]);
    expect(order.some((e) => e.includes("install.mjs activate 1.5.0"))).toBe(true);
    // The tarball is unpacked from the verified bytes; nothing is kept in the cache.
    expect(existsSync(join(s.home, ".cache", "psyche", "updates"))).toBe(false);
  });

  it("a refused activate leaves the release that ran current, and starts only that", async () => {
    const s = await setup();
    // `psyche start` wrote its own unit since the install: activate refuses.
    writeFileSync(
      join(s.home, ".config", "systemd", "user", "psyche-gateway.service"),
      "# written by psyche start\n",
    );
    const { deps, events } = fakeDeps(s.home, { env: s.env });
    const fake = deps.exec;
    deps.exec = async (cmd, args, opts) =>
      cmd === "tar" || cmd.endsWith("/runtime/node")
        ? s.nodeAsRuntime(cmd, args, opts)
        : fake(cmd, args, opts);
    await expect(
      serverUpdate(join(s.root, "current", "psyched"), { from: s.rel }, deps),
    ).rejects.toThrow(/not written by the psyche-server installer/);
    expect(readlinkSync(join(s.root, "current"))).toBe(join("releases", "1.4.0"));
    expect(existsSync(join(s.root, "previous"))).toBe(false);
    expect(events.filter((e) => !e.startsWith("log"))).toEqual([
      "stop",
      "exec psyched/psyched snapshot 1.5.0",
      "start",
    ]);
  });

  it("does not go back when the old build cannot open the data: the new one is started again", async () => {
    const s = await setup();
    const { deps, events } = fakeDeps(s.home, { env: s.env, healthy: async () => false });
    const fake = deps.exec;
    deps.exec = async (cmd, args, opts) =>
      cmd.endsWith("/psyche") && args[0] === "migrate"
        ? { code: 1, stdout: "database: the data is from a newer Psyche", stderr: "" }
        : cmd === "tar" || cmd.endsWith("/runtime/node")
          ? s.nodeAsRuntime(cmd, args, opts)
          : fake(cmd, args, opts);
    const r = await serverUpdate(join(s.root, "current", "psyched"), { from: s.rel }, deps);
    expect(r).toMatchObject({ exitCode: 1, data: { rolledBack: false, refused: "data_newer" } });
    expect(r.human).toContain("1.5.0 stays");
    expect(r.human).toContain("backups/pre-update/1.4.0-to-1.5.0-");
    expect(readlinkSync(join(s.root, "current"))).toBe(join("releases", "1.5.0"));
    const order = events.filter((e) => !e.startsWith("log"));
    expect(order.slice(-3)).toEqual([
      "stop",
      "start",
      "exec systemctl --user try-restart psyche-helper-headless.service",
    ]);
  });

  it("goes back to the old release when the new one does not come up healthy", async () => {
    const s = await setup();
    let starts = 0;
    const { deps } = fakeDeps(s.home, {
      env: s.env,
      healthy: async () => starts > 1,
    });
    const base = deps.start;
    deps.start = async () => {
      starts++;
      await base();
    };
    const fake = deps.exec;
    deps.exec = async (cmd, args, opts) =>
      cmd === "tar" || cmd.endsWith("/runtime/node")
        ? s.nodeAsRuntime(cmd, args, opts)
        : fake(cmd, args, opts);
    const r = await serverUpdate(join(s.root, "current", "psyched"), { from: s.rel }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.data).toMatchObject({ rolledBack: true, backHealthy: true });
    expect(readlinkSync(join(s.root, "current"))).toBe(join("releases", "1.4.0"));
  });

  it("--rollback switches back, but not when the older build cannot open the data", async () => {
    const s = await setup();
    const { deps } = fakeDeps(s.home, { env: s.env });
    const fake = deps.exec;
    deps.exec = async (cmd, args, opts) =>
      cmd === "tar" || cmd.endsWith("/runtime/node")
        ? s.nodeAsRuntime(cmd, args, opts)
        : fake(cmd, args, opts);
    await serverUpdate(join(s.root, "current", "psyched"), { from: s.rel }, deps);
    expect(readlinkSync(join(s.root, "current"))).toBe(join("releases", "1.5.0"));

    const refusing = fakeDeps(s.home, { env: s.env });
    refusing.deps.exec = async (cmd, args, opts) =>
      cmd.endsWith("/psyche") && args[0] === "migrate"
        ? { code: 1, stdout: "database: the data is from a newer Psyche", stderr: "" }
        : s.nodeAsRuntime(cmd, args, opts);
    const no = await serverUpdate(
      join(s.root, "current", "psyched"),
      { rollback: true },
      refusing.deps,
    );
    expect(no).toMatchObject({ exitCode: 1, data: { refused: "data_newer" } });
    expect(no.human).toContain("backups/pre-update/1.4.0-to-1.5.0-");
    expect(readlinkSync(join(s.root, "current"))).toBe(join("releases", "1.5.0"));

    const ok = fakeDeps(s.home, { env: s.env });
    const okFake = ok.deps.exec;
    ok.deps.exec = async (cmd, args, opts) =>
      cmd.endsWith("/psyche") && args[0] === "migrate"
        ? { code: 0, stdout: "", stderr: "" }
        : cmd.endsWith("/runtime/node")
          ? s.nodeAsRuntime(cmd, args, opts)
          : okFake(cmd, args, opts);
    const yes = await serverUpdate(join(s.root, "current", "psyched"), { rollback: true }, ok.deps);
    expect(yes).toMatchObject({ data: { rollback: true, from: "1.5.0", to: "1.4.0" } });
    expect(ok.events).toContain("exec systemctl --user try-restart psyche-helper-headless.service");
    expect(readlinkSync(join(s.root, "current"))).toBe(join("releases", "1.4.0"));
    expect(readlinkSync(join(s.root, "previous"))).toBe(join("releases", "1.5.0"));
  });

  it("a tarball whose entries leave its folder is refused even when signed", async () => {
    const dir = tempDir();
    const top = "psyche-server-1.5.0-linux-x64";
    mkdirSync(join(dir, "src", top), { recursive: true });
    mkdirSync(join(dir, "src", "other"));
    writeFileSync(join(dir, "src", "other", "x"), "x");
    const tar = join(dir, "t.tar");
    await nodeExec("tar", ["-C", join(dir, "src"), "-cf", tar, top, "other"]);
    const out = join(dir, "t.tar.zst");
    await pipeline(createReadStream(tar), createZstdCompress(), createWriteStream(out));
    const { unpackTarZst } = await import("../src/server-update.ts");
    await expect(unpackTarZst(readFileSync(out), join(dir, "dest"), top)).rejects.toThrow(
      /outside/,
    );
    expect(existsSync(join(dir, "dest"))).toBe(false);
  });
});
