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
//
// Usage: node deploy/scripts/upgrade-roundtrip.mjs
//   PSYCHE   the CLI to test (default: node apps/cli/src/main.ts; a release binary works)
//   PSYCHED  the Gateway to test (default: node apps/gateway/src/main.ts)
// Exit 0 when every step passes; prints one line per step. Never touches ~/.psyche.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function startPsyched(home) {
  const [bin, ...pre] = PSYCHED;
  const child = spawn(bin, pre, {
    env: { ...process.env, PSYCHE_HOME: home, PSYCHE_PORT: "0", PSYCHE_BROWSER: "off" },
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

cleanup();
process.stdout.write("upgrade round trip: all steps passed\n");
