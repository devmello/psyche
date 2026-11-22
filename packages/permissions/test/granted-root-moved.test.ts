import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ATTACH_GRANT_MS, FOLDER_FRESH_MS } from "../src/broker.ts";
import { accessEntries, createPermissionHandlers } from "../src/handlers.ts";
import {
  type FolderAccessEnv,
  grantedRootMoved,
  grantedRootRefused,
  type RootFacts,
} from "../src/index.ts";
import { call, type Harness, makeBroker, path } from "./helpers.ts";

/**
 * PR #1395. Owner decision 2026-11-19: a granted root that leads to ANY other folder than where
 * it was granted stops counting; spelling moves (case on macOS, `/tmp` `/var` `/etc` under
 * `/private`, the Data volume) don't, and an unmoved old home-root grant keeps working.
 * r1 finding 1: a swapped PARENT was never "moved". r1 finding 4: a link to a case-only sibling
 * on a case-sensitive volume folded equal. r2 finding 2 (decision 2): an older grant with nothing
 * recorded counts only while its real path is the stored path; otherwise the owner confirms it
 * again in Settings.
 */

const H = "/Users/o";
const env: FolderAccessEnv = { home: H, psycheHome: `${H}/.psyche`, caseInsensitive: true };
const cs: FolderAccessEnv = { caseInsensitive: false };
const at = (real: string, link = false): RootFacts => ({ real, link });
type Row = [string, string, RootFacts, string | undefined, FolderAccessEnv];

describe("grantedRootRefused", () => {
  // [label, stored, facts now, recorded at grant time, env]
  const REFUSED: Row[] = [
    // r1-1: the parent swapped for a link (the root itself is a plain folder).
    [
      "parent -> ~, name Library",
      `${H}/P/app/Library`,
      at(`${H}/Library`),
      `${H}/P/app/Library`,
      env,
    ],
    ["parent -> ~, name .ssh", `${H}/P/app/.ssh`, at(`${H}/.ssh`), `${H}/P/app/.ssh`, env],
    ["parent -> ~/Documents", `${H}/P/a/notes`, at(`${H}/Documents/notes`), `${H}/P/a/notes`, env],
    ["parent -> /Volumes/X", `${H}/P/a/notes`, at("/Volumes/X/notes"), `${H}/P/a/notes`, env],
    // Nothing recorded: where it leads is refused whatever else says (r1-1a)...
    ["no record, parent -> ~, Library", `${H}/P/app/Library`, at(`${H}/Library`), undefined, env],
    ["no record, parent -> ~, .ssh", `${H}/P/app/.ssh`, at(`${H}/.ssh`), undefined, env],
    ["no record, parent -> ~/.psyche", `${H}/P/x/.psyche`, at(`${H}/.psyche`), undefined, env],
    ["no record, root -> ~", `${H}/P/home`, at(H, true), undefined, env],
    // ...and anywhere but the stored path waits for the owner (r2-2, decision 2).
    ["no record, parent -> ~/Documents", `${H}/P/a/app`, at(`${H}/Documents/app`), undefined, env],
    [
      "no record, typed through a linked parent",
      `${H}/cloud/Notes`,
      at(`${H}/real-cloud/Notes`),
      undefined,
      env,
    ],
    ["no record, parent unreadable at the look", `${H}/P/a/app`, at(`${H}/Q/app`), undefined, env],
    // The root itself swapped for a link.
    ["root -> ~/Documents", `${H}/P/root`, at(`${H}/Documents`, true), `${H}/P/root`, env],
    ["root -> sibling, no record", `${H}/P/root`, at(`${H}/P/other`, true), undefined, env],
    ["root -> /usr", `${H}/P/root`, at("/usr", true), `${H}/P/root`, env],
    ["root -> /opt/homebrew", `${H}/P/root`, at("/opt/homebrew", true), undefined, env],
    // r1-4: a case-only sibling on a case-sensitive volume, with case folding on.
    [
      "root -> case sibling",
      "/Volumes/CS/Proj",
      at("/Volumes/CS/proj", true),
      "/Volumes/CS/Proj",
      env,
    ],
    [
      "root -> case sibling, no record",
      "/Volumes/CS/Proj",
      at("/Volumes/CS/proj", true),
      undefined,
      env,
    ],
    ["a dangling link", `${H}/P/root`, { link: true }, `${H}/P/root`, env],
    ["a real move under /private", "/tmp/x", at("/private/var/folders/a/x"), "/private/tmp/x", env],
    [
      "a legacy typed link root (r1-5)",
      `${H}/notes-link`,
      at(`${H}/Documents`, true),
      undefined,
      env,
    ],
    ["inside a system root as stored", "/opt/homebrew", at("/opt/homebrew"), "/opt/homebrew", env],
    // r1-3: Windows, moved to another drive.
    ["windows moved", "C:\\Users\\o\\proj", at("D:\\elsewhere\\proj"), "C:\\Users\\o\\proj", cs],
  ];
  const COUNTS: Row[] = [
    ["unmoved", `${H}/P/app`, at(`${H}/P/app`), `${H}/P/app`, env],
    ["unmoved, no record", `${H}/P/app`, at(`${H}/P/app`), undefined, env],
    ["an unmoved legacy home-root grant", H, at(H), undefined, env],
    ["an unmoved home-root grant, recorded", H, at(H), H, env],
    ["/tmp spelled under /private", "/tmp/x", at("/private/tmp/x"), "/private/tmp/x", env],
    ["/tmp spelled under /private, no record", "/tmp/x", at("/private/tmp/x"), undefined, env],
    ["/tmp itself (a system link)", "/tmp", at("/private/tmp", true), "/private/tmp", env],
    [
      "/var spelled under /private",
      "/var/folders/a/x",
      at("/private/var/folders/a/x"),
      undefined,
      env,
    ],
    ["case on a case-insensitive disk", `${H}/projects`, at(`${H}/Projects`), `${H}/Projects`, env],
    ["case, no record", `${H}/projects`, at(`${H}/Projects`), undefined, env],
    ["case renamed since the grant", `${H}/Projects`, at(`${H}/PROJECTS`), `${H}/Projects`, env],
    ["the Data-volume spelling", `${H}/x`, at(`${H}/x`), `/System/Volumes/Data${H}/x`, env],
    [
      "typed through a linked parent, recorded",
      `${H}/cloud/Notes`,
      at(`${H}/real-cloud/Notes`),
      `${H}/real-cloud/Notes`,
      env,
    ],
    ["not there yet", `${H}/P/later`, { link: false }, undefined, env],
    ["an unmounted volume", "/Volumes/NotMounted/x", { link: false }, undefined, env],
    // r1-3: NTFS ignores case, whatever the POSIX setting says.
    [
      "windows case",
      "c:\\users\\o\\projects",
      at("C:\\Users\\o\\Projects"),
      "c:\\users\\o\\projects",
      cs,
    ],
    [
      "windows case, no record",
      "c:\\users\\o\\projects",
      at("C:\\Users\\o\\Projects"),
      undefined,
      cs,
    ],
  ];

  it.each(REFUSED)("refuses: %s", (_l, stored, facts, recorded, e) => {
    expect(grantedRootRefused(stored, facts, recorded, e)).toBe(true);
  });
  it.each(COUNTS)("counts: %s", (_l, stored, facts, recorded, e) => {
    expect(grantedRootRefused(stored, facts, recorded, e)).toBe(false);
  });
});

describe("grantedRootMoved (what Settings offers to confirm again)", () => {
  it.each([
    [
      "no record, parent -> ~/Documents",
      `${H}/P/a/app`,
      at(`${H}/Documents/app`),
      `${H}/Documents/app`,
    ],
    ["no record, typed through a linked parent", `${H}/cloud/N`, at(`${H}/real/N`), `${H}/real/N`],
  ])("offers: %s", (_l, stored, facts, to) => {
    expect(grantedRootMoved(stored, facts, undefined, env)).toBe(to);
  });
  it.each([
    [
      "recorded (a swap after the grant is refused, not offered)",
      `${H}/P/a`,
      at(`${H}/Q/a`),
      `${H}/P/a`,
    ],
    ["unmoved", `${H}/P/a`, at(`${H}/P/a`), undefined],
    ["only spelled differently", "/tmp/x", at("/private/tmp/x"), undefined],
    ["leads to ~/Library", `${H}/P/Library`, at(`${H}/Library`), undefined],
    ["leads to home itself", `${H}/P/h`, at(H), undefined],
    ["leads into /usr", `${H}/P/u`, at("/usr/local"), undefined],
    ["the root itself is a link", `${H}/P/l`, at(`${H}/Documents`, true), undefined],
    ["does not exist", `${H}/P/n`, { link: false }, undefined],
  ])("does not offer: %s", (_l, stored, facts, recorded) => {
    expect(grantedRootMoved(stored, facts, recorded, env)).toBeUndefined();
  });
});

/** Waits past the fresh window; ONE read, through the fresh accessor, says what counts now. */
async function look(h: Harness): Promise<string[]> {
  h.clock.advance(FOLDER_FRESH_MS + 1);
  return (await h.broker.freshGrantedFolders()).map((f) => f.path);
}

const ctx = { threadId: "thr_a", runId: "run_1", permissionMode: "balanced", taint: false };

async function tree() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "psy-parent-")));
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(join(home, "Documents", "notes"), { recursive: true });
  await mkdir(join(home, "Documents", "app"), { recursive: true });
  return home;
}

describe.skipIf(process.platform === "win32")(
  "the broker: a granted root's parent swapped for a link",
  () => {
    it.each([
      ["~", "Library", "recorded"],
      ["~", ".ssh", "recorded"],
      ["~/Documents", "notes", "recorded"],
      ["~", "Library", "first seen"],
      ["~", ".ssh", "first seen"],
      ["~/Documents", "notes", "first seen"],
      ["~", "Library", "seen only after the swap"],
      ["~", ".ssh", "seen only after the swap"],
      ["~/Documents", "notes", "seen only after the swap"],
    ])("parent -> %s, name %s (%s): stops counting", async (to, name, how) => {
      const home = await tree();
      const parent = join(home, "Projects", "app");
      const granted = join(parent, name);
      await mkdir(granted, { recursive: true });
      const target = to === "~" ? home : join(home, "Documents");
      const swap = async () => {
        await rm(parent, { recursive: true });
        await symlink(target, parent);
      };
      if (how === "seen only after the swap") await swap();
      const h = makeBroker({
        policy: {
          folders: [
            how === "recorded"
              ? { path: granted, mode: "rw", real: granted }
              : { path: granted, mode: "rw" },
          ],
        },
        hostProgram: { home },
      });
      await h.broker.foldersSettled();
      if (how !== "seen only after the swap") {
        expect(h.broker.grantedFolders().map((f) => f.path)).toEqual([granted]);
        await swap();
        expect(await look(h)).toEqual([]);
      }
      expect(h.broker.folderRefused(granted)).toBe(true);
      expect(h.broker.grantedFolders()).toEqual([]);
      const file =
        name === "Library" ? join(granted, "LaunchAgents", "x.plist") : join(granted, "x");
      const d = await h.broker.decide(call("write_file", "write", path(file)), ctx as never);
      expect(d).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
    });

    it("the first real path seen for an older Settings grant is handed to the store, once", async () => {
      const home = await tree();
      const granted = join(home, "Projects", "app");
      await mkdir(granted, { recursive: true });
      const recordReal = vi.fn();
      const h = makeBroker({
        policy: { folders: [{ path: granted, mode: "rw" }] },
        hostProgram: { home },
        folderAccess: { env: () => ({ home }), persist: async () => {}, recordReal },
      });
      await h.broker.foldersSettled();
      await vi.waitFor(() => expect(recordReal).toHaveBeenCalledWith(granted, granted));
      expect(await look(h)).toEqual([granted]);
      expect(recordReal).toHaveBeenCalledTimes(1);
    });

    it("a root already moved at its first look is refused and never recorded", async () => {
      const home = await tree();
      const granted = join(home, "Projects", "moved");
      await mkdir(join(home, "Projects"));
      await symlink(join(home, "Documents"), granted);
      const recordReal = vi.fn();
      const h = makeBroker({
        policy: { folders: [{ path: granted, mode: "rw" }] },
        hostProgram: { home },
        folderAccess: { env: () => ({ home }), persist: async () => {}, recordReal },
      });
      await h.broker.foldersSettled();
      expect(h.broker.folderRefused(granted)).toBe(true);
      expect(h.broker.recordedReal(granted)).toBeUndefined();
      await Promise.resolve();
      expect(recordReal).not.toHaveBeenCalled();
    });
  },
);

/** The reviewer's r2 probe rows, permanent. */
describe.skipIf(process.platform === "win32")("PR #1395 r2 probes", () => {
  async function probeTree() {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-r2-")));
    await mkdir(join(home, "Documents", "app"), { recursive: true });
    const parent = join(home, "Projects");
    const granted = join(parent, "app");
    await mkdir(granted, { recursive: true });
    const swapParent = async () => {
      await rm(parent, { recursive: true });
      await symlink(join(home, "Documents"), parent);
    };
    return { home, parent, granted, swapParent };
  }
  const recorded = (granted: string) => ({
    folders: [{ path: granted, mode: "rw" as const, real: granted }],
  });

  it("A1: after an hour idle, the first fresh read already leaves out a root swapped meanwhile", async () => {
    const { home, granted, swapParent } = await probeTree();
    const h = makeBroker({ policy: recorded(granted), hostProgram: { home } });
    await h.broker.foldersSettled();
    h.clock.advance(3_600_000);
    await swapParent();
    expect((await h.broker.freshGrantedFolders()).map((f) => f.path)).toEqual([]);
  });

  it("A2: a decide 30 s after the last look waits for a new one and is denied", async () => {
    const { home, granted, swapParent } = await probeTree();
    const h = makeBroker({ policy: recorded(granted), hostProgram: { home } });
    await h.broker.foldersSettled();
    h.clock.advance(30_000);
    await swapParent();
    const d = await h.broker.decide(
      call("write_file", "write", path(join(granted, "x.txt"))),
      ctx as never,
    );
    expect(d).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
  });

  it("A3: inside the fresh window the engine still answers from the last look (the bound)", async () => {
    const { home, granted, swapParent } = await probeTree();
    const h = makeBroker({ policy: recorded(granted), hostProgram: { home } });
    await h.broker.foldersSettled();
    h.clock.advance(FOLDER_FRESH_MS - 2_000);
    await swapParent();
    const d = await h.broker.decide(
      call("write_file", "write", path(join(granted, "x.txt"))),
      ctx as never,
    );
    // At most FOLDER_FRESH_MS old: the executors' own live checks refuse the write itself.
    expect(d).toMatchObject({ decision: "allow", rule: "folder:rw" });
    h.clock.advance(2_001);
    const later = await h.broker.decide(
      call("write_file", "write", path(join(granted, "x.txt"))),
      ctx as never,
    );
    expect(later).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
  });

  it("B: an older grant whose parent was swapped before its first look neither counts nor is recorded", async () => {
    const { home, granted, swapParent } = await probeTree();
    await swapParent();
    const recordReal = vi.fn();
    const h = makeBroker({
      policy: { folders: [{ path: granted, mode: "rw" }] },
      hostProgram: { home },
      folderAccess: { env: () => ({ home }), persist: async () => {}, recordReal },
    });
    await h.broker.foldersSettled();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.broker.grantedFolders()).toEqual([]);
    expect(h.broker.recordedReal(granted)).toBeUndefined();
    expect(recordReal).not.toHaveBeenCalled();
    // Settings shows it as moved, to be confirmed again.
    expect(h.broker.folderMovedTo(granted)).toBe(join(home, "Documents", "app"));
  });

  it("C: before its first look a root is not handed to a fresh reader", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-r2c-")));
    await mkdir(join(home, "Documents"), { recursive: true });
    await mkdir(join(home, "Projects"), { recursive: true });
    const granted = join(home, "Projects", "app");
    await symlink(join(home, "Documents"), granted);
    const h = makeBroker({
      policy: { folders: [{ path: granted, mode: "rw", real: granted }] },
      hostProgram: { home },
    });
    expect((await h.broker.freshGrantedFolders()).map((f) => f.path)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("Settings: an older folder that moved", () => {
  const DEVICE = { deviceId: "dev_admin", surface: "desktop" as const };

  async function moved() {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-confirm-")));
    await mkdir(join(home, "real-cloud", "Notes"), { recursive: true });
    await symlink(join(home, "real-cloud"), join(home, "cloud"));
    const granted = join(home, "cloud", "Notes");
    return { home, granted, real: join(home, "real-cloud", "Notes") };
  }

  /** A broker whose store records `real` into `policy` (as the Gateway's does). */
  function storing(home: string, granted: string) {
    const state = {
      policy: { folders: [{ path: granted, mode: "rw" as const }] } as {
        folders: { path: string; mode: "rw"; real?: string }[];
      },
      recorded: [] as [string, string, { deviceId: string } | undefined][],
    };
    const h = makeBroker({
      policy: state.policy,
      hostProgram: { home },
      folderAccess: {
        env: () => ({ home }),
        persist: async () => {},
        recordReal: (p, r, by) => {
          state.recorded.push([p, r, by]);
          state.policy = {
            folders: state.policy.folders.map((f) => (f.path === p ? { ...f, real: r } : f)),
          };
          h.broker.setPolicy(state.policy);
        },
      },
    });
    return { h, state };
  }

  it("is listed refused and moved, and the owner's confirm records where it leads now", async () => {
    const { home, granted, real } = await moved();
    const { h, state } = storing(home, granted);
    await h.broker.foldersSettled();
    expect(h.broker.grantedFolders()).toEqual([]);
    const [row] = await accessEntries(h.broker);
    expect(row).toMatchObject({ path: granted, refused: true, moved: true, movedTo: real });
    expect(await h.broker.confirmMovedFolder(granted, real, DEVICE)).toBe(true);
    expect(state.policy.folders).toEqual([{ path: granted, mode: "rw", real }]);
    // The store is told which device confirmed it (the Gateway reports a security change).
    expect(state.recorded).toEqual([[granted, real, { deviceId: "dev_admin" }]]);
    // Audited as the owner's device, not the system.
    const [audited] = await h.audit.query({ kind: "folder.confirmed" });
    expect(audited?.actor).toMatchObject({ type: "device", deviceId: "dev_admin" });
    expect(h.broker.grantedFolders().map((f) => f.path)).toEqual([granted]);
    const [after] = await accessEntries(h.broker);
    expect(after).not.toHaveProperty("refused");
    expect(after).not.toHaveProperty("moved");
    // Nothing more to confirm.
    expect(await h.broker.confirmMovedFolder(granted, real, DEVICE)).toBe(false);
  });

  it("E: a folder re-pointed between the list and the tap is not confirmed (PR #1395 r3)", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-confirm-e-")));
    await mkdir(join(home, "Work", "app"), { recursive: true });
    await mkdir(join(home, "Documents", "app"), { recursive: true });
    await symlink(join(home, "Work"), join(home, "Projects"));
    const granted = join(home, "Projects", "app");
    const { h, state } = storing(home, granted);
    await h.broker.foldersSettled();
    const [row] = await accessEntries(h.broker);
    const seen = row?.movedTo as string;
    expect(seen).toBe(join(home, "Work", "app"));
    // Before the tap, the parent now leads to ~/Documents.
    await rm(join(home, "Projects"));
    await symlink(join(home, "Documents"), join(home, "Projects"));
    expect(await h.broker.confirmMovedFolder(granted, seen, DEVICE)).toBe(false);
    expect(state.recorded).toEqual([]);
    expect(h.broker.recordedReal(granted)).toBeUndefined();
    expect(h.broker.grantedFolders()).toEqual([]);
    // Read again, the list shows where it leads now; only a tap on that confirms it there.
    const [again] = await accessEntries(h.broker);
    expect(again?.movedTo).toBe(join(home, "Documents", "app"));
    expect(await h.broker.confirmMovedFolder(granted, again?.movedTo as string, DEVICE)).toBe(true);
    expect(state.policy.folders[0]?.real).toBe(join(home, "Documents", "app"));
  });

  it("a confirm through the handler takes what the row showed, and the caller's device", async () => {
    const { home, granted, real } = await moved();
    const { h, state } = storing(home, granted);
    await h.broker.foldersSettled();
    const handlers = createPermissionHandlers(h.broker, h.audit);
    const admin = {
      deviceId: "dev_admin",
      scopes: ["operator.admin"] as never,
      surface: "desktop" as const,
    };
    const entryId = `folder:always:${granted}`;
    await expect(
      handlers["access.confirmFolder"]({ entryId, movedTo: join(home, "elsewhere") }, admin),
    ).resolves.toEqual({ confirmed: false });
    await expect(handlers["access.confirmFolder"]({ entryId }, admin)).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(
      handlers["access.confirmFolder"]({ entryId, movedTo: real }, admin),
    ).resolves.toEqual({ confirmed: true });
    expect(state.recorded).toEqual([[granted, real, { deviceId: "dev_admin" }]]);
  });

  it("confirm refuses a folder that now leads where no grant may be, and one never granted", async () => {
    const home = await tree();
    const parent = join(home, "Projects", "app");
    const granted = join(parent, "Library");
    await mkdir(granted, { recursive: true });
    await rm(parent, { recursive: true });
    await symlink(home, parent);
    const recordReal = vi.fn();
    const h = makeBroker({
      policy: { folders: [{ path: granted, mode: "rw" }] },
      hostProgram: { home },
      folderAccess: { env: () => ({ home }), persist: async () => {}, recordReal },
    });
    await h.broker.foldersSettled();
    expect(h.broker.folderMovedTo(granted)).toBeUndefined();
    expect(await h.broker.confirmMovedFolder(granted, join(home, "Library"), DEVICE)).toBe(false);
    expect(
      await h.broker.confirmMovedFolder(join(home, "Documents"), join(home, "Documents"), DEVICE),
    ).toBe(false);
    expect(recordReal).not.toHaveBeenCalled();
    expect(h.broker.grantedFolders()).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("pruning (r2 finding 6)", () => {
  it("a revoked or removed root starts from a fresh look, never an old first-seen baseline", async () => {
    const home = await tree();
    const a = join(home, "Projects", "a");
    await mkdir(a, { recursive: true });
    const h = makeBroker({
      policy: { folders: [{ path: a, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    expect(h.broker.recordedReal(a)).toBe(a);
    h.broker.setPolicy({ folders: [] });
    expect(h.broker.recordedReal(a)).toBeUndefined();
    // Granted again after it moved: judged afresh (moved, not counted), not against the old baseline.
    await rm(a, { recursive: true });
    await mkdir(join(home, "Elsewhere", "a"), { recursive: true });
    await symlink(join(home, "Elsewhere", "a"), a);
    h.broker.setPolicy({ folders: [{ path: a, mode: "rw" }] });
    await h.broker.foldersSettled();
    expect(h.broker.recordedReal(a)).toBeUndefined();
    expect(h.broker.grantedFolders()).toEqual([]);
  });

  it.each(["ended chat", "expired attachment", "revoked attachment"])(
    "an attached file's baseline is forgotten with its grant (%s)",
    async (how) => {
      const home = await tree();
      const file = join(home, "Documents", "notes", "a.txt");
      await writeFile(file, "x");
      const h = makeBroker({
        policy: { folders: [] },
        hostProgram: { home },
        folderAccess: { env: () => ({ home }), persist: async () => {} },
      });
      await h.broker.attachFiles("thr_a", [file], { deviceId: "dev_1" });
      expect(h.broker.recordedReal(file)).toBe(file);
      if (how === "ended chat") await h.broker.endSession("thr_a");
      else if (how === "revoked attachment") await h.broker.revokeSessionFolder("thr_a", file);
      else {
        h.clock.advance(ATTACH_GRANT_MS + 1);
        h.broker.sessionFolders("thr_a");
      }
      expect(h.broker.recordedReal(file)).toBeUndefined();
    },
  );
});
