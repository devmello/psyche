import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { takeExclusiveFileLock } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireGatewayLock,
  GATEWAY_LOCK_FILE,
  readUpdateFailure,
  releaseGatewayLock,
  sha256File,
} from "../src/pre-update.ts";

/**
 * The Gateway lock is the kernel's: gone the moment its holder dies, however it dies, and
 * never decided by a pid someone else may have reused (review round 3, H-a). Other processes
 * are real: each test spawns the real code in a child.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const CHILD = join(import.meta.dirname, "fixtures", "lock-child.mts");

const dirs: string[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const d = mkdtempSync(join(tmpdir(), "psy-lock-"));
  dirs.push(d);
  return d;
}

/** Starts a child on `h` and resolves with what it printed first. */
function child(h: string, impl = ""): Promise<{ proc: ChildProcess; said: string }> {
  return new Promise((ok, fail) => {
    const proc = spawn(process.execPath, ["--import", "tsx", CHILD, h, impl], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    kids.push(proc);
    let out = "";
    let err = "";
    proc.stderr.on("data", (d) => {
      err += String(d);
    });
    proc.stdout.on("data", (d) => {
      out += String(d);
      if (out.includes("\n")) ok({ proc, said: out.trim() });
    });
    proc.on("exit", (code) => fail(new Error(`child exited ${code} before answering: ${err}`)));
  });
}

const exited = (p: ChildProcess) => new Promise<void>((r) => p.once("exit", () => r()));

describe("the Gateway lock", () => {
  it("is free again the moment a holder dies (SIGKILL), with its note still lying there", async () => {
    const h = home();
    const first = await child(h);
    expect(first.said).toBe("OK");
    const dying = exited(first.proc);
    first.proc.kill("SIGKILL");
    await dying;
    // The file with the dead holder's pid is still there; nothing decides by it.
    expect(() => acquireGatewayLock(h)).not.toThrow();
    releaseGatewayLock(h);
  }, 60_000);

  it("is refused while an unrelated live process holds it, and says so for the splash", async () => {
    const h = home();
    const holder = await child(h);
    expect(holder.said).toBe("OK");
    expect(() => acquireGatewayLock(h, { build: "build-b", version: "0.5.0" })).toThrow(
      /already using this data folder/,
    );
    const note = readUpdateFailure(h);
    expect(note).toMatchObject({ key: "gateway-running", build: "build-b", restored: true });
    expect(note?.message).toContain(`process ${holder.proc.pid}`);
    // Once it is gone the same call works, and the note is no longer in the way.
    const gone = exited(holder.proc);
    holder.proc.kill("SIGKILL");
    await gone;
    expect(() => acquireGatewayLock(h)).not.toThrow();
    releaseGatewayLock(h);
  }, 60_000);

  it("is not fooled by a note naming a live pid that holds nothing", () => {
    const h = home();
    mkdirSync(join(h, "run"), { recursive: true });
    // After a reboot the old pid often belongs to some other process that is alive.
    writeFileSync(join(h, GATEWAY_LOCK_FILE), JSON.stringify({ pid: process.ppid }));
    expect(() => acquireGatewayLock(h)).not.toThrow();
    releaseGatewayLock(h);
  });

  it("lets exactly one of two racing starts have it", async () => {
    const h = home();
    const [a, b] = await Promise.all([child(h), child(h)]);
    expect([a.said, b.said].sort()).toEqual(["FAIL gateway_running", "OK"]);
  }, 60_000);

  it("works the same with the SQLite lock used where O_EXLOCK does not exist", async () => {
    const h = home();
    mkdirSync(join(h, "run"), { recursive: true });
    const file = join(h, "lock");
    const mine = takeExclusiveFileLock(file, "sqlite");
    expect(mine).not.toBeNull();
    expect(takeExclusiveFileLock(file, "sqlite")).toBeNull();
    mine?.release();
    const again = takeExclusiveFileLock(file, "sqlite");
    expect(again).not.toBeNull();
    again?.release();
    // And across processes, through the real code path.
    const holder = await child(h, "sqlite");
    expect(holder.said).toBe("OK");
    const second = await child(h, "sqlite");
    expect(second.said).toBe("FAIL gateway_running");
  }, 60_000);

  it("takes the platform's lock without leaving the process holding two", () => {
    const h = home();
    mkdirSync(join(h, "run"), { recursive: true });
    const file = join(h, "lock");
    const first = takeExclusiveFileLock(file);
    expect(first).not.toBeNull();
    // A second open in this very process conflicts too: the lock is per open file, so this
    // process asks once per data folder (acquireGatewayLock remembers).
    expect(takeExclusiveFileLock(file)).toBeNull();
    first?.release();
  });
});

describe("hashing a big file (H-c)", () => {
  it("streams a sparse file larger than Node will read whole, without holding it in memory", () => {
    const h = home();
    const big = join(h, "big.db");
    const size = 2 * 1024 ** 3 + 5 * 1024 ** 2; // just over 2 GiB: readFileSync refuses this
    const fd = openSync(big, "w");
    closeSync(fd);
    truncateSync(big, size);
    const expected = createHash("sha256");
    const zeros = Buffer.alloc(1 << 20);
    for (let left = size; left > 0; left -= zeros.length)
      expected.update(left >= zeros.length ? zeros : zeros.subarray(0, left));
    const before = process.memoryUsage().rss;
    expect(sha256File(big)).toBe(expected.digest("hex"));
    // Streamed in 1 MiB pieces: nowhere near the file's size.
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 ** 2);
  }, 120_000);
});
