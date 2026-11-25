import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeGuestPointer, writeSocketPointer } from "../src/socket-path.ts";

const homes: string[] = [];
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "psy-pointer-"));
  mkdirSync(join(h, "run"));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("node-socket pointer", () => {
  it("replaces the pointer with a new file each start, never rewriting it in place", () => {
    const h = home();
    const file = join(h, "run", "node-socket");
    // What a Gateway that crashed leaves behind: the old pointer, still there.
    writeFileSync(file, "/old/path/node.sock\n", { mode: 0o644 });
    const before = statSync(file).ino;

    writeSocketPointer(h, "/tmp/psyche-501/abc.sock");
    expect(readFileSync(file, "utf8")).toBe("/tmp/psyche-501/abc.sock\n");
    // A new inode is a new directory entry: the helper's watcher of `run/` hears it, and a reader
    // never sees a half-written (empty) pointer.
    expect(statSync(file).ino).not.toBe(before);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // No temporary file is left next to it.
    expect(readdirSync(join(h, "run"))).toEqual(["node-socket"]);
  });

  it("writes the guest pointer the same way", () => {
    const h = home();
    writeGuestPointer(h, "\\\\.\\pipe\\psyche-guest-x");
    writeGuestPointer(h, "\\\\.\\pipe\\psyche-guest-y");
    expect(readFileSync(join(h, "run", "guest-socket"), "utf8")).toBe(
      "\\\\.\\pipe\\psyche-guest-y\n",
    );
    expect(readdirSync(join(h, "run"))).toEqual(["guest-socket"]);
  });

  it("fails loudly, and leaves nothing behind, when run/ is missing", () => {
    const h = mkdtempSync(join(tmpdir(), "psy-pointer-"));
    homes.push(h);
    expect(() => writeSocketPointer(h, "/x.sock")).toThrow();
    expect(readdirSync(h)).toEqual([]);
  });
});
