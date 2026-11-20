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
// crash leaves either release in place, never a half-written one. Only the current and previous
// releases are kept. `psyche update` (apps/cli/src/server-update.ts) unpacks a verified tarball
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

function writeUnits(releaseDir, root, unitDir) {
  mkdirSync(unitDir, { recursive: true });
  for (const [unit, text] of Object.entries(renderUnits(releaseDir, root))) {
    const file = join(unitDir, unit);
    if (existsSync(file) && !readFileSync(file, "utf8").startsWith(UNIT_MARKER)) {
      throw new Error(
        `${file} exists and was not written by the psyche-server installer (psyche start, or the desktop app?): move it away first`,
      );
    }
    const tmp = `${file}.new-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, file);
  }
}

function writeBinLinks(root, binDir) {
  mkdirSync(binDir, { recursive: true });
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
    swapLink(link, want);
  }
  return skipped;
}

/**
 * Makes `releases/<version>` current, keeps the one it replaces as `previous`, drops every other
 * release, and rewrites the units and the command links (they name `current/`, so the text
 * changes only when a release ships different units).
 */
export function activate({ root, version, unitDir, binDir }) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  const dir = join(root, "releases", version);
  const info = readInstallInfo(dir);
  if (info.version !== version || info.kind !== "tarball")
    throw new Error(`${dir} holds ${info.kind} ${info.version}, not the tarball of ${version}`);
  const before = status(root).current;
  if (before !== undefined && before !== version)
    swapLink(join(root, "previous"), join("releases", before));
  swapLink(join(root, "current"), join("releases", version));
  writeUnits(dir, root, unitDir);
  const skipped = writeBinLinks(root, binDir);
  const keep = new Set([version, status(root).previous].filter(Boolean));
  for (const name of readdirSync(join(root, "releases"))) {
    if (!keep.has(name)) rmSync(join(root, "releases", name), { recursive: true, force: true });
  }
  return { current: version, previous: status(root).previous, skipped };
}

/** Swaps `current` and `previous`. The data folder is not touched. */
export function rollback({ root, unitDir, binDir }) {
  const { current, previous } = status(root);
  if (previous === undefined || !existsSync(join(root, "releases", previous)))
    throw new Error("no previous release to go back to");
  if (current !== undefined) swapLink(join(root, "previous"), join("releases", current));
  swapLink(join(root, "current"), join("releases", previous));
  writeUnits(join(root, "releases", previous), root, unitDir);
  writeBinLinks(root, binDir);
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
  mkdirSync(join(root, "releases"), { recursive: true, mode: 0o755 });
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
