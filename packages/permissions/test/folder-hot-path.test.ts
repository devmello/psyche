import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FOLDER_FRESH_MS, FOLDER_STALE_CAP_MS } from "../src/broker.ts";
import { call, makeBroker, path } from "./helpers.ts";

/**
 * PR #1395 review r1, finding 2: a live synchronous realpath on every `folderFor` and
 * `grantedFolders()` froze the event loop on a hung SMB or NFS mount. The broker now judges
 * granted roots from a cache refreshed asynchronously (one lookup in flight per path); a stale
 * entry keeps its last verdict, and one with no completed look for FOLDER_STALE_CAP_MS while a
 * refresh is outstanding is refused. These tests watch every filesystem call on the roots.
 */
const probe = vi.hoisted(() => ({
  /** Paths whose calls are recorded. */
  roots: new Set<string>(),
  /** Synchronous calls made on a watched path. */
  sync: [] as string[],
  /** Asynchronous lookups started on a watched path. */
  lookups: [] as string[],
  /** Paths whose asynchronous lookups hang until released. */
  hang: new Set<string>(),
  held: [] as (() => void)[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const trap =
    (name: string, f: (...a: never[]) => unknown) =>
    (...a: unknown[]): unknown => {
      if (probe.roots.has(String(a[0]))) probe.sync.push(`${name} ${String(a[0])}`);
      return (f as (...x: unknown[]) => unknown)(...a);
    };
  const realpathSync = Object.assign(trap("realpathSync", fs.realpathSync), {
    native: trap("realpathSync.native", fs.realpathSync.native),
  });
  const over = {
    realpathSync,
    lstatSync: trap("lstatSync", fs.lstatSync),
    statSync: trap("statSync", fs.statSync),
    existsSync: trap("existsSync", fs.existsSync),
    readlinkSync: trap("readlinkSync", fs.readlinkSync),
    accessSync: trap("accessSync", fs.accessSync),
  };
  return { ...fs, ...over, default: { ...fs, ...over } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const fsp = await importOriginal<typeof import("node:fs/promises")>();
  const gate =
    (f: (...a: never[]) => Promise<unknown>) =>
    (...a: unknown[]): Promise<unknown> => {
      const p = String(a[0]);
      if (probe.roots.has(p)) probe.lookups.push(p);
      const go = () => (f as (...x: unknown[]) => Promise<unknown>)(...a);
      if (!probe.hang.has(p)) return go();
      return new Promise((resolve, reject) => {
        probe.held.push(() => void go().then(resolve, reject));
      });
    };
  const over = { realpath: gate(fsp.realpath), lstat: gate(fsp.lstat) };
  return { ...fsp, ...over, default: { ...fsp, ...over } };
});

const ctx = { threadId: "thr_a", runId: "run_1", permissionMode: "balanced", taint: false };

async function tree() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "psy-hot-")));
  const granted = join(home, "Projects", "app");
  const missing = join(home, "Projects", "later");
  const linked = join(home, "Projects", "docs");
  await mkdir(granted, { recursive: true });
  await mkdir(join(home, "Documents"));
  await symlink(join(home, "Documents"), linked);
  for (const p of [granted, missing, linked, join(home, "Projects")]) probe.roots.add(p);
  return { home, granted, missing, linked };
}

function release(): void {
  probe.hang.clear();
  for (const go of probe.held.splice(0)) go();
}

describe.skipIf(process.platform === "win32")("granted roots on the decide path", () => {
  it("no synchronous filesystem call on a granted root: start, reads, decides, refreshes, setPolicy", async () => {
    const { home, granted, missing, linked } = await tree();
    probe.sync.length = 0;
    const folders = [granted, missing, linked].map((p) => ({ path: p, mode: "rw" as const }));
    const h = makeBroker({ policy: { folders }, hostProgram: { home } });
    for (let i = 0; i < 3; i++) {
      for (const p of [granted, missing, linked]) h.broker.folderRefused(p);
      h.broker.grantedFolders();
      h.broker.liveSessionFolders("thr_a");
      await h.broker.decide(call("read_file", "read", path(join(granted, "a.txt"))), ctx as never);
      await h.broker.decide(call("write_file", "write", path(join(linked, "b.txt"))), ctx as never);
      h.broker.setPolicy({ folders });
      h.clock.advance(FOLDER_FRESH_MS + 1);
      await h.broker.foldersSettled();
    }
    expect(probe.sync).toEqual([]);
    // The looks did happen, asynchronously.
    expect(probe.lookups).toContain(granted);
    expect(h.broker.grantedFolders().map((f) => f.path)).toEqual([granted, missing]);
  });

  it("a hung mount: one lookup in flight, the last verdict holds, past the cap it is refused", async () => {
    const { home, granted } = await tree();
    const h = makeBroker({
      policy: { folders: [{ path: granted, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(granted)).toBe(false);
    probe.hang.add(granted);
    probe.lookups.length = 0;
    h.clock.advance(FOLDER_FRESH_MS + 1);
    // Stale: a refresh starts (and hangs); the last verdict holds, and no read waits on it.
    for (let i = 0; i < 50; i++) expect(h.broker.folderRefused(granted)).toBe(false);
    expect(h.broker.grantedFolders()).toHaveLength(1);
    const started = Date.now();
    const d = await h.broker.decide(
      call("write_file", "write", path(join(granted, "a.txt"))),
      ctx as never,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(d).toMatchObject({ decision: "allow", rule: "folder:rw" });
    // One lookup in flight for the path, however many reads.
    expect(probe.lookups.filter((p) => p === granted)).toEqual([granted]);
    // The refresh outstanding for the cap: refused, and a decide waits only briefly once.
    h.clock.advance(FOLDER_STALE_CAP_MS + 1);
    expect(h.broker.folderRefused(granted)).toBe(true);
    expect(h.broker.grantedFolders()).toEqual([]);
    const t0 = Date.now();
    const late = await h.broker.decide(
      call("write_file", "write", path(join(granted, "a.txt"))),
      ctx as never,
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(late).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
    expect(probe.lookups.filter((p) => p === granted)).toEqual([granted]);
    // The mount answers again: the outstanding look lands and the folder counts.
    release();
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(granted)).toBe(false);
  });

  it("a root nobody read for a long while keeps counting while its refresh runs", async () => {
    const { home, granted } = await tree();
    const h = makeBroker({
      policy: { folders: [{ path: granted, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    h.clock.advance(10 * FOLDER_STALE_CAP_MS);
    expect(h.broker.folderRefused(granted)).toBe(false);
    expect(h.broker.grantedFolders()).toHaveLength(1);
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(granted)).toBe(false);
  });

  it("a first look that hangs makes an evaluation wait briefly, not for the mount", async () => {
    const { home, granted } = await tree();
    probe.hang.add(granted);
    const h = makeBroker({
      policy: { folders: [{ path: granted, mode: "rw" }] },
      hostProgram: { home },
    });
    const t0 = Date.now();
    await h.broker.decide(call("read_file", "read", path(join(granted, "a.txt"))), ctx as never);
    expect(Date.now() - t0).toBeLessThan(2_000);
    h.clock.advance(FOLDER_STALE_CAP_MS + 1);
    expect(h.broker.folderRefused(granted)).toBe(true);
    release();
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(granted)).toBe(false);
  });

  it("a swap is seen by the engine within the fresh window, without a synchronous look", async () => {
    const { home, granted } = await tree();
    const h = makeBroker({
      policy: { folders: [{ path: granted, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    probe.sync.length = 0;
    const { rm } = await import("node:fs/promises");
    await rm(granted, { recursive: true });
    await symlink(join(home, "Documents"), granted);
    h.clock.advance(FOLDER_FRESH_MS + 1);
    // The first read after the window starts the refresh; once it lands the root is refused.
    h.broker.grantedFolders();
    await h.broker.foldersSettled();
    const d = await h.broker.decide(
      call("write_file", "write", path(join(granted, "a.txt"))),
      ctx as never,
    );
    expect(d).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
    expect(probe.sync).toEqual([]);
  });
});
