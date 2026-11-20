import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessEntries } from "../src/handlers.ts";
import { type FolderRef, folderRefOf } from "../src/index.ts";
import { makeBroker } from "./helpers.ts";

/**
 * Reconnecting a granted folder the owner renamed or moved (Cowork parity). The offer is made only
 * for a vanished path whose recorded identity (volume + inode) is found elsewhere; the owner's tap
 * re-points it, after every check of a fresh grant. A swapped root, a link or another folder at
 * the target is refused (#1384, #1387, #1388, #1389, #1395).
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

function setup(home: string, granted: string, ref: FolderRef | undefined) {
  const repoint = vi.fn(async () => true);
  const recordRef = vi.fn();
  const h = makeBroker({
    policy: { folders: [{ path: granted, mode: "rw", real: granted, ...(ref ? { ref } : {}) }] },
    hostProgram: { home },
    folderAccess: { env: () => ({ home }), persist: async () => {}, repoint, recordRef },
  });
  return { ...h, repoint, recordRef };
}

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
    expect(h.repoint).toHaveBeenCalledWith(granted, renamed, BY);
  });

  it("finds a folder moved to another place under home", async () => {
    const { home, granted, ref } = await tree();
    const moved = join(home, "Documents", "app");
    await rename(granted, moved);
    const h = setup(home, granted, ref);
    expect(await h.broker.folderReconnectOffer(granted)).toBe(moved);
  });

  it("offers nothing while the path is still there, or when no identity was recorded", async () => {
    const { home, granted, ref } = await tree();
    expect(await setup(home, granted, ref).broker.folderReconnectOffer(granted)).toBeUndefined();
    await rename(granted, join(home, "Projects", "other"));
    expect(await setup(home, granted, undefined).broker.folderReconnectOffer(granted)).toBe(
      undefined,
    );
  });

  it("records the identity once, at the first look at a folder where it was granted", async () => {
    const { home, granted, ref } = await tree();
    const h = setup(home, granted, undefined);
    await h.broker.foldersSettled();
    await h.broker.folderRefused(granted);
    await vi.waitFor(() => expect(h.recordRef).toHaveBeenCalledWith(granted, ref));
  });
});

describe("folder reconnect refusals (swapped roots and links stay refused)", () => {
  it("refuses a swapped root: the old path now holds another folder", async () => {
    const { home, granted, ref } = await tree();
    const renamed = join(home, "Projects", "app-renamed");
    await rename(granted, renamed);
    await mkdir(granted); // a different folder took the name
    const h = setup(home, granted, ref);
    expect(await h.broker.folderReconnectOffer(granted)).toBeUndefined();
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

  it("runs the fresh-grant check: a sensitive place is refused even for the same folder", async () => {
    const { home, granted, ref } = await tree();
    const inLibrary = join(home, "Library", "app");
    await mkdir(join(home, "Library"));
    await rename(granted, inLibrary);
    const h = setup(home, granted, ref);
    // The search never looks in ~/Library, and a direct re-point there is refused as a grant.
    expect(await h.broker.folderReconnectOffer(granted)).toBeUndefined();
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
});
