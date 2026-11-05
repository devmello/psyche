import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApplyDeps,
  type ApplyFs,
  applyLinuxUpdate,
  nodeApplyFs,
  previousArtifact,
  type RollbackHooks,
  rollbackLinux,
  type StagedUpdate,
} from "../../src/packaging/linux-apply.ts";
import type { UpdateGateway } from "../../src/packaging/linux-gateway.ts";
import { linuxUpdatePaths, type RunCommand } from "../../src/packaging/linux-install.ts";

/**
 * The Linux apply step with the real file system in a temp folder, a fake Gateway and a fake
 * `pkexec` (a recording RunCommand). Nothing here needs Linux, root or a package manager.
 */

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "psyche-apply-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(kind: "appimage" | "deb" | "rpm", over: Partial<ApplyDeps> = {}) {
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
  const deps: ApplyDeps = {
    fs: nodeApplyFs,
    run,
    gateway,
    paths,
    current: { version: "1.0.0", build: "build-old" },
    log: () => {},
    relaunch: () => void relaunched.push(1),
    ...over,
  };
  const stage = (release: string, name: string, bytes: Buffer): StagedUpdate => {
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
    };
  };
  return {
    paths,
    deps,
    events,
    commands,
    relaunched,
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

  function installed(s: ReturnType<typeof setup>) {
    const dir = join(root, "Applications");
    mkdirSync(dir, { recursive: true });
    const image = join(dir, "Psyche.AppImage");
    writeFileSync(image, OLD, { mode: 0o755 });
    return image;
  }

  it("keeps the running image, stops the Gateway, swaps the file, restarts and relaunches", async () => {
    const s = setup("appimage");
    const image = installed(s);
    const staged = s.stage("1.1.0", "Psyche-1.1.0-linux-x64.AppImage", NEW);
    const res = await applyLinuxUpdate(staged, { kind: "appimage", appImagePath: image }, s.deps);
    expect(res).toEqual({ state: "applied", release: "1.1.0" });
    expect(readFileSync(image)).toEqual(NEW);
    expect(statSync(image).mode & 0o777).toBe(0o755);
    expect(existsSync(staged.file)).toBe(false);
    expect(s.events).toEqual(["prepare", "stop", "restart:update"]);
    expect(s.relaunched).toHaveLength(1);
    const kept = await previousArtifact(nodeApplyFs, s.paths, "appimage");
    expect(kept).toMatchObject({
      version: "1.0.0",
      build: "build-old",
      kind: "appimage",
      sha256: sha(OLD),
    });
    expect(readFileSync(join(s.paths.previousImageDir, "Psyche.AppImage"))).toEqual(OLD);
    expect(s.commands).toEqual([]);
  });

  it("refuses a staged file that changed after verification, and removes it", async () => {
    const s = setup("appimage");
    const image = installed(s);
    const staged = s.stage("1.1.0", "Psyche-1.1.0-linux-x64.AppImage", NEW);
    writeFileSync(staged.file, "tampered");
    const res = await applyLinuxUpdate(staged, { kind: "appimage", appImagePath: image }, s.deps);
    expect(res).toMatchObject({ state: "failed", code: "hash_mismatch" });
    expect(readFileSync(image)).toEqual(OLD);
    expect(existsSync(staged.file)).toBe(false);
    expect(s.events).toEqual([]);
  });

  it("reports a missing file", async () => {
    const s = setup("appimage");
    const image = installed(s);
    const staged = s.stage("1.1.0", "Psyche-1.1.0-linux-x64.AppImage", NEW);
    rmSync(staged.file);
    expect(
      await applyLinuxUpdate(staged, { kind: "appimage", appImagePath: image }, s.deps),
    ).toMatchObject({
      state: "failed",
      code: "missing_file",
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "falls back to a manual download when the folder is not writable",
    async () => {
      const s = setup("appimage");
      const image = installed(s);
      chmodSync(join(root, "Applications"), 0o555);
      const staged = s.stage("1.1.0", "Psyche-1.1.0-linux-x64.AppImage", NEW);
      const res = await applyLinuxUpdate(staged, { kind: "appimage", appImagePath: image }, s.deps);
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
        if (from.endsWith(".AppImage") && to.endsWith("Psyche.AppImage") && !to.endsWith(".tmp")) {
          const err = new Error("cross-device") as NodeJS.ErrnoException;
          err.code = "EXDEV";
          throw err;
        }
        return nodeApplyFs.rename(from, to);
      },
    };
    const s = setup("appimage", { fs });
    const image = installed(s);
    const staged = s.stage("1.1.0", "Psyche-1.1.0-linux-x64.AppImage", NEW);
    const res = await applyLinuxUpdate(staged, { kind: "appimage", appImagePath: image }, s.deps);
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
    const staged = s.stage("1.1.0", "Psyche-1.1.0-linux-x64.AppImage", NEW);
    const res = await applyLinuxUpdate(staged, { kind: "appimage", appImagePath: image }, s.deps);
    expect(res).toMatchObject({ state: "failed", code: "swap_failed" });
    expect(readFileSync(image)).toEqual(OLD);
    expect(s.events).toEqual(["prepare", "stop", "restart:update"]);
    expect(s.relaunched).toHaveLength(0);
  });

  it("rolls back: restores the kept image, the data snapshot and the skip entry, then restarts", async () => {
    const s = setup("appimage");
    const image = installed(s);
    await applyLinuxUpdate(
      s.stage("1.1.0", "Psyche-1.1.0-linux-x64.AppImage", NEW),
      { kind: "appimage", appImagePath: image },
      s.deps,
    );
    s.events.length = 0;
    const { h, calls } = hooks();
    const running = { ...s.deps, current: { version: "1.1.0", build: "build-new" } };
    const res = await rollbackLinux("appimage", image, running, h);
    expect(res).toEqual({ state: "applied", release: "1.0.0" });
    expect(readFileSync(image)).toEqual(OLD);
    expect(calls).toEqual(["restore", "skip:1.1.0:build-new"]);
    expect(s.events).toEqual(["stop", "restart:build_mismatch"]);
    expect(await previousArtifact(nodeApplyFs, s.paths, "appimage")).toBeUndefined();
  });

  it("will not roll back to a kept copy that changed, or when none is kept", async () => {
    const s = setup("appimage");
    const image = installed(s);
    const { h } = hooks();
    expect(await rollbackLinux("appimage", image, s.deps, h)).toMatchObject({
      state: "failed",
      code: "no_previous",
    });
    await applyLinuxUpdate(
      s.stage("1.1.0", "Psyche-1.1.0-linux-x64.AppImage", NEW),
      { kind: "appimage", appImagePath: image },
      s.deps,
    );
    writeFileSync(join(s.paths.previousImageDir, "Psyche.AppImage"), "swapped");
    expect(await rollbackLinux("appimage", image, s.deps, h)).toMatchObject({
      state: "failed",
      code: "hash_mismatch",
    });
    expect(readFileSync(image)).toEqual(NEW);
  });
});

describe.each([
  ["deb", "/usr/bin/apt-get", ["install", "--yes"]],
  ["rpm", "/usr/bin/dnf", ["install", "--assumeyes"]],
] as const)("%s", (kind, tool, args) => {
  const PKG1 = Buffer.from(`${kind} one`.repeat(30));
  const PKG2 = Buffer.from(`${kind} two`.repeat(30));
  const name = (v: string) => `Psyche-${v}-linux-x64.${kind}`;
  const install = { kind } as const;

  /** dnf is looked up on disk; make the rpm case see it by faking fs.access for /usr/bin/dnf. */
  const withTools = (): Partial<ApplyDeps> => ({
    fs: {
      ...nodeApplyFs,
      access: async (p, m) => {
        if (p === "/usr/bin/dnf") return;
        return nodeApplyFs.access(p, m);
      },
    },
  });

  it("verifies, stops the Gateway, runs the package manager through pkexec, then restarts", async () => {
    const s = setup(kind, withTools());
    const staged = s.stage("1.1.0", name("1.1.0"), PKG1);
    const res = await applyLinuxUpdate(staged, install, s.deps);
    expect(res).toEqual({ state: "applied", release: "1.1.0" });
    expect(s.commands).toEqual([["/usr/bin/pkexec", tool, ...args, staged.file]]);
    expect(s.events).toEqual(["prepare", "stop", "restart:update"]);
    expect(s.relaunched).toHaveLength(1);
    // The installed package is kept so that the next update can go back to it.
    expect(readFileSync(join(s.paths.packageDir, name("1.1.0")))).toEqual(PKG1);
  });

  it("keeps the app on the current version when the package manager refuses", async () => {
    const s = setup(kind, withTools());
    s.setPkexec({ code: 100, stderr: "E: Unable to satisfy dependencies" });
    const res = await applyLinuxUpdate(s.stage("1.1.0", name("1.1.0"), PKG1), install, s.deps);
    expect(res).toMatchObject({ state: "failed", code: "package_manager_failed" });
    expect((res as { detail: string }).detail).toContain("Unable to satisfy");
    expect(s.events).toEqual(["prepare", "stop", "restart:update"]);
    expect(s.relaunched).toHaveLength(0);
  });

  it("treats a dismissed admin prompt as a cancel", async () => {
    const s = setup(kind, withTools());
    s.setPkexec({ code: 126 });
    const res = await applyLinuxUpdate(s.stage("1.1.0", name("1.1.0"), PKG1), install, s.deps);
    expect(res).toEqual({ state: "cancelled" });
    expect(s.relaunched).toHaveLength(0);
  });

  it("re-hashes before pkexec: a tampered file never reaches the package manager", async () => {
    const s = setup(kind, withTools());
    const staged = s.stage("1.1.0", name("1.1.0"), PKG1);
    writeFileSync(staged.file, "evil");
    const res = await applyLinuxUpdate(staged, install, s.deps);
    expect(res).toMatchObject({ state: "failed", code: "hash_mismatch" });
    expect(s.commands).toEqual([]);
  });

  it("keeps the previous package on the second update and goes back to it with an admin prompt", async () => {
    const s = setup(kind, withTools());
    await applyLinuxUpdate(s.stage("1.1.0", name("1.1.0"), PKG1), install, s.deps);
    const running = { ...s.deps, current: { version: "1.1.0", build: "b1" } };
    await applyLinuxUpdate(s.stage("1.2.0", name("1.2.0"), PKG2), install, running);
    const kept = await previousArtifact(nodeApplyFs, s.paths, kind);
    expect(kept).toMatchObject({ version: "1.1.0", file: name("1.1.0") });
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
    const down =
      kind === "deb" ? ["install", "--yes", "--allow-downgrades"] : ["downgrade", "--assumeyes"];
    expect(s.commands).toEqual([
      ["/usr/bin/pkexec", tool, ...down, join(s.paths.previousPackageDir, name("1.1.0"))],
    ]);
    expect(calls).toEqual(["restore", "skip:1.2.0:b2"]);
    expect(s.events).toEqual(["stop", "restart:build_mismatch"]);
    // After going back nothing older is kept.
    expect(await previousArtifact(nodeApplyFs, s.paths, kind)).toBeUndefined();
    expect(readFileSync(join(s.paths.packageDir, name("1.1.0")))).toEqual(PKG1);
  });

  it("restarts the Gateway and keeps the files when the downgrade is refused", async () => {
    const s = setup(kind, withTools());
    await applyLinuxUpdate(s.stage("1.1.0", name("1.1.0"), PKG1), install, s.deps);
    await applyLinuxUpdate(s.stage("1.2.0", name("1.2.0"), PKG2), install, s.deps);
    s.events.length = 0;
    s.setPkexec({ code: 1, stderr: "held package" });
    const { h, calls } = hooks();
    const res = await rollbackLinux(kind, undefined, s.deps, h);
    expect(res).toMatchObject({ state: "failed", code: "package_manager_failed" });
    expect(calls).toEqual([]);
    expect(s.events).toEqual(["stop", "restart:update"]);
    expect(await previousArtifact(nodeApplyFs, s.paths, kind)).toMatchObject({ version: "1.1.0" });
  });
});

describe("rpm without dnf", () => {
  it("has no package manager here and says so, changing nothing", async () => {
    const s = setup("rpm", {
      fs: {
        ...nodeApplyFs,
        access: async (p, m) => {
          if (p === "/usr/bin/dnf" || p === "/usr/bin/zypper") throw new Error("ENOENT");
          return nodeApplyFs.access(p, m);
        },
      },
    });
    const staged = s.stage("1.1.0", "Psyche-1.1.0-linux-x64.rpm", Buffer.from("rpm"));
    expect(await applyLinuxUpdate(staged, { kind: "rpm" }, s.deps)).toEqual({
      state: "manual",
      reason: "no_package_manager",
      file: staged.file,
    });
    expect(s.events).toEqual([]);
  });
});
