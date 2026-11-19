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

  it("leaves out what a granted folder already covers", async () => {
    expect(await offered([{ path: userHome, mode: "ro" }])).toEqual([]);
    expect(await offered([{ path: join(userHome, "Documents"), mode: "rw" }])).toEqual([
      "desktop",
      "downloads",
    ]);
  });
});

describe("policy folders with ~", () => {
  it("expand to the absolute path, other entries untouched", () => {
    const out = expandPolicyFolders(
      {
        mode: "x",
        folders: [
          { path: "~/Documents", mode: "ro" },
          { path: "/abs", mode: "rw" },
        ],
      },
      "/Users/ada",
    );
    expect(out).toEqual({
      mode: "x",
      folders: [
        { path: "/Users/ada/Documents", mode: "ro" },
        { path: "/abs", mode: "rw" },
      ],
    });
  });
});
