import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rootMoved } from "../src/folder-access.ts";
import { makeBroker } from "./helpers.ts";

/** `folderRefused` fails closed: only a missing path (ENOENT) may be judged as typed. */

describe.skipIf(process.platform === "win32")("folderRefused when the real path is unknown", () => {
  it("refuses a granted folder whose realpath fails with anything but ENOENT", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-fc-")));
    const loop = join(home, "loop");
    await symlink(loop, loop);
    const h = makeBroker({
      policy: { folders: [{ path: loop, mode: "rw" }] },
      hostProgram: { home },
    });
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
    expect(h.broker.folderRefused(flaky)).toBe(true);
    await rm(flaky);
    await mkdir(flaky);
    // Within the retry window the error answer holds (a hung mount isn't looked up each call).
    expect(h.broker.folderRefused(flaky)).toBe(true);
    // No setPolicy in between: after the window the folder is judged again.
    h.clock.advance(31_000);
    expect(h.broker.folderRefused(flaky)).toBe(false);
    expect(h.broker.grantedFolders()).toEqual([{ path: flaky, mode: "rw" }]);
  });

  it("keeps a folder that does not exist yet", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-fc-")));
    const later = join(home, "Projects", "not-yet");
    const h = makeBroker({
      policy: { folders: [{ path: later, mode: "rw" }] },
      hostProgram: { home },
    });
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
    ])("is refused at once when swapped for a link to %s", async (_l, parts) => {
      const { home, root } = await setup();
      const target = join(home, ...parts);
      await mkdir(target, { recursive: true });
      await mkdir(root);
      const h = makeBroker({
        policy: { folders: [{ path: root, mode: "rw" }] },
        hostProgram: { home },
      });
      expect(h.broker.grantedFolders()).toEqual([{ path: root, mode: "rw" }]);
      await rm(root, { recursive: true });
      await symlink(target, root);
      expect(h.broker.folderRefused(root)).toBe(true);
      expect(h.broker.grantedFolders()).toEqual([]);
    });

    it("stays allowed under a symlinked parent, or when it does not exist yet", async () => {
      const { home } = await setup();
      await mkdir(join(home, "real"));
      await symlink(join(home, "real"), join(home, "linked"));
      const under = join(home, "linked", "p");
      await mkdir(join(home, "real", "p"));
      const later = join(home, "Projects", "later");
      const h = makeBroker({
        policy: {
          folders: [
            { path: under, mode: "rw" },
            { path: later, mode: "rw" },
          ],
        },
        hostProgram: { home },
      });
      expect(h.broker.grantedFolders().map((f) => f.path)).toEqual([under, later]);
    });

    it("stays allowed when /tmp resolves to /private/tmp", async () => {
      const dir = await mkdtemp("/tmp/psy-mv-tmp-");
      try {
        const h = makeBroker({ policy: { folders: [{ path: dir, mode: "rw" }] }, hostProgram: {} });
        expect(h.broker.folderRefused(dir)).toBe(false);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  },
);

describe("rootMoved spellings", () => {
  const ci = { caseInsensitive: true };
  it.each([
    ["/tmp/x", "/private/tmp/x", "/private/tmp", ci, false],
    ["/var/x", "/private/var/x", "/private/var", ci, false],
    ["/Users/me/Projects/App", "/Users/me/projects/app", "/Users/me/Projects", ci, false],
    ["/Users/me/p", "/System/Volumes/Data/Users/me/p", "/Users/me", ci, false],
    ["/Users/me/p", "/Users/me/Documents", "/Users/me", ci, true],
    ["/Users/me/p", "/Volumes/X/p", "/Users/me", ci, true],
    ["/Users/me/App", "/Users/me/app", "/Users/me", { caseInsensitive: false }, true],
  ])("%s -> %s", (stored, real, parent, env, moved) => {
    expect(rootMoved(stored, real, parent, env)).toBe(moved);
  });
});

describe.skipIf(process.platform === "win32")("retry window", () => {
  it("uses the broker clock and survives an unrelated setPolicy", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "psy-rw-")));
    const flaky = join(home, "flaky");
    await symlink(flaky, flaky);
    const h = makeBroker({
      policy: { folders: [{ path: flaky, mode: "rw" }] },
      hostProgram: { home },
    });
    expect(h.broker.folderRefused(flaky)).toBe(true);
    await rm(flaky);
    await mkdir(flaky);
    h.broker.setPolicy({ ...h.broker.policy });
    expect(h.broker.folderRefused(flaky)).toBe(true);
    h.clock.advance(31_000);
    expect(h.broker.folderRefused(flaky)).toBe(false);
  });
});
