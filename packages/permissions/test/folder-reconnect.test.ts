import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ruleNamesOldPath } from "../src/folder-reconnect.ts";
import { accessEntries, createPermissionHandlers } from "../src/handlers.ts";
import { type FolderRef, folderRefOf } from "../src/index.ts";
import { globToRegExp } from "../src/policy.ts";
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

  it("carries a narrowing by path: a read-only child with no identity, or one deleted (P12, P12b)", async () => {
    const n = await nested();
    await rename(n.parent, n.renamed);
    const build = join(n.parent, "build"); // an override for a folder that never existed
    const noRef = setupWith(n.home, [
      { path: n.parent, mode: "rw", ref: n.pRef },
      { path: build, mode: "ro" },
    ]);
    expect(await noRef.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(true);
    expect(noRef.repoint).toHaveBeenCalledWith(
      [
        { from: n.parent, to: n.renamed },
        { from: build, to: join(n.renamed, "build") },
      ],
      BY,
    );
    // The child had an identity, but was deleted before the rename (gone at both places).
    const deleted = setupWith(n.home, [
      { path: n.parent, mode: "rw", ref: n.pRef },
      { path: n.secret, mode: "ro", ref: { ...n.sRef, ino: "1" } },
    ]);
    expect(await deleted.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(true);
    expect(deleted.repoint).toHaveBeenCalledTimes(1);
  });

  it("moves nothing for a child that would be wider than its folder unless it is verified (P18)", async () => {
    const n = await nested();
    await rename(n.parent, n.renamed);
    // A read-write child under a read-only parent: moving it by path could widen what is shared.
    const unverified = setupWith(n.home, [
      { path: n.parent, mode: "ro", ref: n.pRef },
      { path: n.secret, mode: "rw" },
    ]);
    expect(await unverified.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(false);
    expect(unverified.repoint).not.toHaveBeenCalled();
    const impostor = setupWith(n.home, [
      { path: n.parent, mode: "ro", ref: n.pRef },
      { path: n.secret, mode: "rw", ref: { ...n.sRef, ino: "1" } },
    ]);
    expect(await impostor.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(false);
    expect(impostor.repoint).not.toHaveBeenCalled();
    // Verified like the folder: it moves with it.
    const verified = setupWith(n.home, [
      { path: n.parent, mode: "ro", ref: n.pRef },
      { path: n.secret, mode: "rw", ref: n.sRef },
    ]);
    expect(await verified.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(true);
  });

  // [label, rule, moves nothing?]. P13: a sibling that starts with the same letters is another
  // folder. P14: glob rules narrowing the old subtree stop matching at the new place.
  const RULES: [string, (old: string) => string, boolean][] = [
    ["literal rule under the folder", (o) => `read_file(${o}/private/**)`, true],
    ["literal rule on the folder", (o) => `read_file(${o})`, true],
    ["P13 sibling with a longer name", (o) => `read_file(${o}B/**)`, false],
    ["P14 leading ** glob", () => "read_file(**/Work/A/private/**)", true],
    [
      "P14 wildcard in a parent segment",
      (o) => `write_file(${o.replace("Work", "W*rk")}/private/**)`,
      true,
    ],
    ["a rule about every .env file", () => "read_file(**/*.env)", false],
    ["a rule about another folder", (o) => `read_file(${o.replace("/A", "/C")}/**)`, false],
    ["case-folded", (o) => `read_file(${o.toUpperCase()}/x/**)`, true],
    ["r3 path: target rule", (o) => `path:${o}/private/**`, true],
    [
      "r3 ** glued to the folder name",
      (o) => `read_file(**${o.split("/").pop()}/private/**)`,
      true,
    ],
    [
      "r3 ** glued inside a parent segment",
      (o) => `read_file(${o.replace("Work", "Wo**")}/private/**)`,
      true,
    ],
    ["r3 path: rule on another folder", (o) => `path:${o.replace("/A", "/C")}/**`, false],
  ];
  for (const [label, rule, refused] of RULES) {
    for (const kind of ["deny", "ask"] as const) {
      it(`${kind} rule, ${label}: ${refused ? "refuses" : "allows"} the reconnect`, async () => {
        const n = await nested();
        await rename(n.parent, n.renamed);
        const h = setupWith(n.home, [{ path: n.parent, mode: "rw", ref: n.pRef }], {
          [kind]: [rule(n.parent)],
        });
        // The list says why instead of offering a button that can only fail.
        const entry = (await accessEntries(h.broker)).find((e) => e.path === n.parent);
        if (refused) {
          expect(entry?.reconnectTo).toBeUndefined();
          expect(entry?.reconnectBlocked).toBe(true);
        } else expect(entry?.reconnectTo).toBe(n.renamed);
        expect(await h.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(!refused);
        expect(h.repoint).toHaveBeenCalledTimes(refused ? 0 : 1);
      });
    }
  }
  it("refuses a reconnect when a designated person's deny rule names the old folder", async () => {
    const n = await nested();
    await rename(n.parent, n.renamed);
    const h = setupWith(n.home, [{ path: n.parent, mode: "rw", ref: n.pRef }], {
      designated: { idn_p: { deny: [`read_file(${n.parent}/private/**)`] } },
    });
    expect(await h.broker.reconnectFolder(n.parent, n.renamed, BY)).toBe(false);
    expect(h.repoint).not.toHaveBeenCalled();
  });
});

describe("ruleNamesOldPath against the engine's glob", () => {
  const old = "/h/Work/A";
  const tails = ["private/k", "x", "k.env"];
  const rules = [
    "read_file(/h/Work/A/**)",
    "read_file(**A/private/**)",
    "read_file(/h/Wo**/private/**)",
    "path:/h/Work/A/private/**",
    "read_file(**/*.env)",
    "read_file(/h/W*/A/*)",
    "read_file(/h/Work/AB/**)",
  ];
  for (const rule of rules) {
    it(`flags ${rule} whenever it matches under the old path`, () => {
      const arg = rule.startsWith("path:") ? rule.slice(5) : (/\((.+)\)$/.exec(rule)?.[1] ?? "");
      const re = globToRegExp(arg, "path");
      const literal = /\*\*\/\*\.env|^\*\*\/\*/.test(arg);
      for (const t of tails) {
        if (re.test(`${old}/${t}`) && !literal)
          expect(ruleNamesOldPath(rule, old, "/h")).toBe(true);
      }
    });
  }
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
