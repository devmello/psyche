import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/context.ts";
import { scriptedPrompter } from "../src/prompt.ts";
import { closedPort } from "./helpers.ts";

/**
 * Gateway → CLI round trip with a real `psyched` process: the running Gateway writes the archive
 * (`psyche backup create` → `backup.create`, SQLite online backup, no downtime), and `psyche
 * backup restore` restores it into a fresh home that a second `psyched` then boots from.
 */

const PSYCHED = resolve(import.meta.dirname, "../../gateway/src/main.ts");
const PASS = "correct horse battery staple";
const dirs: string[] = [];
const procs: ChildProcess[] = [];

function shortTemp(): string {
  // macOS caps Unix socket paths at 104 bytes; keep $PSYCHE_HOME short.
  const d = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "psy-rt-"));
  dirs.push(d);
  return d;
}

async function startPsyched(home: string): Promise<string> {
  const child = spawn(process.execPath, [PSYCHED], {
    env: {
      ...process.env,
      PSYCHE_HOME: home,
      PSYCHE_PORT: "0",
      PSYCHE_BROWSER: "off",
      PSYCHE_LOG_LEVEL: "info",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  procs.push(child);
  return new Promise((resolveOrigin, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`psyched did not start:\n${buf}`)), 30_000);
    child.stderr?.on("data", (d) => {
      buf += String(d);
      const m = /"msg":"gateway listening","origin":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(buf);
      if (m?.[1]) {
        clearTimeout(timer);
        resolveOrigin(m[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`psyched exited ${code}:\n${buf}`));
    });
  });
}

function deps(home: string, env: Record<string, string> = {}): Deps & { stdout: string[] } {
  const stdout: string[] = [];
  return {
    stdout,
    env: { HOME: home, PSYCHE_HOME: home, ...env },
    io: { out: (t) => stdout.push(t), err: () => {}, stdin: new PassThrough() },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    fetch,
    prompter: scriptedPrompter([], false),
    platform: process.platform === "darwin" ? "darwin" : "linux",
    uid: 501,
    now: () => new Date(),
  };
}

async function cli(home: string, url: string, argv: string[], env: Record<string, string> = {}) {
  const d = deps(home, env);
  const code = await run([...argv, "--url", url, "--json"], d);
  return { code, json: JSON.parse(d.stdout.join("\n") || "null") as Record<string, unknown> };
}

async function paired(home: string, url: string): Promise<void> {
  const first = await cli(home, url, ["devices", "list"]);
  const code = (first.json.error as { details: { code: string } }).details.code;
  execFileSync(process.execPath, [PSYCHED, "devices", "approve", code], {
    env: { ...process.env, PSYCHE_HOME: home },
  });
}

let home = "";
let url = "";

beforeAll(async () => {
  home = shortTemp();
  url = await startPsyched(home);
  await paired(home, url);
}, 60_000);

afterAll(() => {
  for (const p of procs.splice(0)) p.kill("SIGTERM");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("backup made by the running Gateway, restored by the CLI", () => {
  it("round trips state, workspace and settings without stopping the Gateway", async () => {
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "MEMORY.md"), "# Memory\n- likes tea\n");
    expect((await cli(home, url, ["config", "set", "appearance.theme", "dark"])).code).toBe(0);

    const created = await cli(home, url, ["backup", "create"], { PSYCHE_BACKUP_PASSPHRASE: PASS });
    expect(created.code).toBe(0);
    expect(created.json).toMatchObject({ via: "gateway", encrypted: true });
    const file = String(created.json.file);
    expect(existsSync(file)).toBe(true);
    // Still running and answering.
    expect((await cli(home, url, ["status"])).code).toBe(0);

    // The CLI verifies and restores it into a fresh home (no Gateway there).
    const offline = `http://127.0.0.1:${await closedPort()}`;
    const target = join(shortTemp(), "home");
    const verify = await cli(target, offline, ["backup", "verify", file], {
      PSYCHE_BACKUP_PASSPHRASE: PASS,
    });
    expect(verify).toMatchObject({ code: 0, json: { ok: true } });
    const restored = await cli(target, offline, ["backup", "restore", file], {
      PSYCHE_BACKUP_PASSPHRASE: PASS,
    });
    expect(restored.code).toBe(0);
    expect(readFileSync(join(target, "workspace", "MEMORY.md"), "utf8")).toContain("likes tea");
    const db = new DatabaseSync(join(target, "state", "psyche.sqlite"), { readOnly: true });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("appearance.theme") as
      | { value: string }
      | undefined;
    db.close();
    expect(row?.value).toContain("dark");

    // A Gateway boots from the restored home.
    const url2 = await startPsyched(target);
    expect((await fetch(`${url2}/healthz`)).ok).toBe(true);
  }, 120_000);
});
