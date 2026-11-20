import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOLDER_FRESH_MS } from "../src/broker.ts";
import { rootMoved } from "../src/folder-access.ts";
import { type Harness, makeBroker } from "./helpers.ts";

/**
 * `folderRefused` fails closed: only a missing path (ENOENT) may be judged as typed. It answers
 * from the broker's last look at the disk, refreshed asynchronously once it is older than
 * `FOLDER_FRESH_MS`. `look` waits that long, then makes ONE read through the fresh accessor
 * (r2: a helper that read twice hid a stale first answer).
 */
async function look(h: Harness): Promise<string[]> {
  h.clock.advance(FOLDER_FRESH_MS + 1);
  return (await h.broker.freshGrantedFolders()).map((f) => f.path);
}

describe.skipIf(process.platform === "win32")("folderRefused when the real path is unknown", () => {
  it("refuses a granted folder whose realpath fails with anything but ENOENT", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-fc-")));
    const loop = join(home, "loop");
    await symlink(loop, loop);
    const h = makeBroker({
      policy: { folders: [{ path: loop, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(loop)).toBe(true);
    expect(h.broker.grantedFolders()).toEqual([]);
  });

  it("judges such a folder again on the next look once its real path resolves (a mount back up)", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-fc-")));
    const flaky = join(home, "flaky");
    await symlink(flaky, flaky);
    const h = makeBroker({
      policy: { folders: [{ path: flaky, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(flaky)).toBe(true);
    await rm(flaky);
    await mkdir(flaky);
    // Until the next look the failed answer holds (a hung mount isn't looked up on each call).
    expect(h.broker.folderRefused(flaky)).toBe(true);
    // No setPolicy in between: a later read looks again, and the folder counts.
    expect(await look(h)).toEqual([flaky]);
    expect(h.broker.folderRefused(flaky)).toBe(false);
    expect(h.broker.grantedFolders()).toEqual([{ path: flaky, mode: "rw", real: flaky }]);
  });

  it("keeps a folder that does not exist yet", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-fc-")));
    const later = join(home, "Projects", "not-yet");
    const h = makeBroker({
      policy: { folders: [{ path: later, mode: "rw" }] },
      hostProgram: { home },
    });
    expect(h.broker.folderRefused(later)).toBe(false);
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(later)).toBe(false);
    expect(h.broker.grantedFolders()).toEqual([{ path: later, mode: "rw" }]);
  });

  it("still refuses a stored link into a system folder", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-fc-")));
    const link = join(home, "to-usr");
    await symlink("/usr", link);
    const h = makeBroker({
      policy: { folders: [{ path: link, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(link)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")(
  "a granted root that moved to a different folder",
  () => {
    async function setup(): Promise<{ home: string; root: string }> {
      const home = await realpath(await mkdtemp(join(tmpdir(), "psy-mv-")));
      await mkdir(join(home, "Projects"), { recursive: true });
      return { home, root: join(home, "Projects", "root") };
    }

    it.each([
      ["a shareable folder (~/Documents)", ["Documents"]],
      ["a sibling project", ["Projects", "other"]],
      ["a different volume-like folder", ["Volumes", "X"]],
    ])("is refused by the next look when swapped for a link to %s", async (_l, parts) => {
      const { home, root } = await setup();
      const target = join(home, ...parts);
      await mkdir(target, { recursive: true });
      await mkdir(root);
      const h = makeBroker({
        policy: { folders: [{ path: root, mode: "rw" }] },
        hostProgram: { home },
      });
      await h.broker.foldersSettled();
      expect(h.broker.grantedFolders()).toEqual([{ path: root, mode: "rw", real: root }]);
      await rm(root, { recursive: true });
      await symlink(target, root);
      expect(await look(h)).toEqual([]);
      expect(h.broker.folderRefused(root)).toBe(true);
      expect(h.broker.grantedFolders()).toEqual([]);
    });

    it("stays allowed under a symlinked parent when recorded, or when it does not exist yet", async () => {
      const { home } = await setup();
      await mkdir(join(home, "real"));
      await symlink(join(home, "real"), join(home, "linked"));
      const under = join(home, "linked", "p");
      await mkdir(join(home, "real", "p"));
      const later = join(home, "Projects", "later");
      const h = makeBroker({
        policy: {
          folders: [
            // As Settings stores a typed path: with the real path it had when it was added.
            { path: under, mode: "rw", real: join(home, "real", "p") },
            { path: later, mode: "rw" },
          ],
        },
        hostProgram: { home },
      });
      await h.broker.foldersSettled();
      expect(h.broker.grantedFolders().map((f) => f.path)).toEqual([under, later]);
      expect(await look(h)).toEqual([under, later]);
    });

    it("an older grant under a symlinked parent, with nothing recorded, waits for the owner", async () => {
      const { home } = await setup();
      await mkdir(join(home, "real", "p"), { recursive: true });
      await symlink(join(home, "real"), join(home, "linked"));
      const under = join(home, "linked", "p");
      const h = makeBroker({
        policy: { folders: [{ path: under, mode: "rw" }] },
        hostProgram: { home },
      });
      await h.broker.foldersSettled();
      expect(h.broker.grantedFolders()).toEqual([]);
      expect(h.broker.recordedReal(under)).toBeUndefined();
      expect(h.broker.folderMovedTo(under)).toBe(join(home, "real", "p"));
    });

    it("stays allowed when /tmp resolves to /private/tmp", async () => {
      const dir = await mkdtemp("/tmp/psy-mv-tmp-");
      try {
        const h = makeBroker({ policy: { folders: [{ path: dir, mode: "rw" }] }, hostProgram: {} });
        await h.broker.foldersSettled();
        expect(h.broker.folderRefused(dir)).toBe(false);
        expect(await look(h)).toEqual([dir]);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  },
);

describe("rootMoved spellings", () => {
  const ci = { caseInsensitive: true };
  const cs = { caseInsensitive: false };
  it.each([
    ["/tmp/x", "/private/tmp/x", "/private/tmp", ci, false],
    ["/tmp/x", "/tmp/x", "/private/tmp", ci, false],
    ["/var/x", "/private/var/x", "/private/var", ci, false],
    ["/etc/x", "/private/etc/x", "/private/etc", ci, false],
    ["/Users/me/Projects/App", "/Users/me/projects/app", "/Users/me/Projects", ci, false],
    ["/Users/me/p", "/System/Volumes/Data/Users/me/p", "/Users/me", ci, false],
    ["/Users/me/p", "/System/Volumes/Data/Users/me/q", "/Users/me", ci, true],
    ["/tmp/x", "/private/var/folders/a/x", "/private/tmp", ci, true],
    ["/Users/me/p", "/Users/me/Documents", "/Users/me", ci, true],
    ["/Users/me/p", "/Volumes/X/p", "/Users/me", ci, true],
    ["/Users/me/a/root", "/Users/me/Documents/evil/root", "/Users/me/Documents/evil", ci, false],
    ["/Users/me/App", "/Users/me/app", "/Users/me", cs, true],
    // Review r1 finding 3: Windows paths fold case whatever the POSIX setting says.
    ["C:\\Users\\o\\projects", "C:\\Users\\o\\Projects", "C:\\Users\\o", cs, false],
    [
      "c:\\users\\o\\projects\\app",
      "C:\\Users\\o\\Projects\\App",
      "C:\\Users\\o\\Projects",
      cs,
      false,
    ],
    ["C:\\Users\\o\\proj", "D:\\elsewhere\\proj", "C:\\Users\\o", cs, true],
  ])("%s -> %s", (stored, real, parent, env, moved) => {
    expect(rootMoved(stored, real, parent, env)).toBe(moved);
  });
});

describe.skipIf(process.platform === "win32")("failed looks", () => {
  it("use the broker clock, and an unrelated setPolicy keeps the last look", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-rw-")));
    const flaky = join(home, "flaky");
    await symlink(flaky, flaky);
    const h = makeBroker({
      policy: { folders: [{ path: flaky, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(flaky)).toBe(true);
    await rm(flaky);
    await mkdir(flaky);
    h.broker.setPolicy({ ...h.broker.policy });
    await h.broker.foldersSettled();
    expect(h.broker.folderRefused(flaky)).toBe(true);
    expect(await look(h)).toEqual([flaky]);
    expect(h.broker.folderRefused(flaky)).toBe(false);
  });
});
