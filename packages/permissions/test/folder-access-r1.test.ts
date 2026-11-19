import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownCliDirs } from "@psyche/model-router";
import { beforeAll, describe, expect, it } from "vitest";
import { FOLDER_FRESH_MS } from "../src/broker.ts";
import {
  assertFolderGrantable,
  inSystemRoot,
  refuseFolder,
  resolveFilePick,
  resolveFolderPick,
  resolveRequestedFolder,
} from "../src/index.ts";
import { call, makeBroker, path } from "./helpers.ts";

/** Review round 1 of #1384: macOS magic names, Settings fallback, CLI dirs, every folder reader. */

const WIN = process.platform === "win32";
let home: string;
let env: { home: string; psycheHome: string; caseInsensitive: boolean };

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psy-r1-")));
  await mkdir(join(home, "Projects"), { recursive: true });
  env = { home, psycheHome: join(home, ".psyche"), caseInsensitive: true };
});

describe.skipIf(WIN)("macOS names that open another file (finding 1)", () => {
  const mac = () => ({ ...env, platform: "darwin" as const });
  const magic = () => [
    "/.nofollow/opt/homebrew",
    "/.nofollow/opt/homebrew/Cellar",
    `/.nofollow${home}/.ssh`,
    "/.nofollow/Library",
    "/.nofollow/Applications",
    "/.nofollow/usr/local",
    `/.nofollow${home}/.psyche/vault`,
    "/.vol/16777232/51890",
    "/.resolve/1/x",
    "//.nofollow/opt/homebrew",
    "/opt/../.nofollow/opt/homebrew",
  ];

  it("refuses every one, for grants and for use", () => {
    for (const p of magic()) {
      expect(refuseFolder(p, mac()), p).toBe("sensitive_root");
      expect(inSystemRoot(p, mac()), p).toBe(true);
    }
  });

  it("still allows ordinary places", () => {
    for (const p of [join(home, "Projects"), "/Volumes/External/x", "/Users/Shared/x", "/tmp/x"]) {
      expect(refuseFolder(p, mac()), p).toBeUndefined();
      expect(inSystemRoot(p, mac()), p).toBe(false);
    }
  });

  it("only on macOS: a dot folder at / elsewhere is not special", () => {
    expect(refuseFolder("/.data/x", { ...env, platform: "linux" })).toBeUndefined();
  });

  it.runIf(process.platform === "darwin")("refuses them through every resolver", async () => {
    for (const p of [
      `/.nofollow${home}/Projects`,
      "/.nofollow/opt/homebrew",
      "/.nofollow/usr/local",
    ]) {
      await expect(assertFolderGrantable(p, env), p).rejects.toMatchObject({ code: "forbidden" });
      await expect(resolveFolderPick(p, env), p).rejects.toMatchObject({ code: "forbidden" });
      await expect(resolveFilePick(p, env), p).rejects.toBeDefined();
      expect((await resolveRequestedFolder(p, env)).status, p).not.toBe("ok");
    }
  });
});

describe.skipIf(WIN)("Settings: only ENOENT falls back to the typed path (finding 2)", () => {
  it("refuses a path whose realpath fails some other way", async () => {
    const loop = join(home, "loop");
    await symlink(loop, loop);
    await expect(assertFolderGrantable(loop, env)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("still judges a folder that does not exist yet by its typed path", async () => {
    await expect(
      assertFolderGrantable(join(home, "Projects", "new-one"), env),
    ).resolves.toBeUndefined();
    await expect(assertFolderGrantable("/opt/homebrew/not-yet", env)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe.skipIf(WIN)("CLI binary folders in home (finding 5)", () => {
  const REFUSED = [
    ".local/bin",
    ".local/share/claude",
    ".local/share/claude/versions/1.2.3",
    ".npm-global",
    ".bun",
    ".claude/local",
    ".nvm",
    ".nvm/versions/node/v22.1.0/bin",
    ".volta",
    ".yarn/bin",
    ".cargo/bin",
    "Library/pnpm",
    // A parent of one: refused like any sensitive parent.
    ".local",
    ".local/share",
    ".cargo",
    ".claude",
    ".yarn",
  ];
  it.each(REFUSED)("refuses ~/%s", (rel) => {
    expect(refuseFolder(join(home, rel), env)).toBeDefined();
  });

  it("allows the neighbours that hold no binary", () => {
    for (const rel of [
      ".local-notes",
      ".cargo-cache/x",
      "Projects/.local/bin",
      ".bunker",
      "code",
    ]) {
      expect(refuseFolder(join(home, rel), env), rel).toBeUndefined();
    }
  });

  it("covers every directory the CLI resolver searches", () => {
    for (const dir of knownCliDirs(home).filter((d) => d.startsWith(home))) {
      expect(refuseFolder(dir, env), dir).toBeDefined();
    }
  });

  it("ignores an old grant on ~/.local at use, but keeps an old home grant", () => {
    const h = makeBroker({
      policy: {
        folders: [
          { path: join(home, ".local"), mode: "rw" },
          { path: join(home, ".local/share/claude"), mode: "rw" },
          { path: home, mode: "rw" },
          { path: join(home, "Projects"), mode: "rw" },
        ],
      },
      hostProgram: { home },
    });
    expect(h.broker.grantedFolders().map((f) => f.path)).toEqual([home, join(home, "Projects")]);
  });
});

describe.skipIf(WIN)("every reader of the granted folders sees the filter (3, 4, 6)", () => {
  const ctx = { threadId: "thr_a", runId: "run_1", permissionMode: "balanced", taint: false };

  it("grantedFolders and liveSessionFolders leave out an old /opt grant", () => {
    const h = makeBroker({
      policy: {
        folders: [
          { path: "/opt/homebrew", mode: "rw" },
          { path: "/Users/o/Projects", mode: "rw" },
        ],
      },
      hostProgram: { home: "/Users/o" },
    });
    expect(h.broker.grantedFolders()).toEqual([{ path: "/Users/o/Projects", mode: "rw" }]);
    expect(h.broker.liveSessionFolders("thr_a")).toEqual([]);
  });

  it("setPolicy applies the same filter to the next call", async () => {
    const h = makeBroker({ policy: { folders: [] }, hostProgram: { home: "/Users/o" } });
    h.broker.setPolicy({ folders: [{ path: "/opt/local", mode: "rw" }] });
    expect(h.broker.grantedFolders()).toEqual([]);
    const d = await h.broker.decide(
      call("write_file", "write", path("/opt/local/bin/x")),
      ctx as never,
    );
    expect(d).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
  });

  it("a workspace root on /opt, / or /usr/local covers nothing", async () => {
    for (const root of ["/opt/homebrew", "/", "/usr/local"]) {
      const h = makeBroker({
        policy: { workspaceRoots: [root] },
        hostProgram: { home: "/Users/o" },
      });
      const d = await h.broker.decide(
        call("write_file", "write", path("/opt/homebrew/bin/x")),
        ctx as never,
      );
      expect(d, root).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
    }
    const ok = makeBroker({ policy: { workspaceRoots: ["/workspace"] } });
    const d = await ok.broker.decide(call("read_file", "read", path("/workspace/a")), ctx as never);
    expect(d.rule).toBe("folder:workspace");
  });

  it("a granted folder swapped for a link to /opt or to another folder stops counting by the next look", async () => {
    const root = join(home, "swap-root");
    await mkdir(root);
    const h = makeBroker({
      policy: { folders: [{ path: root, mode: "rw" }] },
      hostProgram: { home },
    });
    await h.broker.foldersSettled();
    expect(h.broker.grantedFolders()).toHaveLength(1);
    // One read through the fresh accessor (r2: a second read hid a stale first answer).
    const look = async () => {
      h.clock.advance(FOLDER_FRESH_MS + 1);
      return (await h.broker.freshGrantedFolders()).map((f) => f.path);
    };
    await rm(root, { recursive: true });
    await symlink("/opt", root);
    expect(await look()).toEqual([]);
    expect(h.broker.grantedFolders()).toHaveLength(0);
    await rm(root);
    await symlink(join(home, "Projects"), root);
    expect(await look()).toEqual([]);
    expect(h.broker.grantedFolders()).toHaveLength(0);
  });
});
