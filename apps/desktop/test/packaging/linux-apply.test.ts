import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  chmodSync,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyIdOf, type ReleaseKey } from "../../src/main/update-manifest.ts";
import {
  type ApplyDeps,
  type ApplyFs,
  applyLinuxUpdate,
  installPackageCommand,
  nodeApplyFs,
  PACKAGED_SETUP,
  previousArtifact,
  type RollbackHooks,
  rollbackLinux,
  type SandboxRefresh,
  type SignedManifest,
  type StagedUpdate,
} from "../../src/packaging/linux-apply.ts";
import type { UpdateGateway } from "../../src/packaging/linux-gateway.ts";
import { linuxUpdatePaths, type RunCommand } from "../../src/packaging/linux-install.ts";

/**
 * The Linux apply step with the real file system in a temp folder, a fake Gateway, a fake `pkexec`
 * (a recording RunCommand) and manifests signed by a throwaway key. Nothing here needs Linux,
 * root or a package manager.
 */

const PINNED = "https://github.com/devmello/psyche/releases/download/";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const UID = process.getuid?.() ?? 0;

function throwawayKey(): { key: ReleaseKey; priv: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
  return { key: { keyId: keyIdOf(raw), publicKey: raw.toString("base64") }, priv: privateKey };
}

let root: string;
let trusted: ReturnType<typeof throwawayKey>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "psyche-apply-"));
  trusted = throwawayKey();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Kind = "appimage" | "deb" | "rpm";
const fileName = (kind: Kind, v: string) =>
  `Psyche-${v}-linux-x64.${kind === "appimage" ? "AppImage" : kind}`;

/** A manifest for `release` that lists `bytes` as its `kind`, signed by `by` (default: the trusted key). */
function signed(
  release: string,
  kind: Kind,
  bytes: Buffer,
  opts: { minimum?: string; by?: ReturnType<typeof throwawayKey> } = {},
): SignedManifest {
  const manifest = Buffer.from(
    JSON.stringify({
      format: "psyche-update-manifest",
      version: 1,
      release,
      minimumVersion: opts.minimum ?? "0.0.0",
      publishedAt: "2026-11-19T00:00:00.000Z",
      baseUrl: `${PINNED}v${release}/`,
      artifacts: [],
      platforms: {
        "linux-x64": [
          { name: fileName(kind, release), kind, sha256: sha(bytes), bytes: bytes.length },
        ],
      },
    }),
  );
  const by = opts.by ?? trusted;
  const sig = JSON.stringify({
    alg: "ed25519",
    keyId: by.key.keyId,
    signature: sign(null, manifest, by.priv).toString("base64"),
  });
  return { bytes: manifest, sig };
}

function setup(kind: Kind, over: Partial<ApplyDeps> = {}) {
  const home = join(root, "home");
  const paths = linuxUpdatePaths(
    { XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share") },
    home,
  );
  mkdirSync(paths.updatesDir, { recursive: true, mode: 0o700 });
  const events: string[] = [];
  const gateway: UpdateGateway = {
    prepare: async () => void events.push("prepare"),
    stop: async () => void events.push("stop"),
    restart: async (reason) => void events.push(`restart:${reason}`),
  };
  const commands: string[][] = [];
  let pkexec: { code: number; stderr?: string } = { code: 0 };
  const run: RunCommand = async (file, args) => {
    commands.push([file, ...args]);
    return { code: pkexec.code, stdout: "", stderr: pkexec.stderr ?? "" };
  };
  const relaunched: number[] = [];
  /** The manifests the pinned host would serve, by release. */
  const published = new Map<string, SignedManifest>();
  const deps: ApplyDeps = {
    // The packaged root-owned installer exists on a deb/rpm system.
    fs: {
      ...nodeApplyFs,
      access: async (p, m) => {
        if (p === PACKAGED_SETUP) return;
        return nodeApplyFs.access(p, m);
      },
    },
    run,
    gateway,
    paths,
    current: { version: "1.0.0", build: "build-old" },
    log: () => {},
    relaunch: () => void relaunched.push(1),
    keys: [trusted.key],
    arch: "x64",
    uid: UID,
    fetchManifest: async (v) => published.get(v),
    ...over,
  };
  /** Stage `bytes` as the download of `release`, vouched for by `manifest` (default: signed for it). */
  const stage = (
    release: string,
    bytes: Buffer,
    manifest: SignedManifest = signed(release, kind, bytes),
  ): StagedUpdate => {
    const name = fileName(kind, release);
    const file = join(paths.updatesDir, name);
    writeFileSync(file, bytes, { mode: 0o600 });
    return {
      release,
      file,
      artifact: {
        name,
        platform: "linux",
        arch: "x64",
        kind,
        sha256: sha(bytes),
        bytes: bytes.length,
      },
      manifest,
    };
  };
  return {
    paths,
    deps,
    events,
    commands,
    relaunched,
    published,
    stage,
    setPkexec: (r: { code: number; stderr?: string }) => {
      pkexec = r;
    },
  };
}

const hooks = () => {
  const calls: string[] = [];
  const h: RollbackHooks = {
    restoreSnapshot: async () => void calls.push("restore"),
    recordSkipBuild: async (b) => void calls.push(`skip:${b.release}:${b.build}`),
  };
  return { h, calls };
};

describe("AppImage", () => {
  const OLD = Buffer.from("old image bytes".repeat(20));
  const NEW = Buffer.from("new image bytes".repeat(20));
  const install = (image: string) => ({ kind: "appimage", appImagePath: image }) as const;

  /** The running image on disk, and the manifest the pinned host serves for its release. */
  function installed(s: ReturnType<typeof setup>, manifestBytes: Buffer = OLD) {
    const dir = join(root, "Applications");
    mkdirSync(dir, { recursive: true });
    const image = join(dir, "Psyche.AppImage");
    writeFileSync(image, OLD, { mode: 0o755 });
    s.published.set("1.0.0", signed("1.0.0", "appimage", manifestBytes));
    return image;
  }

  it("keeps the running image, stops the Gateway, swaps the file, restarts and relaunches", async () => {
    const s = setup("appimage");
    const image = installed(s);
    const staged = s.stage("1.1.0", NEW);
    const res = await applyLinuxUpdate(staged, install(image), s.deps);
    expect(res).toEqual({ state: "applied", release: "1.1.0" });
    expect(readFileSync(image)).toEqual(NEW);
    expect(statSync(image).mode & 0o777).toBe(0o755);
    expect(existsSync(staged.file)).toBe(false);
    expect(s.events).toEqual(["prepare", "stop", "restart:update"]);
    expect(s.relaunched).toHaveLength(1);
    const kept = await previousArtifact(nodeApplyFs, s.paths, "appimage", {
      keys: [trusted.key],
      arch: "x64",
    });
    expect(kept).toMatchObject({ version: "1.0.0", artifact: { sha256: sha(OLD) } });
    expect(readFileSync(join(s.paths.previousImageDir, "Psyche.AppImage"))).toEqual(OLD);
    expect(s.commands).toEqual([]);
  });

  it("applies but keeps nothing when no signed manifest is published for the running release", async () => {
    const s = setup("appimage");
    const image = installed(s);
    s.published.clear();
    const res = await applyLinuxUpdate(s.stage("1.1.0", NEW), install(image), s.deps);
    expect(res.state).toBe("applied");
    expect(
      await previousArtifact(nodeApplyFs, s.paths, "appimage", {
        keys: [trusted.key],
        arch: "x64",
      }),
    ).toBeUndefined();
  });

  it("keeps nothing when the running image is not the one its manifest names", async () => {
    const s = setup("appimage");
    const image = installed(s, Buffer.from("something else entirely"));
    const res = await applyLinuxUpdate(s.stage("1.1.0", NEW), install(image), s.deps);
    expect(res.state).toBe("applied");
    expect(existsSync(join(s.paths.previousImageDir, "Psyche.AppImage"))).toBe(false);
    expect(
      await previousArtifact(nodeApplyFs, s.paths, "appimage", {
        keys: [trusted.key],
        arch: "x64",
      }),
    ).toBeUndefined();
  });

  it("keeps nothing when the running release's manifest is signed by an untrusted key", async () => {
    const s = setup("appimage");
    const image = installed(s);
    s.published.set("1.0.0", signed("1.0.0", "appimage", OLD, { by: throwawayKey() }));
    await applyLinuxUpdate(s.stage("1.1.0", NEW), install(image), s.deps);
    expect(existsSync(join(s.paths.previousImageDir, "Psyche.AppImage"))).toBe(false);
  });

  it("keeps nothing when the host serves another release's manifest for the running version", async () => {
    const s = setup("appimage");
    const image = installed(s);
    s.published.set("1.0.0", signed("0.9.0", "appimage", OLD));
    await applyLinuxUpdate(s.stage("1.1.0", NEW), install(image), s.deps);
    expect(existsSync(join(s.paths.previousImageDir, "Psyche.AppImage"))).toBe(false);
  });

  it("refuses a staged file that changed after verification, and removes it", async () => {
    const s = setup("appimage");
    const image = installed(s);
    const staged = s.stage("1.1.0", NEW);
    writeFileSync(staged.file, "tampered");
    const res = await applyLinuxUpdate(staged, install(image), s.deps);
    expect(res).toMatchObject({ state: "failed", code: "hash_mismatch" });
    expect(readFileSync(image)).toEqual(OLD);
    expect(existsSync(staged.file)).toBe(false);
    expect(s.events).toEqual([]);
  });

  it("reports a missing file", async () => {
    const s = setup("appimage");
    const image = installed(s);
    const staged = s.stage("1.1.0", NEW);
    rmSync(staged.file);
    expect(await applyLinuxUpdate(staged, install(image), s.deps)).toMatchObject({
      state: "failed",
      code: "missing_file",
    });
  });

  it("replaces only a regular file this user owns", async () => {
    const s = setup("appimage");
    const image = installed(s);
    const other = setup("appimage", { uid: UID + 1 });
    other.published.set("1.0.0", signed("1.0.0", "appimage", OLD));
    expect(
      await applyLinuxUpdate(other.stage("1.1.0", NEW), install(image), other.deps),
    ).toMatchObject({ state: "failed", code: "not_regular_file" });
    const link = join(root, "Applications", "link.AppImage");
    symlinkSync(image, link);
    expect(await applyLinuxUpdate(s.stage("1.1.0", NEW), install(link), s.deps)).toMatchObject({
      state: "failed",
      code: "not_regular_file",
    });
    expect(readFileSync(image)).toEqual(OLD);
    expect(s.events).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "falls back to a manual download when the folder is not writable",
    async () => {
      const s = setup("appimage");
      const image = installed(s);
      chmodSync(join(root, "Applications"), 0o555);
      const staged = s.stage("1.1.0", NEW);
      const res = await applyLinuxUpdate(staged, install(image), s.deps);
      chmodSync(join(root, "Applications"), 0o755);
      expect(res).toEqual({ state: "manual", reason: "not_writable", file: staged.file });
      expect(readFileSync(image)).toEqual(OLD);
      expect(s.events).toEqual([]);
    },
  );

  it("copies beside the target and renames when the folders are on different filesystems", async () => {
    const fs: ApplyFs = {
      ...nodeApplyFs,
      rename: async (from, to) => {
        if (from.endsWith(".AppImage") && to.endsWith("Psyche.AppImage")) {
          const err = new Error("cross-device") as NodeJS.ErrnoException;
          err.code = "EXDEV";
          throw err;
        }
        return nodeApplyFs.rename(from, to);
      },
    };
    const s = setup("appimage", { fs });
    const image = installed(s);
    const staged = s.stage("1.1.0", NEW);
    const res = await applyLinuxUpdate(staged, install(image), s.deps);
    expect(res.state).toBe("applied");
    expect(readFileSync(image)).toEqual(NEW);
    expect(existsSync(`${image}.psyche-new`)).toBe(false);
    expect(existsSync(staged.file)).toBe(false);
  });

  it("starts the old Gateway again and leaves the old image when the swap fails", async () => {
    const fs: ApplyFs = {
      ...nodeApplyFs,
      rename: async (from, to) => {
        if (to.endsWith("Psyche.AppImage") && from.includes("updates"))
          throw new Error("disk full");
        return nodeApplyFs.rename(from, to);
      },
    };
    const s = setup("appimage", { fs });
    const image = installed(s);
    const res = await applyLinuxUpdate(s.stage("1.1.0", NEW), install(image), s.deps);
    expect(res).toMatchObject({ state: "failed", code: "swap_failed" });
    expect(readFileSync(image)).toEqual(OLD);
    expect(s.events).toEqual(["prepare", "stop", "restart:update"]);
    expect(s.relaunched).toHaveLength(0);
  });

  describe("sandbox helper (Ubuntu 23.10+)", () => {
    const sandbox = (over: Partial<SandboxRefresh>, copy: string): SandboxRefresh => ({
      systemCopy: copy,
      newImageSandbox: async () => sha(Buffer.from("sandbox-new")),
      setup: async () => "ok",
      ...over,
    });
    const withSystemCopy = () => {
      const copy = join(root, "chrome-sandbox");
      writeFileSync(copy, "sandbox-old");
      return copy;
    };

    it("runs the one-time setup first when the new image carries a different sandbox", async () => {
      const copy = withSystemCopy();
      const setups: string[] = [];
      const s = setup("appimage", {
        sandbox: sandbox({ setup: async (img) => (setups.push(img), "ok") }, copy),
      });
      const image = installed(s);
      const staged = s.stage("1.1.0", NEW);
      expect((await applyLinuxUpdate(staged, install(image), s.deps)).state).toBe("applied");
      expect(setups).toEqual([staged.file]);
    });

    it("leaves everything alone when the admin prompt is dismissed or the setup fails", async () => {
      for (const [outcome, expected] of [
        ["cancelled", { state: "cancelled" }],
        ["failed", { state: "failed", code: "sandbox_setup" }],
      ] as const) {
        const copy = withSystemCopy();
        const s = setup("appimage", { sandbox: sandbox({ setup: async () => outcome }, copy) });
        const image = installed(s);
        expect(await applyLinuxUpdate(s.stage("1.1.0", NEW), install(image), s.deps)).toMatchObject(
          expected,
        );
        expect(readFileSync(image)).toEqual(OLD);
        expect(s.events).toEqual([]);
      }
    });

    it("does not update when the new image's sandbox cannot be read", async () => {
      const copy = withSystemCopy();
      const s = setup("appimage", {
        sandbox: sandbox({ newImageSandbox: async () => undefined }, copy),
      });
      const image = installed(s);
      expect(await applyLinuxUpdate(s.stage("1.1.0", NEW), install(image), s.deps)).toMatchObject({
        state: "failed",
        code: "sandbox_setup",
      });
      expect(readFileSync(image)).toEqual(OLD);
    });

    it("asks for nothing when the sandbox is unchanged", async () => {
      const copy = join(root, "chrome-sandbox");
      writeFileSync(copy, "sandbox-new");
      const s = setup("appimage", {
        sandbox: sandbox({ setup: async () => "failed" }, copy),
      });
      const image = installed(s);
      expect((await applyLinuxUpdate(s.stage("1.1.0", NEW), install(image), s.deps)).state).toBe(
        "applied",
      );
    });
  });

  describe("rollback", () => {
    async function updated(minimum?: string) {
      const s = setup("appimage");
      const image = installed(s);
      const staged = s.stage("1.1.0", NEW, signed("1.1.0", "appimage", NEW, { minimum }));
      expect((await applyLinuxUpdate(staged, install(image), s.deps)).state).toBe("applied");
      s.events.length = 0;
      const running = { ...s.deps, current: { version: "1.1.0", build: "build-new" } };
      return { s, image, running };
    }

    it("restores the kept image, the data snapshot and the skip entry, then restarts", async () => {
      const { s, image, running } = await updated();
      const { h, calls } = hooks();
      const res = await rollbackLinux("appimage", image, running, h);
      expect(res).toEqual({ state: "applied", release: "1.0.0" });
      expect(readFileSync(image)).toEqual(OLD);
      expect(calls).toEqual(["restore", "skip:1.1.0:build-new"]);
      expect(s.events).toEqual(["stop", "restart:build_mismatch"]);
      expect(
        await previousArtifact(nodeApplyFs, s.paths, "appimage", {
          keys: [trusted.key],
          arch: "x64",
        }),
      ).toBeUndefined();
    });

    it("has nothing to go back to when none is kept", async () => {
      const s = setup("appimage");
      const image = installed(s);
      expect(await rollbackLinux("appimage", image, s.deps, hooks().h)).toMatchObject({
        state: "failed",
        code: "no_previous",
      });
    });

    it("will not go back to a kept copy that changed", async () => {
      const { s, image, running } = await updated();
      writeFileSync(join(s.paths.previousImageDir, "Psyche.AppImage"), "swapped");
      expect(await rollbackLinux("appimage", image, running, hooks().h)).toMatchObject({
        state: "failed",
        code: "hash_mismatch",
      });
      expect(readFileSync(image)).toEqual(NEW);
    });

    it("will not trust kept manifests that the embedded keys do not verify", async () => {
      const { image, running } = await updated();
      const { h, calls } = hooks();
      // The same files, but the app now trusts a different key (or the manifests were forged).
      const other = { ...running, keys: [throwawayKey().key] };
      expect(await rollbackLinux("appimage", image, other, h)).toMatchObject({
        state: "failed",
        code: "bad_manifest",
      });
      expect(calls).toEqual([]);
      expect(readFileSync(image)).toEqual(NEW);
    });

    it("will not trust a kept manifest edited on disk", async () => {
      const { s, image, running } = await updated();
      const manifest = join(s.paths.previousImageDir, "release-manifest.json");
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace("1.0.0", "0.0.1"));
      expect(await rollbackLinux("appimage", image, running, hooks().h)).toMatchObject({
        state: "failed",
        code: "bad_manifest",
      });
    });

    it("refuses a version below the minimum the newer release requires", async () => {
      const { image, running } = await updated("1.0.5");
      const { h, calls } = hooks();
      expect(await rollbackLinux("appimage", image, running, h)).toMatchObject({
        state: "failed",
        code: "below_minimum",
      });
      expect(calls).toEqual([]);
      expect(readFileSync(image)).toEqual(NEW);
    });

    it("refuses to go 'back' to a version that is not older than the running one", async () => {
      const { image, s } = await updated();
      const same = { ...s.deps, current: { version: "1.0.0", build: "b" } };
      expect(await rollbackLinux("appimage", image, same, hooks().h)).toMatchObject({
        state: "failed",
        code: "not_older",
      });
    });
  });
});

describe.each(["deb", "rpm"] as const)("%s", (kind) => {
  const PKG1 = Buffer.from(`${kind} one`.repeat(30));
  const PKG2 = Buffer.from(`${kind} two`.repeat(30));
  const install = { kind } as const;
  const trust = () => ({ keys: [trusted.key], arch: "x64" });

  it("verifies, stops the Gateway, runs the root-owned installer through pkexec, then restarts", async () => {
    const s = setup(kind);
    const staged = s.stage("1.1.0", PKG1);
    const res = await applyLinuxUpdate(staged, install, s.deps);
    expect(res).toEqual({ state: "applied", release: "1.1.0" });
    expect(s.commands).toEqual([installPackageCommand(sha(PKG1), staged.file, "install")]);
    expect(s.commands[0]?.slice(0, 3)).toEqual([
      "/usr/bin/pkexec",
      PACKAGED_SETUP,
      "install-package",
    ]);
    expect(s.events).toEqual(["prepare", "stop", "restart:update"]);
    expect(s.relaunched).toHaveLength(1);
    // The installed package is kept so that the next update can go back to it.
    expect(readFileSync(join(s.paths.packageDir, fileName(kind, "1.1.0")))).toEqual(PKG1);
  });

  it("keeps the app on the current version when the package manager refuses", async () => {
    const s = setup(kind);
    s.setPkexec({ code: 100, stderr: "E: Unable to satisfy dependencies" });
    const res = await applyLinuxUpdate(s.stage("1.1.0", PKG1), install, s.deps);
    expect(res).toMatchObject({ state: "failed", code: "package_manager_failed" });
    expect((res as { detail: string }).detail).toContain("Unable to satisfy");
    expect(s.events).toEqual(["prepare", "stop", "restart:update"]);
    expect(s.relaunched).toHaveLength(0);
  });

  it("treats a dismissed admin prompt as a cancel", async () => {
    const s = setup(kind);
    s.setPkexec({ code: 126 });
    expect(await applyLinuxUpdate(s.stage("1.1.0", PKG1), install, s.deps)).toEqual({
      state: "cancelled",
    });
    expect(s.relaunched).toHaveLength(0);
  });

  it("reports the installer's own hash check and a missing package manager", async () => {
    const s = setup(kind);
    s.setPkexec({ code: 65, stderr: "sha256 mismatch" });
    expect(await applyLinuxUpdate(s.stage("1.1.0", PKG1), install, s.deps)).toMatchObject({
      state: "failed",
      code: "hash_mismatch",
    });
    const t = setup(kind);
    t.setPkexec({ code: 69 });
    const staged = t.stage("1.1.0", PKG1);
    expect(await applyLinuxUpdate(staged, install, t.deps)).toEqual({
      state: "manual",
      reason: "no_package_manager",
      file: staged.file,
    });
  });

  it("re-hashes before pkexec: a tampered file never reaches the installer", async () => {
    const s = setup(kind);
    const staged = s.stage("1.1.0", PKG1);
    writeFileSync(staged.file, "evil");
    expect(await applyLinuxUpdate(staged, install, s.deps)).toMatchObject({
      state: "failed",
      code: "hash_mismatch",
    });
    expect(s.commands).toEqual([]);
  });

  it("is manual, changing nothing, where the packaged installer is not present", async () => {
    const s = setup(kind, { fs: nodeApplyFs });
    const staged = s.stage("1.1.0", PKG1);
    expect(await applyLinuxUpdate(staged, install, s.deps)).toEqual({
      state: "manual",
      reason: "no_package_manager",
      file: staged.file,
    });
    expect(s.events).toEqual([]);
    expect(s.commands).toEqual([]);
  });

  it("keeps the previous package on the second update and goes back to it with an admin prompt", async () => {
    const s = setup(kind);
    await applyLinuxUpdate(s.stage("1.1.0", PKG1), install, s.deps);
    const running = { ...s.deps, current: { version: "1.1.0", build: "b1" } };
    await applyLinuxUpdate(s.stage("1.2.0", PKG2), install, running);
    const kept = await previousArtifact(nodeApplyFs, s.paths, kind, trust());
    expect(kept).toMatchObject({
      version: "1.1.0",
      file: join(s.paths.previousPackageDir, fileName(kind, "1.1.0")),
    });
    s.commands.length = 0;
    s.events.length = 0;
    const { h, calls } = hooks();
    const res = await rollbackLinux(
      kind,
      undefined,
      { ...s.deps, current: { version: "1.2.0", build: "b2" } },
      h,
    );
    expect(res).toEqual({ state: "applied", release: "1.1.0" });
    expect(s.commands).toEqual([
      installPackageCommand(
        sha(PKG1),
        join(s.paths.previousPackageDir, fileName(kind, "1.1.0")),
        "downgrade",
      ),
    ]);
    expect(s.commands[0]).toContain("--downgrade");
    expect(calls).toEqual(["restore", "skip:1.2.0:b2"]);
    expect(s.events).toEqual(["stop", "restart:build_mismatch"]);
    // After going back nothing older is kept.
    expect(await previousArtifact(nodeApplyFs, s.paths, kind, trust())).toBeUndefined();
    expect(readFileSync(join(s.paths.packageDir, fileName(kind, "1.1.0")))).toEqual(PKG1);
  });

  it("restarts the Gateway and keeps the files when the downgrade is refused", async () => {
    const s = setup(kind);
    await applyLinuxUpdate(s.stage("1.1.0", PKG1), install, s.deps);
    await applyLinuxUpdate(s.stage("1.2.0", PKG2), install, {
      ...s.deps,
      current: { version: "1.1.0", build: "b1" },
    });
    s.events.length = 0;
    s.setPkexec({ code: 1, stderr: "held package" });
    const { h, calls } = hooks();
    const res = await rollbackLinux(
      kind,
      undefined,
      { ...s.deps, current: { version: "1.2.0", build: "b2" } },
      h,
    );
    expect(res).toMatchObject({ state: "failed", code: "package_manager_failed" });
    expect(calls).toEqual(["restore"]);
    expect(s.events).toEqual(["stop", "restart:update"]);
    expect(await previousArtifact(nodeApplyFs, s.paths, kind, trust())).toMatchObject({
      version: "1.1.0",
    });
  });

  it("will not downgrade to a kept package whose manifests do not verify", async () => {
    const s = setup(kind);
    await applyLinuxUpdate(s.stage("1.1.0", PKG1), install, s.deps);
    await applyLinuxUpdate(s.stage("1.2.0", PKG2), install, {
      ...s.deps,
      current: { version: "1.1.0", build: "b1" },
    });
    s.commands.length = 0;
    const { h, calls } = hooks();
    const res = await rollbackLinux(
      kind,
      undefined,
      { ...s.deps, keys: [throwawayKey().key], current: { version: "1.2.0", build: "b2" } },
      h,
    );
    expect(res).toMatchObject({ state: "failed", code: "bad_manifest" });
    expect(s.commands).toEqual([]);
    expect(calls).toEqual([]);
  });
});
