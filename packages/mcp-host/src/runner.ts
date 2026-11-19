/**
 * Package runners (`npx`, `uvx`…) fetch and resolve their package each time they start. A server
 * started through one with a version range or a tag (`pkg`, `pkg@latest`, `pkg@^1`) can come back
 * as a newly published version on any restart, so the host never stops such a server for being
 * idle and never restarts it by itself: it then re-resolves only when the owner (re)adds it or the
 * Gateway restarts, as before idle stops existed. Pinned to an exact version (`pkg@1.2.3`,
 * `pkg==1.2.3`), a restart runs the same release.
 *
 * Commands this check cannot see into count as unpinned: a shell or an interpreter given a string
 * to run (`sh -c`, `node -e`, `python -c`), npm's own `*-cli.js` entry points, and a command named
 * through a variable (`$NPX`). A wrapper script (`./run.sh` that calls npx) cannot be classified.
 */

interface Kind {
  /** Options naming the package to fetch; the positional is then a command, not a package. */
  names: Set<string>;
  /** Options adding packages (comma-separated values allowed). */
  adds: Set<string>;
  /** Options with a value that is not a package. */
  values: Set<string>;
  /** Options without a value. Any other option followed by a word counts as unpinned. */
  flags: Set<string>;
  /** Options that make the runner resolve something this check cannot see. */
  opaque: Set<string>;
  /** The positional is the command to run, never a package (`uv run`). */
  commandFirst?: true;
  /** Whether one package spec is pinned to an exact release. */
  exact: (spec: string) => boolean;
}

/** `name@1.2.3` (scoped names too), with an optional prerelease or build part. No ranges, no tags. */
const NODE_PINNED =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;
/** An exact PEP 440 version: `1.2`, `1.2.3rc1`, `2!1.0.post1.dev2`, `1.0+local`. No wildcards. */
const PY_VERSION = String.raw`(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9.]+)?`;
const PY_PINNED = new RegExp(
  String.raw`^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9._,-]+\])?(?:===?|@)${PY_VERSION}$`,
  "i",
);

const set = (...items: string[]) => new Set(items);

const PY_VALUES = set(
  "-p",
  "--python",
  "--python-preference",
  "-i",
  "--index",
  "--index-url",
  "--default-index",
  "--extra-index-url",
  "--find-links",
  "-f",
  "--index-strategy",
  "--keyring-provider",
  "--allow-insecure-host",
  "-c",
  "--constraints",
  "--overrides",
  "--build-constraints",
  "--env-file",
  "--directory",
  "--project",
  "--config-file",
  "--cache-dir",
  "--resolution",
  "--prerelease",
  "--exclude-newer",
  "--link-mode",
  "--color",
  "-P",
  "--upgrade-package",
  "--reinstall-package",
  "--refresh-package",
  "--pip-args",
  "--backend",
);
const PY_FLAGS = set(
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--isolated",
  "-U",
  "--upgrade",
  "--refresh",
  "--offline",
  "--no-cache",
  "-n",
  "--native-tls",
  "--no-config",
  "--preview",
  "--reinstall",
  "--compile-bytecode",
  "--no-python-downloads",
  "--system-site-packages",
);

const NODE: Kind = {
  names: set("--package", "-p"),
  adds: set(),
  values: set("--registry", "--cache", "--userconfig", "--prefix", "--loglevel", "-C", "--dir"),
  flags: set(
    "-y",
    "--yes",
    "--no",
    "-q",
    "--quiet",
    "-s",
    "--silent",
    "--verbose",
    "--ignore-existing",
    "--prefer-offline",
    "--prefer-online",
    "--offline",
    "--no-install",
    "--bun",
  ),
  opaque: set("-c", "--call", "--shell-mode"),
  exact: (spec) => NODE_PINNED.test(spec),
};

const PY_TOOL: Kind = {
  names: set("--from", "--spec"),
  adds: set("--with"),
  values: PY_VALUES,
  flags: PY_FLAGS,
  opaque: set("--with-editable", "--with-requirements"),
  exact: (spec) => PY_PINNED.test(spec),
};

/** `uv run`: runs a script or command in the project's (locked) environment plus `--with` packages. */
const UV_RUN: Kind = {
  names: set(),
  adds: set("--with"),
  values: new Set([...PY_VALUES, "--extra", "--group", "--only-group", "--no-group", "--package"]),
  flags: new Set([
    ...PY_FLAGS,
    "--no-project",
    "--frozen",
    "--locked",
    "--no-sync",
    "--all-extras",
    "--no-dev",
    "--exact",
    "--active",
    "--script",
    "-s",
    "--module",
    "-m",
  ]),
  opaque: set("--with-editable", "--with-requirements"),
  commandFirst: true,
  exact: (spec) => PY_PINNED.test(spec),
};

/** `deno run <spec>`: an `npm:` or `jsr:` spec is fetched, a URL is fetched, a file is local. */
const DENO: Kind = {
  names: set(),
  adds: set(),
  values: set("--config", "-c", "--import-map", "--lock", "--cert", "--location", "--seed", "-L"),
  flags: set(
    "-A",
    "--allow-all",
    "-q",
    "--quiet",
    "--no-prompt",
    "-r",
    "--reload",
    "--no-check",
    "--no-lock",
    "--cached-only",
    "--no-config",
    "--no-npm",
    "--no-remote",
    "--env-file",
  ),
  opaque: set(),
  exact: (spec) => {
    const lower = spec.toLowerCase();
    if (lower.startsWith("npm:") || lower.startsWith("jsr:"))
      return NODE_PINNED.test(spec.slice(4));
    // A URL can serve anything at any time; anything else is a local file.
    return !/^[a-z][a-z0-9+.-]*:/.test(lower) || /^[a-z]:[\\/]/.test(lower);
  },
};

/** Package managers whose subcommand fetches a package to run it. */
const MANAGERS: Record<string, Set<string>> = {
  npm: set("exec", "x", "create", "init"),
  pnpm: set("dlx", "create", "init"),
  yarn: set("dlx", "create", "init"),
  bun: set("x", "create", "init"),
};

const SHELLS = set(
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "cmd",
  "powershell",
  "pwsh",
);
/** `node`, `nodejs`, versioned `node22`, `bun`, `deno`. */
const JS_RUNTIME = /^(?:node(?:js)?\d*|bun|deno)$/;
/** Interpreters that run a one-line program given with `-e` (or `php -r`). */
const SCRIPT_RUNTIME = /^(?:perl|ruby|php|lua|luajit|osascript)[\d.]*$/;
/** Shell options whose value is the next word (`bash -o pipefail`, `shopt` names via `-O`/`+O`). */
const SHELL_VALUE_OPTIONS = set("-o", "+o", "-O", "+O");
const NODE_VALUE_OPTIONS = set(
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
);
const EVAL_OPTIONS = set("-e", "-p", "-pe", "-ep", "--eval", "--print");

const baseName = (token: string) =>
  (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/, "");

/**
 * The first word after `tokens[i]` that is not an option or an option's value: the subcommand of
 * `npm --yes exec`, `pnpm -C dir dlx`. An option followed by one of `subs` takes no value.
 */
function subcommandAfter(
  tokens: string[],
  i: number,
  subs: Set<string>,
): { word: string; at: number } | undefined {
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j] as string;
    if (!t.startsWith("-")) return { word: t.toLowerCase(), at: j };
    const next = tokens[j + 1];
    const takesValue =
      !t.includes("=") &&
      next !== undefined &&
      !next.startsWith("-") &&
      !subs.has(next.toLowerCase());
    j += takesValue ? 2 : 1;
  }
  return undefined;
}

/** A shell given a string to run: `sh -c`, `bash -lc`, `cmd /c`, `pwsh -Command`. */
function shellRunsString(tokens: string[], i: number): boolean {
  for (let j = i + 1; j < tokens.length; j += 1) {
    const raw = tokens[j] as string;
    if (SHELL_VALUE_OPTIONS.has(raw)) {
      j += 1;
      continue;
    }
    const t = raw.toLowerCase();
    if (t === "/c" || t === "/k" || t === "-command" || t === "-encodedcommand") return true;
    if (/^-[a-z]*c[a-z]*$/.test(t) && !t.startsWith("--")) return true;
    if (!(t.startsWith("-") || t.startsWith("+") || /^\/[a-z]$/.test(t))) return false;
  }
  return false;
}

/** `perl -e`, `perl -ne`, `ruby -e`, `php -r`, `lua -e`, `osascript -e`. */
function scriptEvaluates(tokens: string[], i: number): boolean {
  for (let j = i + 1; j < tokens.length; j += 1) {
    const t = tokens[j] as string;
    if (!t.startsWith("-") || t.startsWith("--")) return false;
    if (/^-[a-zA-Z]*[eEr][a-zA-Z]*$/.test(t)) return true;
  }
  return false;
}

/** `node -e`, `bun --eval=…`, `node -p`, `deno eval`. */
function jsEvaluates(tokens: string[], i: number): boolean {
  if (tokens[i + 1]?.toLowerCase() === "eval") return true;
  for (let j = i + 1; j < tokens.length; j += 1) {
    const t = tokens[j] as string;
    if (!t.startsWith("-")) return false;
    const flag = t.split("=")[0]?.toLowerCase() ?? t;
    if (EVAL_OPTIONS.has(flag)) return true;
    if (NODE_VALUE_OPTIONS.has(t)) j += 1;
  }
  return false;
}

/** `python -c`, `python3 -Ic`. */
function pythonEvaluates(tokens: string[], i: number): boolean {
  for (let j = i + 1; j < tokens.length; j += 1) {
    const t = tokens[j] as string;
    if (!t.startsWith("-") || t.startsWith("--")) return false;
    if (t === "-m") return false;
    if (/^-[a-zA-Z]*c$/.test(t)) return true;
    if (t === "-W" || t === "-X") j += 1;
  }
  return false;
}

/** The runner starting at `tokens[i]`, if one does. */
function runnerAt(tokens: string[], i: number): { kind: Kind; rest: string[] } | undefined {
  const name = baseName(tokens[i] ?? "");
  if (name === "npx" || name === "pnpx" || name === "bunx")
    return { kind: NODE, rest: tokens.slice(i + 1) };
  if (name === "uvx") return { kind: PY_TOOL, rest: tokens.slice(i + 1) };
  const subs = MANAGERS[name];
  if (subs !== undefined) {
    const sub = subcommandAfter(tokens, i, subs);
    if (sub !== undefined && subs.has(sub.word))
      return { kind: NODE, rest: tokens.slice(sub.at + 1) };
    return undefined;
  }
  if (name === "pipx") {
    const sub = subcommandAfter(tokens, i, set("run"));
    if (sub?.word === "run") return { kind: PY_TOOL, rest: tokens.slice(sub.at + 1) };
    return undefined;
  }
  if (name === "uv") {
    const subs = set("run", "tool");
    const sub = subcommandAfter(tokens, i, subs);
    if (sub?.word === "run") return { kind: UV_RUN, rest: tokens.slice(sub.at + 1) };
    if (sub?.word === "tool") {
      const next = subcommandAfter(tokens, sub.at, set("run"));
      if (next?.word === "run") return { kind: PY_TOOL, rest: tokens.slice(next.at + 1) };
    }
    return undefined;
  }
  if (name === "deno") return denoAt(tokens, i);
  return undefined;
}

/**
 * `deno run <spec>`, `deno serve <spec>`, or a spec given straight to `deno` (`deno -A npm:x`, an
 * implicit run). Deno's options take their value with `=` except the few in `DENO.values`.
 */
function denoAt(tokens: string[], i: number): { kind: Kind; rest: string[] } | undefined {
  for (let j = i + 1; j < tokens.length; j += 1) {
    const t = tokens[j] as string;
    if (t.startsWith("-")) {
      if (DENO.values.has(t)) j += 1;
      continue;
    }
    const word = t.toLowerCase();
    if (word === "run" || word === "serve") return { kind: DENO, rest: tokens.slice(j + 1) };
    // A spec Deno fetches; a local file or another subcommand is not a runner.
    if (/^(?:npm|jsr|https?):/.test(word)) return { kind: DENO, rest: tokens.slice(j) };
    return undefined;
  }
  return undefined;
}

/** Whether every package this runner invocation fetches is pinned to an exact version. */
function pinned(kind: Kind, rest: string[]): boolean {
  const packages: string[] = [];
  let named = kind.commandFirst === true;
  let positional: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token === "--") {
      positional = rest[i + 1];
      break;
    }
    if (!token.startsWith("-")) {
      positional = token;
      break;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (kind.opaque.has(flag)) return false;
    if (kind.names.has(flag) || kind.adds.has(flag)) {
      const value = eq === -1 ? rest[++i] : token.slice(eq + 1);
      if (value === undefined || value === "") return false;
      packages.push(...(kind.adds.has(flag) ? value.split(",") : [value]));
      if (kind.names.has(flag)) named = true;
      continue;
    }
    if (kind.values.has(flag)) {
      if (eq === -1) i += 1;
      continue;
    }
    if (eq !== -1 || kind.flags.has(flag) || /^--(?:allow|deny|unstable)-/.test(flag)) continue;
    // An option this check does not know: the next word may be its value or the package.
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("-")) return false;
  }
  if (!named) {
    if (positional === undefined) return false;
    packages.push(positional);
  }
  return packages.every((p) => p !== "" && kind.exact(p));
}

/**
 * True when the command runs a package runner that may fetch a different release on its next
 * start, or runs something this check cannot see into. Every argument is also split on spaces,
 * shell operators and quotes, so `env -S "npx -y pkg"` counts. A word that only looks like a
 * runner errs towards true (the server just keeps running).
 */
export function reResolvesOnLaunch(command: readonly string[]): boolean {
  const tokens = command.flatMap((a) =>
    a
      .replace(/["']/g, "")
      .split(/[\s;&|()<>`]+/)
      .filter((t) => t !== ""),
  );
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    // A command named through a variable (`$NPX`, `${X}`, `$(…)`, `%NPX%`): unknown.
    if (token.startsWith("$") || /^%[^%]+%/.test(token)) return true;
    const name = baseName(token);
    // npm's and pnpm's own entry points run as `node …/npx-cli.js`.
    if (/-cli\.[cm]?js$/.test(name) || /^(?:pnpm|yarn)\.[cm]?js$/.test(name)) return true;
    if (SHELLS.has(name) && shellRunsString(tokens, i)) return true;
    if (JS_RUNTIME.test(name) && jsEvaluates(tokens, i)) return true;
    if (SCRIPT_RUNTIME.test(name) && scriptEvaluates(tokens, i)) return true;
    if (/^python(?:\d+(?:\.\d+)*)?$|^py$/.test(name) && pythonEvaluates(tokens, i)) return true;
    const runner = runnerAt(tokens, i);
    if (runner !== undefined && !pinned(runner.kind, runner.rest)) return true;
  }
  return false;
}
