import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #1483 r1 finding 2: `access.list` must keep its time bound when a granted mount hangs. The
 * lstat of a vanished folder never returns here; the list still answers within a moment, and a
 * second list does not start a second blocked call (one search in flight per path).
 */

const hang = vi.hoisted(() => ({
  path: "",
  armed: false,
  lstats: 0,
  readdirs: [] as string[],
  /** A directory whose readdir never returns (a hung share), and how often it was called. */
  readdirHang: "",
  readdirHangs: 0,
}));

vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    lstat: ((p: string, ...rest: unknown[]) => {
      if (hang.armed && p === hang.path) {
        hang.lstats++;
        return new Promise(() => {});
      }
      return (real.lstat as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.lstat,
    readdir: ((p: string, ...rest: unknown[]) => {
      hang.readdirs.push(String(p));
      if (hang.readdirHang !== "" && p === hang.readdirHang) {
        hang.readdirHangs++;
        return new Promise(() => {});
      }
      return (real.readdir as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readdir,
  };
});

const { accessEntries } = await import("../src/handlers.ts");
const { makeBroker } = await import("./helpers.ts");
const { folderRefOf } = await import("../src/index.ts");

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const REF = { dev: "1", ino: "2", birth: "3" };

function broker(home: string, path: string) {
  return makeBroker({
    policy: { folders: [{ path, mode: "rw", real: path, ref: REF }] },
    hostProgram: { home },
    folderAccess: {
      env: () => ({ home }),
      persist: async () => {},
      repoint: async () => true,
      recordRef: () => {},
    },
  });
}

describe("a hung mount does not stall access.list", () => {
  it("answers within the bound, with one blocked call however often it is listed", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psyche-hang-")));
    dirs.push(home);
    const nas = join(home, "nas", "share");
    hang.path = nas;
    hang.lstats = 0;
    hang.armed = false;
    const h = broker(home, nas);
    await mkdir(join(home, "nas"), { recursive: true });
    // The root's own look finishes (the share is merely absent); the mount then hangs on the
    // reconnect search's lstat.
    await h.broker.foldersSettled();
    hang.armed = true;
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      const entries = await accessEntries(h.broker);
      expect(Date.now() - t).toBeLessThan(2000);
      expect(entries.find((e) => e.path === nas)?.reconnectTo).toBeUndefined();
    }
    expect(hang.lstats).toBe(1);
  });

  it("never opens an unshared folder of home (no privacy prompt for Documents)", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psyche-hang-")));
    dirs.push(home);
    hang.path = "";
    hang.armed = false;
    hang.readdirs = [];
    const gone = join(home, "Projects", "app");
    await mkdir(join(home, "Projects"), { recursive: true });
    await mkdir(join(home, "Documents", "deep"), { recursive: true });
    const h = broker(home, gone);
    await h.broker.foldersSettled();
    await h.broker.folderReconnectOffer(gone);
    expect(hang.readdirs).not.toContain(join(home, "Documents"));
    expect(hang.readdirs).toContain(join(home, "Projects"));
  });
});

describe("the search stays inside what the owner opened (#1483 r2)", () => {
  const settle = async (h: ReturnType<typeof makeBroker>) => {
    await h.broker.foldersSettled();
  };

  function brokerFor(home: string, folders: { path: string; ref?: unknown }[]) {
    return makeBroker({
      policy: {
        folders: folders.map((f) => ({
          path: f.path,
          mode: "rw" as const,
          real: f.path,
          ...(f.ref ? { ref: f.ref as typeof REF } : {}),
        })),
      },
      hostProgram: { home },
      folderAccess: {
        env: () => ({ home }),
        persist: async () => {},
        repoint: async () => true,
        recordRef: () => {},
      },
    });
  }

  it("P16: a hung granted root gets one blocked call, however often the policy is written", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psyche-hang-")));
    dirs.push(home);
    const nas = join(home, "nas");
    const gone = join(home, "Projects", "app");
    await mkdir(nas, { recursive: true });
    await mkdir(join(home, "Projects"), { recursive: true });
    hang.armed = false;
    hang.readdirs = [];
    hang.readdirHang = nas;
    hang.readdirHangs = 0;
    const h = brokerFor(home, [{ path: gone, ref: REF }, { path: nas }]);
    await settle(h);
    for (let i = 0; i < 4; i++) {
      const t = Date.now();
      await accessEntries(h.broker);
      expect(Date.now() - t).toBeLessThan(2000);
      h.broker.setPolicy(h.broker.policy);
    }
    expect(hang.readdirHangs).toBeLessThanOrEqual(1);
    hang.readdirHang = "";
  });

  it("P15b: a grant directly in home never opens Desktop, Documents or Downloads", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psyche-hang-")));
    dirs.push(home);
    for (const d of ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"]) {
      await mkdir(join(home, d), { recursive: true });
    }
    const stored = join(home, "proj");
    await mkdir(stored);
    const ref = await folderRefOf(stored);
    const renamed = join(home, "proj2");
    await rename(stored, renamed);
    hang.armed = false;
    hang.readdirHang = "";
    hang.readdirs = [];
    const h = brokerFor(home, [{ path: stored, ref }]);
    await settle(h);
    // Still found: the children of home are looked at, not opened.
    expect(await h.broker.folderReconnectOffer(stored)).toBe(renamed);
    const opened = hang.readdirs.map((d) => d.slice(home.length));
    for (const d of ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"]) {
      expect(opened).not.toContain(`/${d}`);
    }
    expect(opened.filter((d) => d !== "")).toEqual([]);
  });

  it("P15b: a guarded folder is opened when it is granted", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psyche-hang-")));
    dirs.push(home);
    const docs = join(home, "Documents");
    await mkdir(join(docs, "work"), { recursive: true });
    const stored = join(home, "proj");
    await mkdir(stored);
    const ref = await folderRefOf(stored);
    const moved = join(docs, "work", "proj");
    await rename(stored, moved);
    hang.armed = false;
    hang.readdirHang = "";
    hang.readdirs = [];
    const h = brokerFor(home, [{ path: stored, ref }, { path: docs }]);
    await settle(h);
    expect(await h.broker.folderReconnectOffer(stored)).toBe(moved);
  });

  it("P15c: a parent outside home (a volumes-like root) has its children looked at, never opened", async () => {
    const vol = await realpath(await mkdtemp(join(tmpdir(), "psyche-vol-")));
    const home = await realpath(await mkdtemp(join(tmpdir(), "psyche-home-")));
    dirs.push(vol, home);
    for (const d of ["Macintosh", "Backup", "Share"]) await mkdir(join(vol, d));
    const stored = join(vol, "proj");
    await mkdir(stored);
    const ref = await folderRefOf(stored);
    const renamed = join(vol, "proj2");
    await rename(stored, renamed);
    hang.armed = false;
    hang.readdirHang = "";
    hang.readdirs = [];
    const h = brokerFor(home, [{ path: stored, ref }]);
    await settle(h);
    expect(await h.broker.folderReconnectOffer(stored)).toBe(renamed);
    expect(hang.readdirs.filter((d) => d.startsWith(vol) && d !== vol)).toEqual([]);
  });
});
