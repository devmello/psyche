// Upgrade and backup round trip on fresh $PSYCHE_HOMEs (roadmap M3 release hardening; docs/guides/
// upgrade.md). Exercises what an owner does around an upgrade, with real processes:
//
//   1. `psyche migrate --check` on a fresh home: a new install, nothing blocks
//   2. start psyched, pair the CLI (`psyched devices approve`), write a setting and a workspace file
//   3. `psyche backup create` through the running Gateway (online, no downtime)
//   4. `psyche migrate --check` against the live data: up to date
//   5. stop psyched; `psyche backup verify` and `restore` into a second fresh home
//   6. `psyche migrate --check` on the restored home: up to date, no blockers
//   7. a second psyched boots from the restored home and the setting and file are there
//   8. a newer build whose migration fails: it snapshots the data into backups/pre-update first,
//      puts it back, refuses to start with a plain message, and leaves the data as it was
//   9. the same build is not tried again on every restart (no second snapshot)
//  10. the next build (the real migrations) starts on that data and clears the failure
//
// Usage: node deploy/scripts/upgrade-roundtrip.mjs
//   PSYCHE   the CLI to test (default: node apps/cli/src/main.ts; a release binary works)
//   PSYCHED  the Gateway to test (default: node apps/gateway/src/main.ts)
// Exit 0 when every step passes; prints one line per step. Never touches ~/.psyche.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const PASS = "upgrade round trip passphrase";
const cmd = (env, fallback) =>
  process.env[env] ? [process.env[env]] : [process.execPath, join(ROOT, fallback)];
const PSYCHE = cmd("PSYCHE", "apps/cli/src/main.ts");
const PSYCHED = cmd("PSYCHED", "apps/gateway/src/main.ts");

const dirs = [];
const procs = [];
function freshHome() {
  // macOS caps Unix socket paths at 104 bytes; keep $PSYCHE_HOME short.
  const d = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "psy-up-"));
  dirs.push(d);
  return join(d, "home");
}
function cleanup() {
  for (const p of procs.splice(0)) p.kill("SIGTERM");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

let step = 0;
function ok(what) {
  step++;
  process.stdout.write(`ok   ${step}. ${what}\n`);
}
function fail(what, detail) {
  process.stdout.write(
    `FAIL ${step + 1}. ${what}\n${detail ? `     ${String(detail).split("\n").join("\n     ")}\n` : ""}`,
  );
  cleanup();
  process.exit(1);
}

function psyche(home, url, args, env = {}) {
  const [bin, ...pre] = PSYCHE;
  const r = spawnSync(bin, [...pre, ...args, "--url", url, "--json"], {
    env: { ...process.env, HOME: home, PSYCHE_HOME: home, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

function startPsyched(home, extraEnv = {}) {
  const [bin, ...pre] = PSYCHED;
  const child = spawn(bin, pre, {
    env: {
      ...process.env,
      PSYCHE_HOME: home,
      PSYCHE_PORT: "0",
      PSYCHE_BROWSER: "off",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  procs.push(child);
  return new Promise((resolveOrigin, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`psyched did not start:\n${buf}`)), 30_000);
    child.stderr.on("data", (d) => {
      buf += String(d);
      const m = /"msg":"gateway listening","origin":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolveOrigin({ url: m[1], child });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`psyched exited ${code}:\n${buf}`));
    });
  });
}

function stop(child) {
  return new Promise((r) => {
    child.once("exit", () => r());
    child.kill("SIGTERM");
  });
}

/** Runs psyched expecting it to refuse to start; resolves with its exit code and stderr. */
function psychedRefuses(home, extraEnv) {
  const [bin, ...pre] = PSYCHED;
  return new Promise((resolveExit, reject) => {
    const child = spawn(bin, pre, {
      env: {
        ...process.env,
        PSYCHE_HOME: home,
        PSYCHE_PORT: "0",
        PSYCHE_BROWSER: "off",
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    procs.push(child);
    let buf = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`psyched neither started nor refused within 30 s:\n${buf}`));
    }, 30_000);
    child.stderr.on("data", (d) => {
      buf += String(d);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveExit({ code, stderr: buf });
    });
  });
}

/**
 * An assets root that is the repository's, except that `packages/db/migrations` also holds two
 * pending migrations: one that applies and one that fails halfway (PSYCHE_ASSETS_ROOT).
 */
function assetsWithFailingMigration() {
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "psy-ast-"));
  dirs.push(root);
  const skip = new Set([".git", "node_modules"]);
  for (const name of readdirSync(ROOT)) {
    if (name !== "packages" && !skip.has(name)) symlinkSync(join(ROOT, name), join(root, name));
  }
  mkdirSync(join(root, "packages", "db"), { recursive: true });
  for (const name of readdirSync(join(ROOT, "packages"))) {
    if (name !== "db") symlinkSync(join(ROOT, "packages", name), join(root, "packages", name));
  }
  for (const name of readdirSync(join(ROOT, "packages", "db"))) {
    if (name !== "migrations" && name !== "node_modules")
      symlinkSync(join(ROOT, "packages", "db", name), join(root, "packages", "db", name));
  }
  const migrations = join(root, "packages", "db", "migrations");
  cpSync(join(ROOT, "packages", "db", "migrations"), migrations, { recursive: true });
  writeFileSync(
    join(migrations, "299912310000_roundtrip_applies.sql"),
    "CREATE TABLE roundtrip_applied_first (id INTEGER);\n",
  );
  writeFileSync(
    join(migrations, "299912310100_roundtrip_fails.sql"),
    "CREATE TABLE roundtrip_half_done (id INTEGER);\nSELECT * FROM roundtrip_no_such_table;\n",
  );
  return root;
}

const offline = "http://127.0.0.1:9"; // nothing listens: commands that need no Gateway

// 1. fresh home
const home = freshHome();
let r = psyche(home, offline, ["migrate", "--check"]);
if (r.code !== 0 || r.json?.ok !== true || r.json?.database?.exists !== false)
  fail("migrate --check on a fresh home", r.stdout || r.stderr);
ok("migrate --check on a fresh home: new install, no blockers");

// 2. Gateway, pairing, data
let gw;
try {
  gw = await startPsyched(home);
} catch (err) {
  fail("start psyched", err.message);
}
r = psyche(home, gw.url, ["devices", "list"]);
const code = r.json?.error?.details?.code;
if (r.code !== 3 || !code) fail("first contact gives a pairing code", r.stdout || r.stderr);
const [dbin, ...dpre] = PSYCHED;
const approve = spawnSync(dbin, [...dpre, "devices", "approve", code], {
  env: { ...process.env, PSYCHE_HOME: home },
  encoding: "utf8",
});
if (approve.status !== 0) fail("psyched devices approve", approve.stderr);
r = psyche(home, gw.url, ["config", "set", "appearance.theme", "dark"]);
if (r.code !== 0) fail("config set through the Gateway", r.stdout || r.stderr);
mkdirSync(join(home, "workspace"), { recursive: true });
writeFileSync(join(home, "workspace", "MEMORY.md"), "# Memory\n- round trip marker\n");
ok("psyched started, CLI paired, setting and workspace file written");

// 3. online backup
r = psyche(home, gw.url, ["backup", "create"], { PSYCHE_BACKUP_PASSPHRASE: PASS });
if (r.code !== 0 || r.json?.via !== "gateway" || !r.json?.file)
  fail("backup create through the running Gateway", r.stdout || r.stderr);
const archive = r.json.file;
if ((await fetch(`${gw.url}/healthz`)).ok !== true) fail("Gateway still serving after the backup");
ok(`online backup ${archive.split("/").at(-1)}; the Gateway kept serving`);

// 4. migrate --check on live data
r = psyche(home, gw.url, ["migrate", "--check"]);
if (
  r.code !== 0 ||
  r.json?.database?.pending?.length !== 0 ||
  r.json?.database?.unknown?.length !== 0
)
  fail("migrate --check on the live data", r.stdout || r.stderr);
ok(`migrate --check on the live data: up to date (${r.json.database.applied} migrations)`);

// 5. restore into a second fresh home
await stop(gw.child);
const target = freshHome();
r = psyche(target, offline, ["backup", "verify", archive], { PSYCHE_BACKUP_PASSPHRASE: PASS });
if (r.code !== 0 || r.json?.ok !== true) fail("backup verify", r.stdout || r.stderr);
r = psyche(target, offline, ["backup", "restore", archive], { PSYCHE_BACKUP_PASSPHRASE: PASS });
if (r.code !== 0) fail("backup restore into a fresh home", r.stdout || r.stderr);
ok("backup verified and restored into a second fresh home");

// 6. migrate --check on the restored home
r = psyche(target, offline, ["migrate", "--check"]);
if (r.code !== 0 || r.json?.ok !== true || r.json?.database?.pending?.length !== 0)
  fail("migrate --check on the restored home", r.stdout || r.stderr);
ok("migrate --check on the restored home: up to date, no blockers");

// 7. a Gateway boots from it, with the data
let gw2;
try {
  gw2 = await startPsyched(target);
} catch (err) {
  fail("psyched boots from the restored home", err.message);
}
if ((await fetch(`${gw2.url}/healthz`)).ok !== true) fail("restored Gateway healthy");
await stop(gw2.child);
const db = new DatabaseSync(join(target, "state", "psyche.sqlite"), { readOnly: true });
const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("appearance.theme");
db.close();
if (!String(row?.value).includes("dark")) fail("restored setting", JSON.stringify(row));
if (!readFileSync(join(target, "workspace", "MEMORY.md"), "utf8").includes("round trip marker"))
  fail("restored workspace file");
ok("restored Gateway healthy; setting and workspace file intact");

// 8. a newer build whose migration fails
const tables = () => {
  const d = new DatabaseSync(join(target, "state", "psyche.sqlite"), { readOnly: true });
  const names = d
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  const applied = d.prepare("SELECT count(*) AS n FROM _migrations").get().n;
  d.close();
  return { names, applied };
};
const before = tables();
const snapshotsDir = join(target, "backups", "pre-update");
const snapshotNames = () =>
  existsSync(snapshotsDir) ? readdirSync(snapshotsDir).filter((n) => !n.startsWith(".")) : [];
const failing = { PSYCHE_ASSETS_ROOT: assetsWithFailingMigration(), PSYCHE_BUILD: "roundtrip-a" };
let refused = await psychedRefuses(target, failing).catch((err) =>
  fail("a build with a failing migration", err.message),
);
if (refused.code === 0 || !refused.stderr.includes("put everything back the way it was"))
  fail("a failing migration makes psyched refuse with a plain message", refused.stderr);
const snaps = snapshotNames();
if (snaps.length !== 1) fail("one pre-update snapshot was made", JSON.stringify(snaps));
const manifest = JSON.parse(readFileSync(join(snapshotsDir, snaps[0], "manifest.json"), "utf8"));
if (!manifest.entries.some((e) => e.rel === "state/psyche.sqlite" && e.kind === "sqlite"))
  fail("the snapshot holds the main database", JSON.stringify(manifest.entries));
const after = tables();
if (JSON.stringify(after) !== JSON.stringify(before))
  fail(
    "the data is exactly as it was after the failed migration",
    JSON.stringify({ before, after }),
  );
if (!existsSync(join(target, "run", "update-failed.json"))) fail("the failure is recorded");
ok(
  `failing migration: snapshot ${snaps[0]} made, data restored (${after.applied} migrations, no half-applied tables), psyched refused to start`,
);

// 9. the same build is not tried again
refused = await psychedRefuses(target, failing).catch((err) =>
  fail("the same failing build again", err.message),
);
if (refused.code === 0 || snapshotNames().length !== 1)
  fail("the same build refuses without making another snapshot", JSON.stringify(snapshotNames()));
ok("the same build refuses again without making another snapshot");

// 10. the next build starts on the restored data
let gw3;
try {
  gw3 = await startPsyched(target, { PSYCHE_BUILD: "roundtrip-b" });
} catch (err) {
  fail("the next build starts on the restored data", err.message);
}
if ((await fetch(`${gw3.url}/healthz`)).ok !== true) fail("the next build is healthy");
await stop(gw3.child);
if (existsSync(join(target, "run", "update-failed.json")))
  fail("a start clears the failure record");
if (JSON.stringify(tables()) !== JSON.stringify(before)) fail("data unchanged by the next build");
ok("the next build started on the same data and cleared the failure record");

cleanup();
process.stdout.write("upgrade round trip: all steps passed\n");
