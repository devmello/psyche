import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessEntries, createPermissionHandlers } from "../src/handlers.ts";
import { type FolderRef, folderRefOf } from "../src/index.ts";
import { makeBroker } from "./helpers.ts";

/**
 * Reconnecting a granted folder the owner renamed or moved (Cowork parity). The offer is made only
 * for a vanished path whose recorded identity (volume + inode + birth time) is found in a few
 * places; the owner's tap re-points it, after every check of a fresh grant. A swapped root, a
 * link or another folder at the target is refused (#1384, #1387, #1388, #1389, #1395), and a
 * nested override moves with its parent or nothing moves (#1483 r1).
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tree() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "psyche-reconnect-")));
  dirs.push(home);
  const granted = join(home, "Projects", "app");
  await mkdir(granted, { recursive: true });
  await mkdir(join(home, "Documents"), { recursive: true });
  const ref = (await folderRefOf(granted)) as FolderRef;
  return { home, granted, ref };
}

type Entry = { path: string; mode: "ro" | "rw"; ref?: FolderRef | undefined };

function setupWith(home: string, folders: Entry[], extra: Record<string, unknown> = {}) {
  const repoint = vi.fn(async (_moves: readonly { from: string; to: string }[]) => true);
  const recordRef = vi.fn();
  const h = makeBroker({
    policy: {
      folders: folders.map((f) => ({
        path: f.path,
        mode: f.mode,
        real: f.path,
        ...(f.ref ? { ref: f.ref } : {}),
      })),
      ...extra,
    },
    hostProgram: { home },
    folderAccess: { env: () => ({ home }), persist: async () => {}, repoint, recordRef },
  });
  return { ...h, repoint, recordRef };
}

const setup = (home: string, granted: string, ref: FolderRef | undefined) =>
  setupWith(home, [{ path: granted, mode: "rw", ref }]);

/** The offer after the first looks settled, as `access.list` waits for them. */
const offerOf = async (
  h: {
    broker: {
      foldersSettled(): Promise<void>;
      folderReconnectOffer(p: string): Promise<string | undefined>;
    };
  },
  path: string,
) => {
  await h.broker.foldersSettled();
  return h.broker.folderReconnectOffer(path);
};

const BY = { deviceId: "dev_mac" };

describe("folder reconnect offer", () => {
  it("offers the new place after a rename in Finder, and re-points only on the owner's tap", async () => {
    const { home, granted, ref } = await tree();
    const renamed = join(home, "Projects", "app-renamed");
    await rename(granted, renamed);
    const h = setup(home, granted, ref);
    const entries = await accessEntries(h.broker);
    expect(entries.find((e) => e.path === granted)?.reconnectTo).toBe(renamed);
    // Listing alone never re-points.
    expect(h.repoint).not.toHaveBeenCalled();
    expect(await h.broker.reconnectFolder(granted, renamed, BY)).toBe(true);
    expect(h.repoint).toHaveBeenCalledWith([{ from: granted, to: renamed }], BY);
    // The owner's tap is recorded.
    const audit = await h.audit.query({ kind: "folder.reconnected" });
    expect(audit).toHaveLength(1);
  });

  it("finds a folder moved up to an ancestor's direct children (home)", async () => {
    const { home, granted, ref } = await tree();
    const moved = join(home, "app");
    await rename(granted, moved);
    const h = setup(home, granted, ref);
    expect(await offerOf(h, granted)).toBe(moved);
  });

  it("finds a folder moved inside another granted folder", async () => {
    const { home, granted, ref } = await tree();
    const docs = join(home, "Documents");
    await mkdir(join(docs, "work"), { recursive: true });
    const moved = join(docs, "work", "app");
    await rename(granted, moved);
    const h = setupWith(home, [
      { path: granted, mode: "rw", ref },
      { path: docs, mode: "ro" },
    ]);
    expect(await offerOf(h, granted)).toBe(moved);
  });

  it("does not search the rest of home: a move into an unshared Documents is not offered", async () => {
    const { home, granted, ref } = await tree();
    await rename(granted, join(home, "Documents", "app"));
    const h = setup(home, granted, ref);
    expect(await offerOf(h, granted)).toBeUndefined();
  });

  it("offers nothing while the path is still there, or when no identity was recorded", async () => {
    const { home, granted, ref } = await tree();
    expect(await setup(home, granted, ref).broker.folderReconnectOffer(granted)).toBeUndefined();
    await rename(granted, join(home, "Projects", "other"));
    expect(await setup(home, granted, undefined).broker.folderReconnectOffer(granted)).toBe(
      undefined,
    );
  });

  it("records the identity at the first look, and takes a new one for a re-created folder", async () => {
    const { home, granted, ref } = await tree();
    const h = setup(home, granted, undefined);
    await h.broker.foldersSettled();
    h.broker.folderRefused(granted);
    await vi.waitFor(() => expect(h.recordRef).toHaveBeenCalledWith(granted, ref));
    // A stale identity (the folder was re-created at the same path) is refreshed.
    const stale = { ...ref, birth: "1" };
    const h2 = setup(home, granted, stale);
    await h2.broker.foldersSettled();
    h2.broker.folderRefused(granted);
    await vi.waitFor(() => expect(h2.recordRef).toHaveBeenCalledWith(granted, ref));
  });
});

describe("folder reconnect refusals (swapped roots and links stay refused)", () => {
  it("refuses a swapped root: the old path now holds another folder", async () => {
    const { home, granted, ref } = await tree();
    const renamed = join(home, "Projects", "app-renamed");
    await rename(granted, renamed);
    await mkdir(granted); // a different folder took the name
    const h = setup(home, granted, ref);
    expect(await offerOf(h, granted)).toBeUndefined();
    expect(await h.broker.reconnectFolder(granted, renamed, BY)).toBe(false);
    expect(h.repoint).not.toHaveBeenCalled();
  });

  it("refuses an old path swapped for a link, even to the renamed folder", async () => {
    const { home, granted, ref } = await tree();
    const renamed = join(home, "Projects", "app-renamed");
    await rename(granted, renamed);
    await symlink(renamed, granted);
    const h = setup(home, granted, ref);
    expect(await h.broker.reconnectFolder(granted, renamed, BY)).toBe(false);
    expect(h.repoint).not.toHaveBeenCalled();
  });

  it("refuses a target that is a link to the folder", async () => {
    const { home, granted, ref } = await tree();
    const real = join(home, "Documents", "app");
    await rename(granted, real);
    const link = join(home, "Projects", "app-link");
    await symlink(real, link);
    const h = setup(home, granted, ref);
    expect(await h.broker.reconnectFolder(granted, link, BY)).toBe(false);
    expect(h.repoint).not.toHaveBeenCalled();
  });

  it("refuses a target reached through a linked parent", async () => {
    const { home, granted, ref } = await tree();
    const real = join(home, "Documents", "app");
    await rename(granted, real);
    const parentLink = join(home, "Projects", "docs");
    await symlink(join(home, "Documents"), parentLink);
    const h = setup(home, granted, ref);
    expect(await h.broker.reconnectFolder(granted, join(parentLink, "app"), BY)).toBe(false);
    expect(h.repoint).not.toHaveBeenCalled();
  });

  it("refuses a different folder at the target (another inode)", async () => {
    const { home, granted, ref } = await tree();
    await rename(granted, join(home, "Documents", "app"));
    const imposter = join(home, "Projects", "imposter");
    await mkdir(imposter);
    const h = setup(home, granted, ref);
    expect(await h.broker.reconnectFolder(granted, imposter, BY)).toBe(false);
    expect(h.repoint).not.toHaveBeenCalled();
  });

  it("refuses a reused inode: same volume and inode but another birth time is another folder", async () => {
    const { home, granted, ref } = await tree();
    const renamed = join(home, "Projects", "app-renamed");
    await rename(granted, renamed);
    const reused = { ...ref, birth: (BigInt(ref.birth) + 1n).toString() };
    const h = setup(home, granted, reused);
    expect(await offerOf(h, granted)).toBeUndefined();
    expect(await h.broker.reconnectFolder(granted, renamed, BY)).toBe(false);
    expect(h.repoint).not.toHaveBeenCalled();
  });

  it("runs the fresh-grant check: a sensitive place is refused even for the same folder", async () => {
    const { home, granted, ref } = await tree();
    const inLibrary = join(home, "Library", "app");
    await mkdir(join(home, "Library"));
    await rename(granted, inLibrary);
    const h = setup(home, granted, ref);
    // The search never looks in ~/Library, and a direct re-point there is refused as a grant.
    expect(await offerOf(h, granted)).toBeUndefined();
    await expect(h.broker.reconnectFolder(granted, inLibrary, BY)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(h.repoint).not.toHaveBeenCalled();
  });

  it("is a no-op for a path that is not a granted folder", async () => {
    const { home, granted, ref } = await tree();
    const h = setup(home, granted, ref);
    expect(await h.broker.reconnectFolder(join(home, "nope"), granted, BY)).toBe(false);
  });

  it("a refused tap drops the cached offer, and a policy write clears all of them", async () => {
    const { home, granted, ref } = await tree();
    const renamed = join(home, "Projects", "app-renamed");
    await rename(granted, renamed);
    const h = setup(home, granted, ref);
    expect(await offerOf(h, granted)).toBe(renamed);
    // The folder moves again after the offer was made: the tap is refused ...
    const again = join(home, "Projects", "app-again");
    await rename(renamed, again);
    expect(await h.broker.reconnectFolder(granted, renamed, BY)).toBe(false);
    // ... and the next list shows the new place, not the cached one.
    expect(await offerOf(h, granted)).toBe(again);
    h.broker.setPolicy(h.broker.policy);
    await rename(again, renamed);
    expect(await offerOf(h, granted)).toBe(renamed);
  });
});

describe("a nested override moves with its parent, or nothing moves (#1483 r1, P1)", () => {
  async function nested() {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psyche-reconnect-")));
    dirs.push(home);
    const parent = join(home, "Work", "A");
    const secret = join(parent, "secret");
    await mkdir(secret, { recursive: true });
    const pRef = (await folderRefOf(parent)) as FolderRef;
    const sRef = (await folderRefOf(secret)) as FolderRef;
    const renamed = join(home, "Work", "A2");
    return { home, parent, secret, pRef, sRef, renamed };
  }

  it("re-points the read-only sub-folder in the same write, so it stays read only", async () => {
    const n = await nested();
    await rename(n.parent, n.renamed);
    const h = setupWith(n.home, [
      { path: n.parent, mode: "rw", ref: n.pRef },
      { path: n.secret, mode: "ro", ref: n.sRef },
    ]);
    expect(await h.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(true);
    expect(h.repoint).toHaveBeenCalledWith(
      [
        { from: n.parent, to: n.renamed },
        { from: n.secret, to: join(n.renamed, "secret") },
      ],
      BY,
    );
  });

  it("moves nothing when the sub-folder's identity is not recorded, or no longer matches", async () => {
    const n = await nested();
    await rename(n.parent, n.renamed);
    const noRef = setupWith(n.home, [
      { path: n.parent, mode: "rw", ref: n.pRef },
      { path: n.secret, mode: "ro" },
    ]);
    expect(await noRef.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(false);
    expect(noRef.repoint).not.toHaveBeenCalled();
    const other = setupWith(n.home, [
      { path: n.parent, mode: "rw", ref: n.pRef },
      { path: n.secret, mode: "ro", ref: { ...n.sRef, ino: "1" } },
    ]);
    expect(await other.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(false);
    expect(other.repoint).not.toHaveBeenCalled();
  });

  it("moves nothing when a deny or ask rule names the old subtree", async () => {
    const n = await nested();
    await rename(n.parent, n.renamed);
    for (const rule of ["deny", "ask"] as const) {
      const h = setupWith(n.home, [{ path: n.parent, mode: "rw", ref: n.pRef }], {
        [rule]: [`read_file(${n.parent}/private/**)`],
      });
      expect(await h.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(false);
      expect(h.repoint).not.toHaveBeenCalled();
    }
  });
});

describe("who may tap Reconnect", () => {
  it("access.reconnectFolder and access.confirmFolder refuse a caller without operator.admin", async () => {
    const { home, granted, ref } = await tree();
    const renamed = join(home, "Projects", "app-renamed");
    await rename(granted, renamed);
    const h = setup(home, granted, ref);
    const handlers = createPermissionHandlers(h.broker, h.audit);
    const reader = {
      deviceId: "dev_r",
      scopes: ["operator.read"] as never,
      surface: "web" as const,
    };
    const entryId = `folder:always:${granted}`;
    await expect(
      handlers["access.reconnectFolder"]({ entryId, to: renamed }, reader),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      handlers["access.confirmFolder"]({ entryId, movedTo: renamed }, reader),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(h.repoint).not.toHaveBeenCalled();
    const admin = { ...reader, scopes: ["operator.admin"] as never };
    await expect(
      handlers["access.reconnectFolder"]({ entryId, to: renamed }, admin),
    ).resolves.toEqual({ reconnected: true });
  });
});
