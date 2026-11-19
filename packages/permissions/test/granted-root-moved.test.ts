import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FOLDER_FRESH_MS } from "../src/broker.ts";
import { type FolderAccessEnv, grantedRootRefused, type RootFacts } from "../src/index.ts";
import { call, type Harness, makeBroker, path } from "./helpers.ts";

/**
 * PR #1395 review r1. Owner decision 2026-11-19: a granted root that leads to ANY other folder
 * than where it was granted stops counting; spelling moves (case on macOS, `/tmp` `/var` `/etc`
 * under `/private`, the Data volume) don't, and an unmoved old home-root grant keeps working.
 * Finding 1: a swapped PARENT was never "moved". Finding 4: a link to a case-only sibling on a
 * case-sensitive volume folded equal.
 */

const H = "/Users/o";
const env: FolderAccessEnv = { home: H, psycheHome: `${H}/.psyche`, caseInsensitive: true };
const at = (real: string, extra: Partial<RootFacts> = {}): RootFacts => ({
  real,
  link: false,
  ...extra,
});

describe("grantedRootRefused", () => {
  // [label, stored, facts now, recorded at grant time, env]
  const REFUSED: [string, string, RootFacts, string | undefined, FolderAccessEnv][] = [
    // Finding 1: the parent swapped for a link (the root itself is a plain folder).
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
    // (a) Nothing recorded: where it leads is refused whatever else says.
    [
      "no record, parent -> ~, Library",
      `${H}/P/app/Library`,
      at(`${H}/Library`, { realParent: H }),
      undefined,
      env,
    ],
    [
      "no record, parent -> ~, .ssh",
      `${H}/P/app/.ssh`,
      at(`${H}/.ssh`, { realParent: H }),
      undefined,
      env,
    ],
    [
      "no record, parent -> ~/.psyche",
      `${H}/P/x/.psyche`,
      at(`${H}/.psyche`, { realParent: H }),
      undefined,
      env,
    ],
    [
      "no record, root -> ~",
      `${H}/P/home`,
      at(H, { link: true, realParent: `${H}/P` }),
      undefined,
      env,
    ],
    // The root itself swapped for a link.
    [
      "root -> ~/Documents",
      `${H}/P/root`,
      at(`${H}/Documents`, { link: true }),
      `${H}/P/root`,
      env,
    ],
    [
      "root -> sibling, no record",
      `${H}/P/root`,
      at(`${H}/P/other`, { link: true, realParent: `${H}/P` }),
      undefined,
      env,
    ],
    ["root -> /usr", `${H}/P/root`, at("/usr", { link: true }), `${H}/P/root`, env],
    ["root -> /opt/homebrew", `${H}/P/root`, at("/opt/homebrew", { link: true }), undefined, env],
    // Finding 4: a case-only sibling on a case-sensitive volume, with case folding on.
    [
      "root -> case sibling",
      "/Volumes/CS/Proj",
      at("/Volumes/CS/proj", { link: true }),
      "/Volumes/CS/Proj",
      env,
    ],
    [
      "root -> case sibling, no record",
      "/Volumes/CS/Proj",
      at("/Volumes/CS/proj", { link: true, realParent: "/Volumes/CS" }),
      undefined,
      env,
    ],
    ["a dangling link", `${H}/P/root`, { link: true }, `${H}/P/root`, env],
    ["a real move under /private", "/tmp/x", at("/private/var/folders/a/x"), "/private/tmp/x", env],
    [
      "a legacy typed link root (finding 5)",
      `${H}/notes-link`,
      at(`${H}/Documents`, { link: true, realParent: H }),
      undefined,
      env,
    ],
    ["inside a system root as stored", "/opt/homebrew", at("/opt/homebrew"), "/opt/homebrew", env],
    // Finding 3: Windows, moved to another drive.
    [
      "windows moved",
      "C:\\Users\\o\\proj",
      at("D:\\elsewhere\\proj"),
      "C:\\Users\\o\\proj",
      { caseInsensitive: false },
    ],
  ];
  const COUNTS: [string, string, RootFacts, string | undefined, FolderAccessEnv][] = [
    ["unmoved", `${H}/P/app`, at(`${H}/P/app`), `${H}/P/app`, env],
    [
      "unmoved, no record",
      `${H}/P/app`,
      at(`${H}/P/app`, { realParent: `${H}/P` }),
      undefined,
      env,
    ],
    ["an unmoved legacy home-root grant", H, at(H, { realParent: "/Users" }), undefined, env],
    ["an unmoved home-root grant, recorded", H, at(H), H, env],
    ["/tmp spelled under /private", "/tmp/x", at("/private/tmp/x"), "/private/tmp/x", env],
    [
      "/tmp itself (a system link)",
      "/tmp",
      at("/private/tmp", { link: true }),
      "/private/tmp",
      env,
    ],
    [
      "/var spelled under /private",
      "/var/folders/a/x",
      at("/private/var/folders/a/x"),
      undefined,
      env,
    ],
    ["case on a case-insensitive disk", `${H}/projects`, at(`${H}/Projects`), `${H}/Projects`, env],
    ["case renamed since the grant", `${H}/Projects`, at(`${H}/PROJECTS`), `${H}/Projects`, env],
    ["the Data-volume spelling", `${H}/x`, at(`${H}/x`), `/System/Volumes/Data${H}/x`, env],
    [
      "typed through a linked parent",
      `${H}/cloud/Notes`,
      at(`${H}/real-cloud/Notes`),
      `${H}/real-cloud/Notes`,
      env,
    ],
    [
      "typed through a linked parent, no record",
      `${H}/cloud/Notes`,
      at(`${H}/real-cloud/Notes`, { realParent: `${H}/real-cloud` }),
      undefined,
      env,
    ],
    ["not there yet", `${H}/P/later`, { link: false }, undefined, env],
    ["an unmounted volume", "/Volumes/NotMounted/x", { link: false }, undefined, env],
    // Finding 3: NTFS ignores case, whatever the POSIX setting says.
    [
      "windows case",
      "c:\\users\\o\\projects",
      at("C:\\Users\\o\\Projects"),
      "c:\\users\\o\\projects",
      { caseInsensitive: false },
    ],
    [
      "windows case, no record",
      "c:\\users\\o\\projects",
      at("C:\\Users\\o\\Projects", { realParent: "C:\\Users\\o" }),
      undefined,
      { caseInsensitive: false },
    ],
  ];

  it.each(REFUSED)("refuses: %s", (_l, stored, facts, recorded, e) => {
    expect(grantedRootRefused(stored, facts, recorded, e)).toBe(true);
  });
  it.each(COUNTS)("counts: %s", (_l, stored, facts, recorded, e) => {
    expect(grantedRootRefused(stored, facts, recorded, e)).toBe(false);
  });
});

/** Waits past the fresh window and lets the refresh a read starts land. */
async function look(h: Harness): Promise<void> {
  h.clock.advance(FOLDER_FRESH_MS + 1);
  h.broker.grantedFolders();
  await h.broker.foldersSettled();
}

const ctx = { threadId: "thr_a", runId: "run_1", permissionMode: "balanced", taint: false };

describe.skipIf(process.platform === "win32")(
  "the broker: a granted root's parent swapped for a link",
  () => {
    async function tree() {
      const home = await realpath(await mkdtemp(join(tmpdir(), "psy-parent-")));
      await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
      await mkdir(join(home, ".ssh"), { recursive: true });
      await mkdir(join(home, "Documents", "notes"), { recursive: true });
      return home;
    }

    it.each([
      ["~", "Library", "recorded"],
      ["~", ".ssh", "recorded"],
      ["~/Documents", "notes", "recorded"],
      ["~", "Library", "first seen"],
      ["~", ".ssh", "first seen"],
      ["~/Documents", "notes", "first seen"],
      ["~", "Library", "seen only after the swap"],
      ["~", ".ssh", "seen only after the swap"],
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
        await look(h);
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
      await look(h);
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
