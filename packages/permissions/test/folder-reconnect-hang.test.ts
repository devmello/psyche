import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
      return (real.readdir as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readdir,
  };
});

const { accessEntries } = await import("../src/handlers.ts");
const { makeBroker } = await import("./helpers.ts");

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
