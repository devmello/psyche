// The psyche-server tarball's installer and its release layout (docs/design/linux-helper-only-2026.md
// §3.2, wave B1). It ships inside the tarball and runs on the tarball's own Node:
//
//   ./install.sh [--root <dir>] [--no-start] [--no-linger]   (install.sh runs `install.mjs install`)
//   <release>/psyched/runtime/node <release>/install.mjs activate <version> [--root <dir>]
//   <release>/psyched/runtime/node <release>/install.mjs rollback [--root <dir>]
//   <release>/psyched/runtime/node <release>/install.mjs status [--root <dir>]
//
// Layout, all under the owner's own account (nothing here needs root):
//   ~/.local/lib/psyche-server/releases/<version>/   one unpacked tarball each (psyched/, the
//                                                    helper, the units' templates, this script)
//   ~/.local/lib/psyche-server/current  -> releases/<version>   what runs
//   ~/.local/lib/psyche-server/previous -> releases/<version>   what a rollback goes back to
//   ~/.local/bin/psyche, psyched                    -> current/psyched/{psyche,psyched}
//   ~/.config/systemd/user/psyche-gateway.service, psyche-helper-headless.service
//                                                    point at current/, so a switch is one rename
//
// `current` and `previous` change by renaming a new symlink over the old one, which is atomic: a
// crash leaves either release in place, never a half-written one. They change last, after every
// check, and go back if writing the units or links fails. Only the current and previous releases
// are kept; only folders this installer made are ever removed (a release folder holding its
// tarball `psyche-server.json`, and its own `.incoming-*` / `*.old-*` leftovers), so anything
// else under a `--root` stays. The root carries a marker file (`ROOT_MARKER`), and `install`
// refuses a non-empty folder without it.
//
// Nothing here runs as root: a root Gateway would run the agent's tools as root, and a root
// `psyche update` would run code from a tree the account can write. `psyche update` (apps/cli/src/server-update.ts) unpacks a verified tarball
// into releases/, then runs the NEW release's `activate`; a failed start runs `rollback`.
//
// The data folder (~/.psyche) is never touched here: it is not part of a release.
//
// A packaged psyche-server (deb or rpm) or the desktop package on the same computer would run a
// second Gateway on the same ~/.psyche, so `install` refuses when either is installed.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INSTALL_FILE = "psyche-server.json";
export const UNIT_TEMPLATES = "units";
/** Replaced, already escaped for a quoted systemd value, by the release root at install. */
export const ROOT_PLACEHOLDER = "@PSYCHE_SERVER_ROOT@";
/** The first line of every unit this installer writes; any other file there is not ours. */
export const UNIT_MARKER =
  "# psyche-server (tarball install): written by its installer and by psyche update.";
export const UNITS = ["psyche-gateway.service", "psyche-helper-headless.service"];
/** Paths whose presence means another install would share ~/.psyche. */
export const CONFLICTS = [
  { path: "/usr/lib/psyche-server", what: "the psyche-server deb or rpm package" },
  { path: "/usr/lib/psyche", what: "the Psyche desktop package" },
];
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** In the install root: this installer made the folder, so it may manage `releases/` there. */
export const ROOT_MARKER = ".psyche-server-root";
const VERSION_SRC = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
/** `install`'s and `psyche update`'s staging folders, and `install`'s replaced copy. */
const LEFTOVER = new RegExp(`^(?:\\.incoming-${VERSION_SRC}-(\\d+)|${VERSION_SRC}\\.old-(\\d+))$`);

/** Throws when run as root (uid 0): psyche-server runs under the owner's own account. */
export function refuseRoot(uid = typeof process.getuid === "function" ? process.getuid() : -1) {
  if (uid === 0) {
    throw new Error(
      "do not run this as root (sudo): psyche-server installs and updates under the account Psyche runs for, and a root Gateway would run the agent's tools as root. Run it again as that user.",
    );
  }
}

/** Where things go for this account, from the XDG variables (their defaults otherwise). */
export function defaultLayout(env = process.env, home = homedir()) {
  const xdg = (name, fallback) =>
    env[name] !== undefined && env[name] !== "" && env[name].startsWith("/") ? env[name] : fallback;
  return {
    root: join(home, ".local", "lib", "psyche-server"),
    binDir: join(home, ".local", "bin"),
    unitDir: join(xdg("XDG_CONFIG_HOME", join(home, ".config")), "systemd", "user"),
  };
}

/**
 * A path inside a double-quoted systemd value in ExecStart: backslash and quote escaped, `%`
 * doubled (specifiers), `$` doubled (variables), as apps/cli/src/systemd-unit.ts `sdQuote` does.
 * Control characters cannot be written into a unit at all.
 */
export function sdEscape(path) {
  if ([...path].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    throw new Error(`cannot use ${JSON.stringify(path)} in a unit`);
  return path
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, "$$$$");
}

/** The release's metadata (`psyche-server.json`): `{ format, kind, version, arch }`. */
export function readInstallInfo(dir) {
  const info = JSON.parse(readFileSync(join(dir, INSTALL_FILE), "utf8"));
  if (
    info?.format !== "psyche-server-install" ||
    typeof info.version !== "string" ||
    !VERSION.test(info.version) ||
    !["arm64", "x64"].includes(info.arch) ||
    !["deb", "rpm", "tarball"].includes(info.kind)
  ) {
    throw new Error(`${join(dir, INSTALL_FILE)} is not a psyche-server release description`);
  }
  return info;
}

/** The units for a release root, from the templates inside a release. */
export function renderUnits(releaseDir, root) {
  const out = {};
  for (const unit of UNITS) {
    const template = readFileSync(join(releaseDir, UNIT_TEMPLATES, `${unit}.in`), "utf8");
    if (!template.includes(ROOT_PLACEHOLDER)) throw new Error(`${unit}.in names no release root`);
    out[unit] = `${UNIT_MARKER}\n${template.split(ROOT_PLACEHOLDER).join(sdEscape(root))}`;
  }
  return out;
}

const linkTarget = (path) => {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
};

/** Points `link` at `target` by renaming a new symlink over it (atomic on one filesystem). */
function swapLink(link, target) {
  const tmp = `${link}.new-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

/** `{ current, previous, releases }`: versions, or undefined. */
export function status(root) {
  const version = (link) => {
    const t = linkTarget(join(root, link));
    return t === undefined ? undefined : basename(t);
  };
  const dir = join(root, "releases");
  return {
    current: version("current"),
    previous: version("previous"),
    releases: existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => VERSION.test(n))
          .sort()
      : [],
  };
}

/** The units to write for a release, after checking that none would replace a unit not ours. */
function planUnits(releaseDir, root, unitDir) {
  const out = [];
  for (const [unit, text] of Object.entries(renderUnits(releaseDir, root))) {
    const file = join(unitDir, unit);
    if (existsSync(file) && !readFileSync(file, "utf8").startsWith(UNIT_MARKER)) {
      throw new Error(
        `${file} exists and was not written by the psyche-server installer (psyche start, or the desktop app?): move it away first`,
      );
    }
    out.push([file, text]);
  }
  return out;
}

function writeUnits(planned, unitDir) {
  mkdirSync(unitDir, { recursive: true });
  for (const [file, text] of planned) {
    const tmp = `${file}.new-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, file);
  }
}

/** The command links to set, and the ones left alone because they are not ours. */
function planBinLinks(root, binDir) {
  const set = [];
  const skipped = [];
  for (const name of ["psyche", "psyched"]) {
    const link = join(binDir, name);
    const want = join(root, "current", "psyched", name);
    const now = linkTarget(link);
    if (existsSync(link) || now !== undefined) {
      // Never over a file or link that is not ours (a checkout's `psyche`, another install).
      if (now === undefined || !now.startsWith(`${root}/`)) {
        skipped.push(link);
        continue;
      }
    }
    set.push([link, want]);
  }
  return { set, skipped };
}

function writeBinLinks(planned, binDir) {
  mkdirSync(binDir, { recursive: true });
  for (const [link, want] of planned.set) swapLink(link, want);
}

/**
 * Points `current` (and `previous`) at their new releases, then writes the units and the command
 * links; if that fails, both links go back to what they were. Everything that can refuse has been
 * checked by then.
 */
function switchTo(root, links, planned, unitDir, binDir) {
  const was = {};
  for (const name of Object.keys(links)) was[name] = linkTarget(join(root, name));
  try {
    for (const [name, target] of Object.entries(links)) swapLink(join(root, name), target);
    writeUnits(planned.units, unitDir);
    writeBinLinks(planned.bin, binDir);
  } catch (err) {
    for (const [name, target] of Object.entries(was)) {
      try {
        if (target === undefined) rmSync(join(root, name), { force: true });
        else swapLink(join(root, name), target);
      } catch {
        // The error below is what the caller acts on.
      }
    }
    throw err;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** True for a folder `activate` may delete: a tarball release of that version, or a leftover. */
function ownReleaseEntry(dir, name) {
  try {
    if (!lstatSync(join(dir, name)).isDirectory()) return false;
    const left = LEFTOVER.exec(name);
    if (left) {
      const pid = Number(left[1] ?? left[2]);
      // Another install or update that is still running keeps its staging folder.
      return pid === process.pid || !pidAlive(pid);
    }
    if (!VERSION.test(name)) return false;
    const info = readInstallInfo(join(dir, name));
    return info.kind === "tarball" && info.version === name;
  } catch {
    return false;
  }
}

/** Throws unless `root` was made by this installer (its marker is there). */
function assertOwnRoot(root) {
  if (!existsSync(join(root, ROOT_MARKER)))
    throw new Error(
      `${root} is not a psyche-server install folder (no ${ROOT_MARKER}): refused, nothing changed`,
    );
}

/**
 * Makes `releases/<version>` current, keeps the one it replaces as `previous`, drops every other
 * release, and rewrites the units and the command links (they name `current/`, so the text
 * changes only when a release ships different units).
 */
export function activate({ root, version, unitDir, binDir }) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  assertOwnRoot(root);
  const dir = join(root, "releases", version);
  const info = readInstallInfo(dir);
  if (info.version !== version || info.kind !== "tarball")
    throw new Error(`${dir} holds ${info.kind} ${info.version}, not the tarball of ${version}`);
  const planned = { units: planUnits(dir, root, unitDir), bin: planBinLinks(root, binDir) };
  const before = status(root).current;
  const links = {};
  if (before !== undefined && before !== version) links.previous = join("releases", before);
  links.current = join("releases", version);
  switchTo(root, links, planned, unitDir, binDir);
  const keep = new Set([version, status(root).previous].filter(Boolean));
  const releases = join(root, "releases");
  for (const name of readdirSync(releases)) {
    if (!keep.has(name) && ownReleaseEntry(releases, name))
      rmSync(join(releases, name), { recursive: true, force: true });
  }
  return { current: version, previous: status(root).previous, skipped: planned.bin.skipped };
}

/** Swaps `current` and `previous`. The data folder is not touched. */
export function rollback({ root, unitDir, binDir }) {
  assertOwnRoot(root);
  const { current, previous } = status(root);
  if (previous === undefined || !existsSync(join(root, "releases", previous)))
    throw new Error("no previous release to go back to");
  const dir = join(root, "releases", previous);
  const planned = { units: planUnits(dir, root, unitDir), bin: planBinLinks(root, binDir) };
  const links = {};
  if (current !== undefined) links.previous = join("releases", current);
  links.current = join("releases", previous);
  switchTo(root, links, planned, unitDir, binDir);
  return { current: previous, previous: current };
}

/** The installs this one must not share ~/.psyche with. */
export function conflicts(exists = existsSync) {
  return CONFLICTS.filter((c) => exists(c.path));
}

const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }).status === 0;
const quiet = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

/** First install from an unpacked tarball (`from`, the folder this script is in). */
export function install({ from, root, unitDir, binDir, exists = existsSync }) {
  const found = conflicts(exists);
  if (found.length > 0) {
    throw new Error(
      `${found.map((c) => `${c.what} is installed (${c.path})`).join("; ")}. Two Psyche Gateways cannot share ~/.psyche: remove it first, or keep using it instead of this tarball.`,
    );
  }
  const info = readInstallInfo(from);
  if (info.kind !== "tarball")
    throw new Error(`${from} is a ${info.kind} release, not the tarball`);
  // Only into a new or empty folder, or one this installer made: activate manages releases/.
  if (existsSync(root) && !existsSync(join(root, ROOT_MARKER))) {
    if (!lstatSync(root).isDirectory() || readdirSync(root).length > 0)
      throw new Error(
        `${root} already holds other files and is not a psyche-server install folder: choose a new or empty folder with --root (the default is ~/.local/lib/psyche-server)`,
      );
  }
  mkdirSync(join(root, "releases"), { recursive: true, mode: 0o755 });
  writeFileSync(
    join(root, ROOT_MARKER),
    "psyche-server tarball install (deploy/linux-server/install.mjs). Do not put other files in releases/.\n",
    { mode: 0o644 },
  );
  const dest = join(root, "releases", info.version);
  if (resolve(from) !== resolve(dest)) {
    const incoming = join(root, "releases", `.incoming-${info.version}-${process.pid}`);
    rmSync(incoming, { recursive: true, force: true });
    cpSync(from, incoming, { recursive: true, verbatimSymlinks: true });
    // A reinstall of the version that runs: the old copy goes once the new one is complete.
    if (existsSync(dest)) {
      const old = `${dest}.old-${process.pid}`;
      renameSync(dest, old);
      renameSync(incoming, dest);
      rmSync(old, { recursive: true, force: true });
    } else {
      renameSync(incoming, dest);
    }
  }
  return activate({ root, version: info.version, unitDir, binDir });
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(argv) {
  refuseRoot();
  const [cmd, ...rest] = argv;
  const layout = defaultLayout();
  const root = resolve(option(rest, "--root") ?? layout.root);
  const opts = { root, unitDir: layout.unitDir, binDir: layout.binDir };
  if (cmd === "status") {
    process.stdout.write(`${JSON.stringify(status(root))}\n`);
    return 0;
  }
  if (cmd === "activate") {
    const version = rest.find((a) => !a.startsWith("--") && a !== option(rest, "--root"));
    process.stdout.write(`${JSON.stringify(activate({ ...opts, version }))}\n`);
    return 0;
  }
  if (cmd === "rollback") {
    process.stdout.write(`${JSON.stringify(rollback(opts))}\n`);
    return 0;
  }
  if (cmd !== "install") {
    process.stderr.write(
      "usage: install.mjs install|activate <version>|rollback|status [--root <dir>]\n",
    );
    return 2;
  }
  const from = dirname(fileURLToPath(import.meta.url));
  const done = install({ ...opts, from });
  const say = (line) => process.stdout.write(`psyche-server: ${line}\n`);
  say(`installed ${done.current} in ${root}`);
  for (const s of done.skipped)
    say(`left ${s} alone (not ours); the commands are in ${join(root, "current", "psyched")}`);
  if (!(process.env.PATH ?? "").split(":").includes(layout.binDir))
    say(`add ${layout.binDir} to your PATH to run psyche and psyched`);
  // Linger (design §3.3): the user manager starts at boot, so Psyche runs with nobody logged in.
  // The one step that may need an administrator; say why when it does not work.
  if (!rest.includes("--no-linger")) {
    const user = process.env.USER ?? quiet("id", ["-un"]).stdout.trim();
    const linger = quiet("loginctl", ["show-user", user, "-p", "Linger", "--value"]).stdout.trim();
    if (linger === "yes") say(`linger is already on for ${user}`);
    else if (run("loginctl", ["enable-linger", user]))
      say(`turned on linger for ${user}, so Psyche keeps running while nobody is logged in`);
    else
      say(
        `could not turn on linger. So Psyche keeps running while nobody is logged in, run: sudo loginctl enable-linger ${user}`,
      );
  }
  if (!run("systemctl", ["--user", "daemon-reload"])) {
    say("systemctl --user is not available; start psyched yourself, or use Docker Compose");
    return 0;
  }
  if (rest.includes("--no-start")) {
    say("start it with: systemctl --user enable --now psyche-gateway.service");
    return 0;
  }
  if (!run("systemctl", ["--user", "enable", "--now", "psyche-gateway.service"])) return 1;
  say("the Gateway is running: psyche status; pair this computer's CLI with psyche onboard");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`psyche-server: ${err.message}\n`);
      process.exit(1);
    },
  );
}
