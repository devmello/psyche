import { appendFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsSkillLoader } from "../src/loader.ts";
import { writeLock } from "../src/lock.ts";
import { readSkillDir, treeHash } from "../src/tree.ts";
import { setup, writeSkill } from "./helpers.ts";

const spies = vi.hoisted(() => ({ read: vi.fn(), hash: vi.fn() }));

vi.mock("../src/tree.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tree.ts")>();
  return {
    ...real,
    readSkillDir: (...a: Parameters<typeof real.readSkillDir>) => {
      spies.read(...a);
      return real.readSkillDir(...a);
    },
    treeHash: (...a: Parameters<typeof real.treeHash>) => {
      spies.hash(...a);
      return real.treeHash(...a);
    },
  };
});

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  vi.useRealTimers();
});

function approve(loader: FsSkillLoader, dir: string, name: string) {
  writeLock(loader.lockPath, {
    version: 1,
    skills: {
      [`workspace:${name}`]: {
        name,
        scope: "workspace",
        origin: { kind: "workspace" },
        treeHash: treeHash(readSkillDir(dir)),
        trust: "local",
        approvalId: "ap1",
        approvedAt: "2026-10-18T20:00:00.000Z",
        findings: { high: 0, warn: 0, info: 0 },
      },
    },
  });
}

/** An approved workspace skill, with the loader watching so reads don't refresh on their own. */
function fixture(rescanMs = 1_000_000, forceEvery?: number) {
  const t = setup();
  const dir = writeSkill(t.workspaceDir, "notes", { files: { "scripts/run.py": "print(1)\n" } });
  approve(t.loader, dir, "notes");
  stops.push(t.loader.watch(1_000_000, rescanMs, forceEvery));
  spies.read.mockClear();
  spies.hash.mockClear();
  const status = async () => (await t.loader.listDetailed())[0]?.status;
  const cached = () => t.loader.refresh({ useCache: true });
  return { ...t, dir, status, cached, file: join(dir, "scripts/run.py") };
}

describe("periodic rescan cache", () => {
  it("an unchanged tree is not re-read or re-hashed", async () => {
    const t = fixture();
    expect(await t.status()).toBe("active");
    t.cached();
    t.cached();
    expect(spies.read).not.toHaveBeenCalled();
    expect(spies.hash).not.toHaveBeenCalled();
    expect(await t.status()).toBe("active");
  });

  it("an explicit refresh reads everything, as before", () => {
    const t = fixture();
    t.loader.refresh();
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(spies.hash).toHaveBeenCalledTimes(1);
  });

  it("a changed file is re-hashed and loses the approval", async () => {
    const t = fixture();
    appendFileSync(t.file, "import os\n");
    t.cached();
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(await t.status()).toBe("hash_mismatch");
  });

  it("same size, new mtime is re-hashed and loses the approval", async () => {
    const t = fixture();
    writeFileSync(t.file, "print(2)\n");
    t.cached();
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(await t.status()).toBe("hash_mismatch");
  });

  it("an added or removed file is re-read", async () => {
    const t = fixture();
    writeFileSync(join(t.dir, "extra.txt"), "x");
    t.cached();
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(await t.status()).toBe("hash_mismatch");
    rmSync(join(t.dir, "extra.txt"));
    t.cached();
    expect(spies.read).toHaveBeenCalledTimes(2);
    expect(await t.status()).toBe("active");
  });

  it("restoring the mtime still misses, because ctime moved", async () => {
    const t = fixture();
    const { atime, mtime } = statSync(t.file);
    writeFileSync(t.file, "print(2)\n");
    utimesSync(t.file, atime, mtime);
    t.cached();
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(await t.status()).toBe("hash_mismatch");
  });

  it("a symlink added to the tree misses and the skill is not loaded", async () => {
    const t = fixture();
    symlinkSync("/etc/hosts", join(t.dir, "link"));
    t.cached();
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(await t.status()).toBe("invalid");
  });

  it("a folder that cannot be statted is dropped, not served from the cache", async () => {
    const t = fixture();
    rmSync(t.dir, { recursive: true });
    expect(t.cached().removed).toEqual(["workspace:notes"]);
    expect(await t.status()).toBeUndefined();
  });
});

describe("periodic rescan scheduling", () => {
  it("the tick uses the cache and every Nth tick forces a full read", () => {
    vi.useFakeTimers();
    const t = fixture(1_000, 3);
    vi.advanceTimersByTime(1_001); // pass 1: cached
    vi.advanceTimersByTime(1_001); // pass 2: cached
    expect(spies.read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_001); // pass 3: forced, signatures unchanged
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(spies.hash).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_001); // pass 4: cached again
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(t.loader).toBeDefined();
  });

  it("a changed file is caught by the cached tick", async () => {
    vi.useFakeTimers();
    const t = fixture(1_000, 100);
    appendFileSync(t.file, "# edit\n");
    vi.advanceTimersByTime(1_001);
    expect(spies.read).toHaveBeenCalledTimes(1);
    expect(await t.status()).toBe("hash_mismatch");
  });
});
