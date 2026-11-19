import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesHandlers } from "../src/compose/files.ts";
import { expandPolicyFolders } from "../src/handlers/settings.ts";

let base: string;
let userHome: string;
let psycheHome: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "psyche-starter-")));
  userHome = join(base, "user");
  psycheHome = join(base, "psyche");
  await mkdir(psycheHome, { recursive: true });
  for (const n of ["Documents", "Desktop", "Downloads"])
    await mkdir(join(userHome, n), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const offered = async (
  folders: { path: string; mode: "ro" | "rw" }[] = [],
  home = psycheHome,
): Promise<string[]> => {
  const h = filesHandlers({ folders: () => folders, home, userHome })["files.starterFolders"];
  const r = (await h?.run({} as never, {} as never)) as { folders: { id: string }[] };
  return r.folders.map((f) => f.id);
};

describe("files.starterFolders", () => {
  it("offers Documents, Desktop and Downloads, never the home folder", async () => {
    expect(await offered()).toEqual(["documents", "desktop", "downloads"]);
  });

  it("leaves out a folder that is missing", async () => {
    await rm(join(userHome, "Desktop"), { recursive: true });
    expect(await offered()).toEqual(["documents", "downloads"]);
  });

  it("leaves out a sensitive root (assertFolderGrantable refuses it)", async () => {
    // Psyche's own home lying at ~/Downloads makes that folder a protected root.
    expect(await offered([], join(userHome, "Downloads"))).toEqual(["documents", "desktop"]);
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "a stored folder that differs only in case counts as shared",
    async () => {
      expect(await offered([{ path: join(userHome, "documents"), mode: "ro" }])).toEqual([
        "desktop",
        "downloads",
      ]);
    },
  );

  it("leaves out what a granted folder already covers", async () => {
    expect(await offered([{ path: userHome, mode: "ro" }])).toEqual([]);
    expect(await offered([{ path: join(userHome, "Documents"), mode: "rw" }])).toEqual([
      "desktop",
      "downloads",
    ]);
  });
});

describe("policy folders with ~", () => {
  const out = (path: string) =>
    (
      expandPolicyFolders({ folders: [{ path, mode: "ro" }] }, undefined, "/Users/ada") as {
        folders: { path: string }[];
      }
    ).folders[0]?.path;

  it("expands a leading ~/ to the owner's home", () => {
    expect(out("~/Documents")).toBe("/Users/ada/Documents");
  });

  it("normalises .. after expansion, so ~/../x is the real path", () => {
    expect(out("~/../x")).toBe("/Users/x");
    expect(out("~/../..")).toBe("/");
  });

  it("refuses ~user/ and a bare ~", () => {
    expect(() => out("~root/x")).toThrow();
    expect(() => out("~")).toThrow();
  });

  it("leaves a plain absolute path and other keys untouched", () => {
    expect(out("/abs/dir")).toBe("/abs/dir");
    expect(expandPolicyFolders({ mode: "x" }, undefined, "/Users/ada")).toEqual({ mode: "x" });
  });

  it("an escape lands on a path assertFolderGrantable refuses", async () => {
    const { assertFolderGrantable } = await import("@psyche/permissions");
    await expect(assertFolderGrantable(out("~/../..") ?? "")).rejects.toThrow();
  });

  it("expands only NEW entries: a stored ~/x stays literal, a new ~/y expands", () => {
    const stored = { folders: [{ path: "~/x", mode: "rw" }] };
    const value = {
      note: "unrelated change",
      folders: [
        { path: "~/x", mode: "rw" },
        { path: "~/y", mode: "ro" },
      ],
    };
    expect(expandPolicyFolders(value, stored, "/Users/ada")).toEqual({
      note: "unrelated change",
      folders: [
        { path: "~/x", mode: "rw" },
        { path: "/Users/ada/y", mode: "ro" },
      ],
    });
  });
});
