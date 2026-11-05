// The Windows pieces of the psyched bundle (build-psyched.mjs on a win32 host; deploy/windows/).
//
// What differs from the macOS bundle:
//   runtime\node.exe          the official node-v<ver>-win-x64.zip's node.exe, SHA-256 checked
//                             against nodejs.org's SHASUMS256.txt, cached in %LOCALAPPDATA%
//   psyched.cmd, psyche.cmd   cmd launchers (no PATH needed), the same flags as the sh ones
//   psyche-gateway.task.xml.template
//                             the Task Scheduler task (\Psyche\Gateway-<SID>) with
//                             {{PSYCHED_DIR}}, {{PSYCHE_HOME}}, {{USER_ID}} and {{TASK_NAME}},
//                             rendered like the LaunchAgent plist
//   app\node_modules          a flat (hoisted) copy of the external packages: no links at all.
//                             Squirrel's nupkg (a zip) keeps neither symlinks nor junctions, and
//                             the pnpm store's nesting pushes paths under %LOCALAPPDATA%\Psyche\
//                             app-<version>\resources past MAX_PATH for nuget.exe.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { depNames } from "./pnpm-store.mjs";

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Windows' own bsdtar (System32) reads zip archives; Git Bash's GNU tar does not. */
export function systemTar(env = process.env) {
  return join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "tar.exe");
}

/** `%LOCALAPPDATA%\psyche-build\node` (XDG_CACHE_HOME wins when set, like on macOS). */
export function runtimeCacheDir(env = process.env) {
  const base =
    env.XDG_CACHE_HOME ??
    env.LOCALAPPDATA ??
    join(env.USERPROFILE ?? homedir(), "AppData", "Local");
  return join(base, "psyche-build", "node");
}

/** The SHA-256 nodejs.org publishes for `name`, from SHASUMS256.txt's text. */
export function expectedSha(sums, name) {
  const re = new RegExp(`^([0-9a-f]{64})\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
  return re.exec(sums)?.[1];
}

/**
 * node-v<ver>-win-<arch>\node.exe, downloaded once into the cache and checked against
 * SHASUMS256.txt every time it is used (a cached file that no longer matches is fetched again).
 */
export async function nodeRuntimeWin32(
  version,
  arch,
  { fetchImpl = fetch, env = process.env } = {},
) {
  const cache = runtimeCacheDir(env);
  mkdirSync(cache, { recursive: true });
  const stem = `node-v${version}-win-${arch}`;
  const name = `${stem}.zip`;
  const zip = join(cache, name);
  const base = `https://nodejs.org/dist/v${version}/`;
  const sumsRes = await fetchImpl(`${base}SHASUMS256.txt`);
  if (!sumsRes.ok) throw new Error(`GET SHASUMS256.txt: ${sumsRes.status}`);
  const expected = expectedSha(await sumsRes.text(), name);
  if (!expected) throw new Error(`SHASUMS256.txt has no ${name}`);
  if (!existsSync(zip) || sha256(zip) !== expected) {
    const res = await fetchImpl(`${base}${name}`);
    if (!res.ok) throw new Error(`GET ${name}: ${res.status}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  if (sha256(zip) !== expected) throw new Error(`${name}: SHA-256 does not match nodejs.org`);
  const dir = mkdtempSync(join(tmpdir(), "psyche-node-"));
  execFileSync(systemTar(env), ["-xf", zip, "-C", dir, `${stem}/node.exe`], { stdio: "inherit" });
  return {
    node: join(dir, stem, "node.exe"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** IMAGE_FILE_HEADER.Machine of a PE file (`.exe`, `.dll`, `.node`), or null when it is not one. */
export function peMachine(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const dos = Buffer.alloc(64);
    if (readSync(fd, dos, 0, 64, 0) !== 64 || dos.toString("latin1", 0, 2) !== "MZ") return null;
    const off = dos.readUInt32LE(0x3c);
    const nt = Buffer.alloc(6);
    if (readSync(fd, nt, 0, 6, off) !== 6 || nt.toString("latin1", 0, 4) !== "PE\0\0") return null;
    return nt.readUInt16LE(4);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c };

/** Every `.node` addon under `appDir` that is not a PE image for `arch`. */
export function checkAddonsWin32(appDir, arch) {
  const want = PE_MACHINE[arch];
  const bad = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".node")) {
        const m = peMachine(p);
        if (m !== want)
          bad.push(
            `${relative(appDir, p)}: ${m === null ? "not a PE image" : `machine 0x${m.toString(16)}`}`,
          );
      }
    }
  };
  walk(appDir);
  return bad;
}

/**
 * Turns the pnpm layout discardSources leaves (`node_modules/<name>` links into `.pnpm`) into a
 * flat tree of real directories, the way npm hoists: each package lands at the top unless a
 * different copy of the same name is already there, then under its dependent's own node_modules.
 * Node resolves the same files (it walks up from the real path either way). `.pnpm` goes.
 * Returns the packages placed.
 */
export function hoistPnpmLayout(appDir) {
  const nm = join(appDir, "node_modules");
  const pnpm = join(nm, ".pnpm");
  /** target dir → real source dir, for everything placed or queued. */
  const at = new Map();
  const queue = [];
  const reserve = (name, real, dest) => {
    at.set(dest, real);
    queue.push({ name, real, dest });
  };
  for (const name of depNames(nm)) reserve(name, realpathSync(join(nm, name)), join(nm, name));

  /** The real dir a `require(name)` from inside `from` would reach among placed packages. */
  const resolvedFrom = (from, name) => {
    let dir = from;
    for (;;) {
      const candidate = join(dir, "node_modules", name);
      if (at.has(candidate)) return { dest: candidate, real: at.get(candidate) };
      if (dir === appDir || dirname(dir) === dir) return null;
      dir = dirname(dir);
      // Skip the `node_modules` and `@scope` levels: only package dirs and the app dir hold one.
      while (dir !== appDir && (dir.endsWith(`${sep}node_modules`) || /[\\/]@[^\\/]+$/.test(dir)))
        dir = dirname(dir);
    }
  };

  let placed = 0;
  const staged = join(appDir, ".hoist-staging");
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged);
  // Copy every source out first: placing a package at the top replaces the link the next one
  // may still be read through.
  const sources = new Map();
  while (queue.length) {
    const { name, real, dest } = queue.shift();
    if (!sources.has(real)) {
      const copy = join(staged, String(sources.size));
      cpSync(real, copy, { recursive: true, dereference: true });
      sources.set(real, copy);
    }
    placed++;
    // pnpm puts a package's dependencies next to it: .pnpm/<id>/node_modules/{<name>,<deps>…}.
    const siblings = name.includes("/") ? dirname(dirname(real)) : dirname(real);
    if (!siblings.startsWith(pnpm)) continue;
    for (const dep of depNames(siblings)) {
      if (dep === name) continue;
      let depReal;
      try {
        depReal = realpathSync(join(siblings, dep));
      } catch {
        continue;
      }
      const found = resolvedFrom(dest, dep);
      if (found?.real === depReal) continue;
      reserve(dep, depReal, found ? join(dest, "node_modules", dep) : join(nm, dep));
    }
  }
  // Now swap: drop the links and the store, move the copies into place (parents first).
  for (const name of readdirSync(nm)) {
    if (name === ".hoist-staging") continue;
    rmSync(join(nm, name), { recursive: true, force: true });
  }
  const order = [...at.keys()].sort((a, b) => a.length - b.length);
  for (const dest of order) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(sources.get(at.get(dest)), dest, { recursive: true });
  }
  rmSync(staged, { recursive: true, force: true });
  return placed;
}

/** Fails when any symlink or junction is left in the tree (they do not survive the nupkg). */
export function findLinks(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) out.push(p);
    else if (st.isDirectory()) findLinks(p, out);
  }
  return out;
}

/** The longest path in the tree, relative to `dir` (for the MAX_PATH budget of the installer). */
export function longestPath(dir) {
  let best = "";
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const r = relative(dir, p);
      if (r.length > best.length) best = r;
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(dir);
  return best;
}

// Node's compile cache (V8 code) lives in the per-user cache, outside the install folder that
// Squirrel replaces on every update.
const WIN_COMPILE_CACHE =
  'if not defined NODE_COMPILE_CACHE if defined LOCALAPPDATA set "NODE_COMPILE_CACHE=%LOCALAPPDATA%\\com.psyche.gateway\\node-compile-cache"';

/** cmd launchers; `%~dp0` is the folder of the .cmd file, with a trailing backslash. */
export const PSYCHED_CMD = [
  "@echo off",
  "rem Psyche Gateway (psyched) from the Psyche install. Needs only PSYCHE_HOME; no Node, PATH or checkout.",
  "rem A 4 MB young generation keeps an idle Gateway near 200 MB instead of about 330 MB.",
  "setlocal",
  WIN_COMPILE_CACHE,
  '"%~dp0runtime\\node.exe" --max-semi-space-size=4 --disable-warning=ExperimentalWarning "%~dp0app\\apps\\gateway\\dist\\main.mjs" %*',
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

export const PSYCHE_CMD = [
  "@echo off",
  "rem The psyche CLI from the Psyche install, on the same runtime as psyched.",
  "setlocal",
  WIN_COMPILE_CACHE,
  '"%~dp0runtime\\node.exe" --disable-warning=ExperimentalWarning "%~dp0app\\apps\\cli\\dist\\main.mjs" %*',
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

/** The arguments psyched.cmd passes to node.exe, for callers that start node.exe directly. */
export function psychedNodeArgs(bundle) {
  return [
    "--max-semi-space-size=4",
    "--disable-warning=ExperimentalWarning",
    join(bundle, "app", "apps", "gateway", "dist", "main.mjs"),
  ];
}

/** The minimal environment Node needs on Windows (no SystemRoot: no crypto, no DNS). */
export function minimalWinEnv(extra, env = process.env) {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return {
    SystemRoot: root,
    windir: root,
    PATH: `${root}\\System32;${root}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ...(env.TEMP ? { TEMP: env.TEMP, TMP: env.TEMP } : {}),
    ...extra,
  };
}
