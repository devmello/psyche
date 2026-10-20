import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { startGateway } from "@psyche/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/context.ts";
import { knownMigrations, migrationsFromDir, planMigrations } from "../src/migrate.ts";
import { scriptedPrompter } from "../src/prompt.ts";
import { closedPort } from "./helpers.ts";

/** `psyche migrate --check` and the release scripts it relies on (roadmap v1.0). */

const ROOT = resolve(import.meta.dirname, "../../..");
const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "psy-mig-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function migrate(home: string, now = new Date()) {
  const stdout: string[] = [];
  const deps: Deps = {
    env: { HOME: home, PSYCHE_HOME: home },
    io: { out: (t) => stdout.push(t), err: () => {}, stdin: new PassThrough() },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    fetch,
    prompter: scriptedPrompter([], false),
    platform: "linux",
    uid: 501,
    now: () => now,
  };
  const url = `http://127.0.0.1:${await closedPort()}`;
  const code = await run(["migrate", "--check", "--url", url, "--json"], deps);
  return { code, json: JSON.parse(stdout.join("\n")) as Record<string, unknown> };
}

describe("planMigrations", () => {
  const k = [
    { id: "1_a_x", checksum: "sha256:1" },
    { id: "2_b_y", checksum: "sha256:2" },
  ];
  it("lists pending, unknown (downgrade) and modified migrations", () => {
    expect(planMigrations([], k)).toEqual({
      pending: ["1_a_x", "2_b_y"],
      unknown: [],
      modified: [],
      applied: 0,
    });
    expect(planMigrations([k[0] as never], k)).toMatchObject({
      pending: ["2_b_y"],
      unknown: [],
      modified: [],
    });
    expect(planMigrations([...k, { id: "3_c_z", checksum: "sha256:3" }], k)).toMatchObject({
      pending: [],
      unknown: ["3_c_z"],
    });
    expect(planMigrations([{ id: "1_a_x", checksum: "sha256:changed" }], k)).toMatchObject({
      modified: ["1_a_x"],
    });
  });
});

describe("psyche migrate --check", () => {
  it("a new install: no database yet, every migration applies at first start", async () => {
    const home = temp();
    const { code, json } = await migrate(home);
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.database).toMatchObject({ exists: false });
  });

  it("is up to date on a database the real Gateway created (same checksum rule as @psyche/db)", async () => {
    const home = temp();
    const gw = await startGateway({
      config: { home, port: 0, webRoot: null },
      env: {},
      logger: { log() {} } as never,
      retentionIntervalMs: 0,
    });
    await gw.stop("test");
    const { code, json } = await migrate(home);
    expect(code).toBe(0);
    expect(json.database).toMatchObject({ exists: true, pending: [], unknown: [], modified: [] });
    expect((json.database as { applied: number }).applied).toBe(knownMigrations()?.length);
  });

  it("refuses data from a newer version and edited migrations (exit 1), warns on an old backup", async () => {
    const home = temp();
    mkdirSync(join(home, "state"), { recursive: true });
    const db = new DatabaseSync(join(home, "state", "psyche.sqlite"));
    db.exec(
      "CREATE TABLE _migrations (id TEXT PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)",
    );
    const known = knownMigrations() ?? [];
    const insert = db.prepare("INSERT INTO _migrations VALUES (?, ?, ?, ?)");
    for (const m of known) insert.run(m.id, `${m.id}.sql`, m.checksum, "2026-10-19T00:00:00Z");
    insert.run("209912312359_future_thing", "x.sql", "sha256:0", "2099-12-31T00:00:00Z");
    db.close();
    const newer = await migrate(home);
    expect(newer.code).toBe(1);
    expect(newer.json.database).toMatchObject({ unknown: ["209912312359_future_thing"] });
    expect(JSON.stringify(newer.json.checks)).toContain("newer Psyche");

    const db2 = new DatabaseSync(join(home, "state", "psyche.sqlite"));
    db2.exec("DELETE FROM _migrations WHERE id = '209912312359_future_thing'");
    db2
      .prepare("UPDATE _migrations SET checksum = 'sha256:edited' WHERE id = ?")
      .run(known[0]?.id ?? "");
    db2.close();
    const edited = await migrate(home);
    expect(edited.code).toBe(1);
    expect(edited.json.database).toMatchObject({ modified: [known[0]?.id] });

    const checks = edited.json.checks as { id: string; status: string }[];
    expect(checks.find((c) => c.id === "backup")?.status).toBe("warn");
  });

  it("fails on a config.json this version rejects", async () => {
    const home = temp();
    writeFileSync(join(home, "config.json"), JSON.stringify({ gateway: { bind: "0.0.0.0" } }));
    const { code, json } = await migrate(home);
    expect(code).toBe(1);
    expect(json.configProblems).toEqual(["gateway.bind is not a known key"]);
  });
});

describe("release scripts", () => {
  it("migrations-manifest.mjs bakes in exactly what the CLI reads from source", () => {
    const literal = execFileSync(
      process.execPath,
      [join(ROOT, "deploy/scripts/migrations-manifest.mjs")],
      {
        encoding: "utf8",
      },
    );
    const baked = JSON.parse(JSON.parse(literal)) as unknown;
    expect(baked).toEqual(migrationsFromDir(join(ROOT, "packages/db/migrations")));
  });

  it("homebrew.mjs renders the cask and the formula from SHA256SUMS, and refuses a missing asset", () => {
    const dir = temp();
    const assets = [
      "Psyche-1.2.3-arm64.dmg",
      "Psyche-1.2.3-x64.dmg",
      "psyche-darwin-arm64",
      "psyche-darwin-x64",
      "psyche-linux-arm64",
      "psyche-linux-x64",
    ];
    const sums = assets.map((a, i) => `${String(i).repeat(64)}  ${a}`).join("\n");
    writeFileSync(join(dir, "SHA256SUMS"), `${sums}\n`);
    execFileSync(process.execPath, [
      join(ROOT, "deploy/scripts/homebrew.mjs"),
      "1.2.3",
      join(dir, "SHA256SUMS"),
      join(dir, "tap"),
    ]);
    const cask = readFileSync(join(dir, "tap/Casks/psyche.rb"), "utf8");
    const formula = readFileSync(join(dir, "tap/Formula/psyche-cli.rb"), "utf8");
    expect(cask).toContain('version "1.2.3"');
    expect(cask).toContain(`arm:   "${"0".repeat(64)}"`);
    expect(cask).toContain('depends_on macos: ">= :sequoia"');
    expect(cask).toContain('uninstall launchctl: "com.psyche.gateway"');
    expect(formula).toContain(`releases/download/v1.2.3/psyche-linux-x64`);
    expect(formula).toContain(`sha256 "${"5".repeat(64)}"`);
    expect(`${cask}${formula}`).not.toMatch(/\{\{/);

    writeFileSync(join(dir, "PARTIAL"), `${sums.split("\n").slice(0, 2).join("\n")}\n`);
    expect(() =>
      execFileSync(
        process.execPath,
        [
          join(ROOT, "deploy/scripts/homebrew.mjs"),
          "1.2.3",
          join(dir, "PARTIAL"),
          join(dir, "tap2"),
        ],
        {
          stdio: "pipe",
        },
      ),
    ).toThrow(/no entry for: psyche-darwin-arm64/);
  });

  it("make-dmg.sh is valid sh and refuses a bad version or arch", () => {
    const script = join(ROOT, "deploy/macos/make-dmg.sh");
    execFileSync("/bin/sh", ["-n", script]);
    expect(() =>
      execFileSync("/bin/sh", [script, "/nonexistent.app", "1.0;rm", "arm64", temp()], {
        stdio: "pipe",
      }),
    ).toThrow();
    expect(() =>
      execFileSync("/bin/sh", [script, "/nonexistent.app", "1.0.0", "ppc", temp()], {
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
