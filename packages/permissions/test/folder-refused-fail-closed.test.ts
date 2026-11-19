import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(h.broker.folderRefused(flaky)).toBe(true);
      await rm(flaky);
      await mkdir(flaky);
      // Within the retry window the error answer holds (a hung mount isn't looked up each call).
      expect(h.broker.folderRefused(flaky)).toBe(true);
      // No setPolicy in between: after the window the folder is judged again.
      vi.advanceTimersByTime(31_000);
      expect(h.broker.folderRefused(flaky)).toBe(false);
      expect(h.broker.grantedFolders()).toEqual([{ path: flaky, mode: "rw" }]);
    } finally {
      vi.useRealTimers();
    }
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
