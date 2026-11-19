import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  accessEntries,
  assertFolderGrantable,
  refuseFolder,
  resolveFilePick,
  resolveFolderPick,
  resolveRequestedFolder,
} from "../src/index.ts";
import { call, makeBroker, path } from "./helpers.ts";

/**
 * Installed-software roots (`/opt`, `/opt/homebrew`, `/opt/local`, Linux `/snap`, `/nix`): a
 * read-write grant there would let `write_file` replace a binary the app runs (the `op` CLI), so
 * they are refused like `/usr`, at grant time and, for a folder granted before, at use.
 */

const WIN = process.platform === "win32";
let home: string;
let env: { home: string; psycheHome: string; caseInsensitive: boolean };

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psy-opt-")));
  await mkdir(join(home, "Projects"), { recursive: true });
  env = { home, psycheHome: join(home, ".psyche"), caseInsensitive: true };
});

describe.skipIf(WIN)("installed-software roots", () => {
  const REFUSED = [
    "/opt",
    "/opt/homebrew",
    "/opt/homebrew/bin",
    "/opt/homebrew/bin/op",
    "/opt/local",
    "/opt/local/bin",
    "/OPT",
    "/Opt/Homebrew/bin",
    "/opt/HOMEBREW",
    "/opt/../opt/homebrew",
    "/System/Volumes/Data/opt/homebrew",
    "/System/Volumes/Data/opt",
    // Already refused, kept as controls: Intel Homebrew and Linux system trees.
    "/usr/local/bin",
    "/usr/local/Cellar",
    "/snap",
    "/snap/bin",
    "/nix/store",
    "/lib64",
    "/boot",
  ];
  it.each(REFUSED)("refuses %s", (p) => {
    expect(refuseFolder(p, env)).toBe("sensitive_root");
  });

  it("compares case only on a case-insensitive volume", () => {
    expect(refuseFolder("/OPT/homebrew", { ...env, caseInsensitive: false })).toBeUndefined();
    expect(refuseFolder("/opt/homebrew", { ...env, caseInsensitive: false })).toBe(
      "sensitive_root",
    );
  });

  const ALLOWED = [
    "/Volumes/External/x",
    "/optics",
    "/optics/homebrew",
    "/opt2",
    "/snapshots",
    "/nixos",
    "/boots",
  ];
  it.each(ALLOWED)("allows %s", (p) => {
    expect(refuseFolder(p, env)).toBeUndefined();
  });

  it("allows a project folder under home", () => {
    expect(refuseFolder(join(home, "Projects"), env)).toBeUndefined();
  });

  it("refuses a typed Settings grant under /opt, whatever its case", async () => {
    await expect(assertFolderGrantable("/opt/homebrew", env)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(assertFolderGrantable("/OPT/homebrew/bin", env)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(assertFolderGrantable(join(home, "Projects"), env)).resolves.toEqual(
      expect.any(String),
    );
  });

  it.runIf(existsSync("/opt"))("judges a symlink from home by where it leads", async () => {
    const target = existsSync("/opt/homebrew") ? "/opt/homebrew" : "/opt";
    const link = join(home, "brew");
    await symlink(target, link);
    await expect(resolveFolderPick(link, env)).rejects.toMatchObject({ code: "forbidden" });
    await expect(assertFolderGrantable(link, env)).rejects.toMatchObject({ code: "forbidden" });
    expect(await resolveRequestedFolder(link, env)).toMatchObject({
      status: "blocked",
      reason: "sensitive_root",
    });
  });

  it.runIf(existsSync("/opt/homebrew/bin"))(
    "refuses a file attached from /opt/homebrew",
    async () => {
      const first = readdirSync("/opt/homebrew/bin")[0];
      if (first === undefined) return;
      await expect(resolveFilePick(join("/opt/homebrew/bin", first), env)).rejects.toMatchObject({
        code: "forbidden",
        details: { reason: "sensitive_root" },
      });
    },
  );
});

describe.skipIf(WIN)("a folder granted under /opt before the rule", () => {
  const policy = () => ({
    folders: [
      { path: "/opt/homebrew", mode: "rw" as const },
      { path: "/Users/o/Projects", mode: "rw" as const },
    ],
  });
  const ctx = { threadId: "thr_a", runId: "run_1", permissionMode: "balanced", taint: false };

  it("covers nothing at use: write_file there is denied as not granted", async () => {
    const h = makeBroker({ policy: policy(), hostProgram: { home: "/Users/o" } });
    const d = await h.broker.decide(
      call("write_file", "write", path("/opt/homebrew/bin/op")),
      ctx as never,
    );
    expect(d).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
    // The neighbouring folder is untouched by the change.
    const ok = await h.broker.decide(
      call("write_file", "write", path("/Users/o/Projects/a.txt")),
      ctx as never,
    );
    expect(ok.rule).not.toBe("folder:not_granted");
  });

  it("lists as refused in Settings, and only that row", async () => {
    const h = makeBroker({ policy: policy(), hostProgram: { home: "/Users/o" } });
    const entries = await accessEntries(h.broker);
    expect(entries.map((e) => [e.path, e.refused])).toEqual([
      ["/opt/homebrew", true],
      ["/Users/o/Projects", undefined],
    ]);
  });

  it("an exec_host command in that folder is not allowed either", async () => {
    const h = makeBroker({
      policy: { ...policy(), exec: { execHostEnabled: true } },
      hostProgram: { home: "/Users/o" },
    });
    const d = await h.broker.decide(
      call("exec_host", "destructive", undefined, {
        params: { argv: ["ls"], cwd: "/opt/homebrew/bin" },
      }),
      ctx as never,
    );
    expect(d).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
  });
});
