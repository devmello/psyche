import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getLibraryItem, openDb, setSetting } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { recordingsFolderIo } from "../src/compose/notes-folder.ts";
import { workflowSettings } from "../src/compose/workflow-settings.ts";

/**
 * The recordings-folder watch's file access (#953) on throwaway directories made by the test:
 * the grant check, the top-level listing and the copy into the Library.
 */

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function rig(grant = true) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "psyche-recordings-")));
  const home = join(root, "home");
  const folder = join(root, "recordings");
  mkdirSync(home);
  mkdirSync(folder);
  const db = openDb(":memory:");
  const io = recordingsFolderIo({
    db,
    home,
    folders: () => (grant ? [{ path: folder, mode: "ro" as const }] : []),
  });
  return { db, home, folder, io };
}

describe("recordings folder access", () => {
  it("scans only a granted folder", () => {
    const granted = rig();
    expect(granted.io.granted(granted.folder)).toBe(true);
    expect(granted.io.granted(join(root, "elsewhere"))).toBe(false);
    expect(rig(false).io.granted(join(root, "recordings"))).toBe(false);
  });

  it("lists regular files at the top level only", async () => {
    const r = rig();
    writeFileSync(join(r.folder, "a.m4a"), "abc");
    mkdirSync(join(r.folder, "nested"));
    writeFileSync(join(r.folder, "nested", "b.m4a"), "abc");
    symlinkSync(join(r.folder, "a.m4a"), join(r.folder, "link.m4a"));
    const files = await r.io.list(r.folder);
    expect(files.map((f) => f.name)).toEqual(["a.m4a"]);
    expect(files[0]).toMatchObject({ size: 3 });
  });

  it("refuses to list a folder that is not granted", async () => {
    const r = rig(false);
    await expect(r.io.list(r.folder)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("copies a recording into the Library as an audio item the notes path can read", async () => {
    const r = rig();
    writeFileSync(join(r.folder, "Standup 1.m4a"), "audio-bytes");
    const [file] = await r.io.list(r.folder);
    const { libraryItemId } = await r.io.copy(file as never);
    const item = getLibraryItem(r.db, libraryItemId);
    expect(item).toMatchObject({
      kind: "audio",
      mime: "audio/mp4",
      origin: "upload",
      size: 11,
    });
    expect(readFileSync(join(r.home, "library", item?.path ?? ""), "utf8")).toBe("audio-bytes");
    // The owner's file is untouched.
    expect(readFileSync(join(r.folder, "Standup 1.m4a"), "utf8")).toBe("audio-bytes");
  });

  it("does not copy a file that has been swapped for a link", async () => {
    const r = rig();
    writeFileSync(join(r.folder, "a.m4a"), "abc");
    const [file] = await r.io.list(r.folder);
    rmSync(join(r.folder, "a.m4a"));
    symlinkSync(r.home, join(r.folder, "a.m4a"));
    await expect(r.io.copy(file as never)).rejects.toThrow();
  });
});

describe("meetings.notes.folder setting", () => {
  it("is read as an absolute path, with ~ for the owner's home", () => {
    const db = openDb(":memory:");
    expect(workflowSettings(db).notes.folder).toBeUndefined();
    setSetting(db, "meetings.notes.folder", "~/Documents/Recordings");
    expect(workflowSettings(db).notes.folder).toBe(join(homedir(), "Documents/Recordings"));
    setSetting(db, "meetings.notes.folder", "/Users/me/Voice Memos/");
    expect(workflowSettings(db).notes.folder).toBe("/Users/me/Voice Memos");
    setSetting(db, "meetings.notes.folder", "relative/path");
    expect(workflowSettings(db).notes.folder).toBeUndefined();
    setSetting(db, "meetings.notes.folder", "  ");
    expect(workflowSettings(db).notes.folder).toBeUndefined();
  });
});
