import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
