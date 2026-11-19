import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalPath, isUnder } from "./targets.ts";

/**
 * "Always allow <program> in <folder>" for `exec_host` (security §5.4, §3.4). A standing grant
 * keyed on a program and a folder, not on one exact command line. Everything here is pure and
 * fails closed: anything it cannot express asks.
 *
 * - Identity is the resolved, real absolute path of argv[0] plus its SHA-256 at grant time.
 *   A bare name is never a key. A renamed, replaced or shadowing binary is a different identity.
 * - Never offered for shells, interpreters, launchers, network tools or package managers
 *   (`HOST_PROGRAM_NEVER`), nor when the binary is not under a system or package-manager root
 *   (`HOST_PROGRAM_ROOTS`) or lies inside a folder the agent can write.
 * - Arguments: only `HOST_PROGRAM_ANY_ARGV` tools, which cannot run other code, are covered with
 *   any arguments, and only after `anyArgvSafe` has read the flags. Every other program is
 *   covered for the exact argv the owner saw.
 */

export const HOST_PROGRAM_RULE = "exec_host:program_grant";

/** Shells, interpreters, launchers, network tools and script-running package managers. */
export const HOST_PROGRAM_NEVER: ReadonlySet<string> = new Set([
  // shells
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  // interpreters (versioned names are caught by NEVER_PATTERN)
  "python",
  "node",
  "ruby",
  "perl",
  "php",
  "lua",
  "deno",
  "bun",
  "osascript",
  "awk",
  "gawk",
  "nawk",
  "tclsh",
  "expect",
  "swift",
  "java",
  // launchers that run another program
  "env",
  "xargs",
  "sudo",
  "doas",
  "su",
  "open",
  "nohup",
  "nice",
  "time",
  "timeout",
  "exec",
  "command",
  "eval",
  "script",
  "screen",
  "tmux",
  "launchctl",
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  // network
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "telnet",
  "ftp",
  // package managers and build tools that run scripts
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "brew",
  "make",
  "gmake",
  "cargo",
  "go",
  "gem",
  "bundle",
  "rake",
  "mvn",
  "gradle",
  "cmake",
  "ninja",
  "xcodebuild",
  "docker",
  // programs that run another program through an option, or edit with one
  "tar",
  "vi",
  "vim",
  "nvim",
  "ex",
  "emacs",
  "less",
  "more",
  "man",
  "tee",
  "dd",
]);

const NEVER_PATTERN = /^(python|ruby|perl|node|php|lua|pypy|java)[0-9.]*$/;

/** Tools that cannot run other code or write files, given the flag checks in `anyArgvSafe`. */
export const HOST_PROGRAM_ANY_ARGV: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "jq",
  "sed",
  "tree",
  "du",
  "stat",
  "file",
];

/** Where a granted binary may live: the system and the package managers' prefixes. */
export const HOST_PROGRAM_ROOTS: readonly string[] = [
  // Not `/usr/local`: on an Intel Mac Homebrew's prefix there is writable by the owner's processes.
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
  "/opt/homebrew",
  "/Library/Developer/CommandLineTools",
  "/Applications/Xcode.app",
];

/** NFKC-folded, lower-cased name: `GIT`, `ſh` and `baſh` are `git`, `sh` and `bash` on APFS. */
export const programName = (p: string): string =>
  basename(p)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.exe$/, "");

/** Is this name a program the grant is never offered for? */
export function isNeverProgram(name: string): boolean {
  const n = programName(name);
  return HOST_PROGRAM_NEVER.has(n) || NEVER_PATTERN.test(n);
}

/** The single `-abc` cluster letters of a short-option argument, or none. */
const cluster = (a: string): string => (/^-[^-]/.test(a) ? a.slice(1) : "");
const has = (a: string, chars: string): boolean => [...cluster(a)].some((c) => chars.includes(c));

const SED_ADDR = String.raw`(?:\d+|\$|\/(?:\\.|[^\/\\])*\/)`;
const SED_ADDRESS = new RegExp(`^${SED_ADDR}(?:,${SED_ADDR})?!?`);
const SED_SUBST = /^s\/(?:\\.|[^/\\])*\/(?:\\.|[^/\\])*\/[gpIi0-9]*/;

/**
 * Is a sed script made only of commands that read and print? A tiny parser: addresses, then one
 * of `p d q n N P D g G h H x l =` or `s/re/repl/flags` (no `e` or `w` flag), grouped by `{}`.
 * Anything else (`e`, `w`, `r`, `a`, `i`, `c`, `y`, labels, other delimiters) is unsafe.
 */
export function sedScriptSafe(script: string): boolean {
  let s = script;
  while (s.length > 0) {
    s = s.replace(/^[\s;]+/, "");
    if (s === "") return true;
    const a = SED_ADDRESS.exec(s);
    if (a !== null) s = s.slice(a[0].length).replace(/^\s+/, "");
    if (s === "") return false;
    if (s[0] === "{" || s[0] === "}") {
      s = s.slice(1);
      continue;
    }
    if (s[0] === "s") {
      const m = SED_SUBST.exec(s);
      if (m === null) return false;
      s = s.slice(m[0].length);
      continue;
    }
    if (/^[pdqnNPDgGhHxl=]/.test(s)) {
      s = s.slice(1);
      // `q` and `l` may take a number.
      s = s.replace(/^\d+/, "");
      continue;
    }
    return false;
  }
  return true;
}

function sedSafe(args: readonly string[]): boolean {
  const scripts: string[] = [];
  let haveE = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      i++;
      break;
    }
    if (a.startsWith("--")) {
      if (
        ["--quiet", "--silent", "--regexp-extended", "--posix", "--debug", "--sandbox"].includes(a)
      )
        continue;
      if (a.startsWith("--expression=")) {
        haveE = true;
        scripts.push(a.slice("--expression=".length));
        continue;
      }
      if (a === "--expression") {
        haveE = true;
        scripts.push(args[++i] ?? "e");
        continue;
      }
      return false; // --in-place, --file, --null-data, --separate, anything unknown
    }
    if (/^-[^-]/.test(a)) {
      const letters = [...a.slice(1)];
      for (let k = 0; k < letters.length; k++) {
        const c = letters[k] as string;
        if ("nEru".includes(c)) continue;
        if (c === "e") {
          haveE = true;
          const rest = letters.slice(k + 1).join("");
          scripts.push(rest !== "" ? rest : (args[++i] ?? "e"));
          break;
        }
        return false; // -i, -f, -s, -z, anything unknown
      }
      continue;
    }
    break; // first operand
  }
  const operands = args.slice(i);
  if (!haveE) {
    if (operands.length === 0) return false;
    scripts.push(operands[0] as string);
  }
  return scripts.every(sedScriptSafe);
}

const FIND_UNSAFE = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/**
 * Do these arguments of an any-argv program stay inside "reads and prints"? False for every flag
 * that runs another program, writes a file or loads code from elsewhere.
 */
export function anyArgvSafe(program: string, args: readonly string[]): boolean {
  const name = programName(program);
  if (!HOST_PROGRAM_ANY_ARGV.includes(name)) return false;
  // Every check below stops at the first `--`. But an option that takes a value takes the next
  // argument as-is, even `--` (`rg -e -- --pre=./x.sh`, `grep -e -- -rS`), so the flags after it
  // still count. Any dash-led argument after a `--` is exact-argv: it gets a card.
  const dd = args.indexOf("--");
  if (dd !== -1 && args.slice(dd + 1).some((a) => a.startsWith("-"))) return false;
  // GNU tools read options after operands (`sed p f -e '1e id'`): a late option is exact-argv.
  if (scanArgs(name, args).lateOption) return false;
  if (followsLinks(name, args)) return false;
  // A list of files to read, named by a file: its entries are never checked.
  if (args.some((a) => a !== "--" && /^--files0?-from/.test(a))) return false;
  // rg's own parser takes no abbreviations (and has a real `--files`); GNU getopt_long does.
  if (name !== "rg" && args.some((a) => longPrefixOf(a, LIST_LONG))) return false;
  switch (name) {
    case "find":
      return !args.some((a) => FIND_UNSAFE.has(a));
    case "sed":
      return sedSafe(args);
    case "rg": {
      for (const a of args) {
        if (a === "--") break;
        if (/^--(pre|hostname-bin|search-zip)/.test(a)) return false;
        // `-z` (decompress through external programs), also inside a cluster such as `-uz`, but
        // not in the value of an option that takes one (`-f/var/folders/z`).
        if (isOption(a) && !a.startsWith("--") && clusterLetters("rg", a).flags.includes("z")) {
          return false;
        }
      }
      return true;
    }
    case "tree":
      // `-o` writes a file; `-R` and `-H` write `00Tree.html` into directories.
      return !args.some((a) => a === "--output" || a.startsWith("--output=") || has(a, "oRH"));
    case "file":
      return !args.some(
        (a) =>
          /^--(compile|uncompress|magic-file)/.test(a) ||
          longPrefixOf(a, FILE_UNSAFE_LONG) ||
          has(a, "CzZmf"),
      );
    default:
      return true;
  }
}

/** file's long options that write, decompress through other programs or load a magic file. */
const FILE_UNSAFE_LONG = ["--compile", "--uncompress", "--uncompress-noreport", "--magic-file"];
/** Long options that make a tool read its list of files from a file. */
const LIST_LONG = ["--files0-from", "--files-from"];
/** Long options that follow symbolic links. */
const FOLLOW_LONG = [
  "--dereference",
  "--dereference-recursive",
  "--dereference-args",
  "--dereference-command-line",
  "--dereference-command-line-symlink-to-dir",
  "--follow",
  "--follow-symlinks",
];

/**
 * Is `a` one of `names`, or an abbreviation of one? GNU getopt_long accepts any unique prefix
 * (`grep --der` is `--dereference-recursive`), so a prefix counts as the option itself. An
 * ambiguous prefix makes the tool fail, so counting it too only costs a card.
 */
function longPrefixOf(a: string, names: readonly string[]): boolean {
  if (!a.startsWith("--") || a === "--") return false;
  const eq = a.indexOf("=");
  const opt = eq === -1 ? a : a.slice(0, eq);
  // `--f=` is already `--files-from` for macOS `file`; only `--` itself is no option.
  return opt.length >= 3 && names.some((n) => n.startsWith(opt));
}

/**
 * Short options that take a value, per tool (the value may be attached: `-fPATH`). A letter
 * missing here only costs a card: the rest of its cluster is then read as flags and its value as
 * an operand, which are checked like any other. Don't drop a letter to save a card.
 */
const VALUE_LETTERS: Record<string, string> = {
  rg: "ABCEMTdefgjmrt",
  grep: "ABCDdefm",
  jq: "Lf",
  file: "fmFP",
  head: "nc",
  tail: "nc",
  tree: "LPIoHT",
  du: "dBt",
  find: "",
  ls: "",
  wc: "",
  stat: "",
  sed: "",
};
/** Of those, the ones whose value is a path. */
const PATH_LETTERS: Record<string, string> = { rg: "f", grep: "f", jq: "Lf", file: "fm" };
/**
 * Of VALUE_LETTERS, the letters whose SEPARATE value (`rg -t ts`) is skipped when counting
 * operands. Unlike VALUE_LETTERS, a letter wrongly listed here hides an argument from the
 * operand check, so each one is checked against the real tool's man page (BSD on macOS, GNU on
 * Linux; the stricter reading where they differ). A letter not listed only costs a card.
 * Not listed on purpose: `jq -f` (a boolean in jq 1.7, the program file is its first operand,
 * which is path-checked either way) and `file -fmFP` (not needed; `-f` and `-m` ask anyway).
 * tree's parser takes the value of every value letter in a cluster from the following arguments
 * (see `clusterLetters`), so for tree each such letter counts.
 */
const SKIP_LETTERS: Record<string, string> = {
  rg: "ABCEMTdefgjmrt",
  grep: "ABCDdefm",
  jq: "L",
  head: "nc",
  tail: "nc",
  tree: "LPIoHT",
  du: "dBt",
};

type Slot = "plain" | "path";

/**
 * Long options that take a value in the NEXT argument (`--type ts`), per tool, with one slot per
 * value: a "path" slot is checked like an operand, a "plain" one (a type, a count, a glob, a
 * variable name) is skipped. Exact names only: an abbreviation or an unlisted option keeps the
 * default (the next argument is an operand). Options with an OPTIONAL value are left out, since
 * the next argument is then an operand: BSD grep's `--context[=num]` and `--color[=when]`.
 * Checked against ripgrep 14 `--help`, BSD grep (macOS, probed), jq 1.7 `--help`, tree 1.8's man
 * page and GNU grep, head, tail and du man pages.
 */
const LONG_VALUES: Record<string, Record<string, readonly Slot[]>> = {
  rg: {
    "--after-context": ["plain"],
    "--before-context": ["plain"],
    "--context": ["plain"],
    "--regexp": ["plain"],
    "--glob": ["plain"],
    "--iglob": ["plain"],
    "--type": ["plain"],
    "--type-not": ["plain"],
    "--max-count": ["plain"],
    "--max-depth": ["plain"],
    "--max-filesize": ["plain"],
    "--max-columns": ["plain"],
    "--threads": ["plain"],
    "--replace": ["plain"],
    "--encoding": ["plain"],
    "--sort": ["plain"],
    "--sortr": ["plain"],
    "--file": ["path"],
    "--ignore-file": ["path"],
  },
  grep: {
    "--after-context": ["plain"],
    "--before-context": ["plain"],
    "--regexp": ["plain"],
    "--max-count": ["plain"],
    "--binary-files": ["plain"],
    "--directories": ["plain"],
    "--devices": ["plain"],
    "--include": ["plain"],
    "--exclude": ["plain"],
    "--exclude-dir": ["plain"],
    "--label": ["plain"],
    "--file": ["path"],
  },
  jq: {
    "--arg": ["plain", "plain"],
    "--argjson": ["plain", "plain"],
    "--slurpfile": ["plain", "path"],
    "--rawfile": ["plain", "path"],
    "--indent": ["plain"],
    "--library-path": ["path"],
  },
  head: { "--lines": ["plain"], "--bytes": ["plain"] },
  tail: { "--lines": ["plain"], "--bytes": ["plain"] },
  du: { "--max-depth": ["plain"], "--block-size": ["plain"], "--threshold": ["plain"] },
  tree: {
    "--charset": ["plain"],
    "--filelimit": ["plain"],
    "--sort": ["plain"],
    "--timefmt": ["plain"],
    "--gitfile": ["path"],
    "--infofile": ["path"],
    "--hintro": ["path"],
    "--houtro": ["path"],
  },
};

/** Short options that follow symbolic links, per tool. */
const FOLLOW_LETTERS: Record<string, string> = {
  rg: "L",
  grep: "SRO",
  ls: "LH",
  du: "LHD",
  stat: "L",
  file: "L",
  tree: "l",
};

/**
 * The letters of a short-option cluster up to and including the first one that takes a value;
 * what follows that letter is its value, not more flags (`-f/var/folders/z` is `f` plus a path).
 */
function clusterLetters(name: string, a: string): { flags: string; value: string } {
  const vals = VALUE_LETTERS[name] ?? "";
  const body = a.slice(1);
  // tree's parser is not getopt: a value letter takes the NEXT argument and the rest of the
  // cluster is still flags (`tree -Ll 2` follows links). Every letter counts.
  if (name === "tree") return { flags: body, value: "" };
  for (let i = 0; i < body.length; i++) {
    if (vals.includes(body[i] as string)) {
      return { flags: body.slice(0, i + 1), value: body.slice(i + 1) };
    }
  }
  return { flags: body, value: "" };
}

/** Is this token an option (before any `--`) of the command? */
const isOption = (a: string) => a.length > 1 && a.startsWith("-");

/** Option values written attached (`--x=v`, `-fv`): they name paths like operands do. */
function attachedValues(name: string, args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a === "--") break;
    if (!isOption(a)) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      // sed's `--expression=` is a script, not a path.
      if (eq > 0 && !(name === "sed" && a.startsWith("--expression="))) out.push(a.slice(eq + 1));
      continue;
    }
    if (name === "find" || name === "sed") continue;
    const { flags, value } = clusterLetters(name, a);
    const last = flags.slice(-1);
    if (value !== "" && (PATH_LETTERS[name] ?? "").includes(last)) out.push(value);
  }
  return out;
}

/** Does any option follow symbolic links while walking? Those can leave the folder. */
function followsLinks(name: string, args: readonly string[]): boolean {
  for (const a of args) {
    if (a === "--") break;
    if (/^--(dereference|follow|follow-symlinks)/.test(a)) return true;
    if (name !== "rg" && longPrefixOf(a, FOLLOW_LONG)) return true;
    if (name === "find" && (a === "-follow" || /^-[HLP]*[HL][HLP]*$/.test(a))) return true;
    if (!isOption(a) || a.startsWith("--")) continue;
    const { flags } = clusterLetters(name, a);
    if ([...flags].some((c) => (FOLLOW_LETTERS[name] ?? "").includes(c))) return true;
  }
  return false;
}

/**
 * The values an option takes from the arguments that follow it, one slot each. Only an option
 * with no attached value counts: `-t ts` has one slot, `-tts` and `--type=ts` have none.
 */
function valueSlots(name: string, a: string): Slot[] {
  if (a.startsWith("--")) return [...(LONG_VALUES[name]?.[a] ?? [])];
  const skippable = SKIP_LETTERS[name] ?? "";
  const body = a.slice(1);
  if (name === "tree") {
    // Every value letter of the cluster takes the next argument, in order. The one exception is
    // `-L` with attached digits (`-L2`, `-L2I x`): tree reads the digits as its value and takes
    // nothing from the next argument, which stays an operand.
    const slots: Slot[] = [];
    for (let i = 0; i < body.length; i++) {
      const c = body[i] as string;
      if (c === "L" && /[0-9]/.test(body[i + 1] ?? "")) {
        while (/[0-9]/.test(body[i + 1] ?? "")) i++;
        continue;
      }
      if (skippable.includes(c)) slots.push("plain");
    }
    return slots;
  }
  const { flags, value } = clusterLetters(name, a);
  const last = flags.slice(-1);
  if (value !== "" || last === "" || !skippable.includes(last)) return [];
  return [(PATH_LETTERS[name] ?? "").includes(last) ? "path" : "plain"];
}

/**
 * Splits arguments into operands and notes an option that follows the first operand. The
 * separate value of a known value option (`rg -t ts`) is not an operand, so it neither counts as
 * the first one nor makes a later option "late". A "path" value goes to `pathValues`, to be
 * checked like an operand. A value that starts with `-` is not skipped: it is read as the option
 * it looks like (every flag scan sees it), as are `--` and everything after it.
 */
function scanArgs(
  name: string,
  args: readonly string[],
): { operands: string[]; lateOption: boolean; pathValues: string[] } {
  let afterDD = false;
  let seen = false;
  let late = false;
  let skip = false;
  let pending: Slot[] = [];
  const operands: string[] = [];
  const pathValues: string[] = [];
  for (const a of args) {
    if (skip) {
      skip = false;
      continue;
    }
    if (pending.length > 0) {
      if (!a.startsWith("-")) {
        if (pending.shift() === "path") pathValues.push(a);
        continue;
      }
      pending = [];
    }
    if (!afterDD && a === "--") {
      afterDD = true;
      continue;
    }
    if (!afterDD && a.length > 1 && a.startsWith("-")) {
      if (seen && name !== "find") late = true;
      if (name === "sed" && (a === "-e" || a === "--expression")) skip = true;
      pending = valueSlots(name, a);
      continue;
    }
    operands.push(a);
    seen = true;
  }
  return { operands, lateOption: late, pathValues };
}

/** The real path of `p`, following symlinks in the part that exists. */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Does every path an any-argv command names resolve (symlinks followed) inside the grant folder?
 * Absolute paths, `..`, `~`, a hard-linked file, a FIFO or device, and a `find` with no start
 * path or a start path outside all fail. Every non-option argument counts, patterns included:
 * a pattern that looks like an outside path asks, never runs. The separate value of an option
 * known to take one (`rg -t ts`, `grep -A 3`) is not an operand, but one that names a path
 * (`grep -f FILE`, `rg --ignore-file FILE`, `jq -L DIR`) is checked like one.
 */
export function operandsInside(
  program: string,
  args: readonly string[],
  cwdReal: string,
  folder: string,
): boolean {
  const name = programName(program);
  let folderReal: string;
  try {
    folderReal = realpathSync.native(folder);
  } catch {
    return false;
  }
  if (!isUnder(cwdReal, folderReal)) return false;
  const scanned = scanArgs(name, args);
  let operands = [...scanned.operands, ...scanned.pathValues, ...attachedValues(name, args)];
  if (name === "sed") {
    const haveE = args.some(
      (a) =>
        a === "-e" ||
        a.startsWith("--expression") ||
        (/^-[a-zA-Z]*e/.test(a) && !a.startsWith("--")),
    );
    if (!haveE) operands = operands.slice(1);
  }
  if (name === "find") {
    const end = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
    const starts = end === -1 ? args : args.slice(0, end);
    if (starts.length === 0) return false;
  }
  for (const o of operands) {
    if (o.includes("\0") || o.startsWith("~")) return false;
    const real = realish(isAbsolute(o) ? o : resolve(cwdReal, o));
    if (!isUnder(real, folderReal)) return false;
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(real);
    } catch {
      st = undefined;
    }
    if (st !== undefined) {
      if (!st.isFile() && !st.isDirectory()) return false;
      if (st.isFile() && st.nlink > 1) return false;
    }
  }
  return true;
}

export interface HostProgramFacts {
  argv: readonly string[];
  cwd: string;
  env?: Record<string, unknown> | undefined;
  allowedDomains?: readonly unknown[] | undefined;
  executable: string;
  sha256: string;
  /** The real cwd after symlinks, when the Gateway could resolve it. */
  cwdReal?: string | undefined;
}

export interface HostProgramContext {
  platform: NodeJS.Platform;
  roots: readonly string[];
  /** Is this path inside a folder the agent may write or the owner shared (a binary it could plant)? */
  inGrantedFolder(path: string): boolean;
}

/** Why a call can never be covered by a program grant, or `undefined` when it may be offered. */
export function hostProgramRefusal(
  f: HostProgramFacts,
  ctx: HostProgramContext,
): string | undefined {
  if (ctx.platform === "win32") return "windows";
  const argv0 = f.argv[0];
  if (typeof argv0 !== "string" || argv0 === "" || f.argv.some((a) => typeof a !== "string")) {
    return "argv";
  }
  if (f.argv.length > 128 || f.argv.some((a) => a.includes("\0"))) return "argv";
  // A whole shell string in argv[0] ("ls | wc", "cat x > y"): never a program name.
  if (/[\s|&;<>$`()*?'"\\]/.test(argv0)) return "shell_string";
  if (isNeverProgram(argv0) || isNeverProgram(f.executable)) return "never_program";
  if (f.env !== undefined && Object.keys(f.env).length > 0) return "env";
  if (f.allowedDomains !== undefined && f.allowedDomains.length > 0) return "network";
  if (!/^\/.+/.test(f.executable)) return "executable";
  let exe: string;
  try {
    exe = canonicalPath(f.executable);
    canonicalPath(f.cwd);
  } catch {
    return "path";
  }
  if (!ctx.roots.some((r) => isUnder(exe, r))) return "outside_roots";
  if (ctx.inGrantedFolder(exe)) return "in_folder";
  if (!/^sha256:[0-9a-f]{64}$/.test(f.sha256)) return "hash";
  return undefined;
}

/** What a stored program grant covers. `argv` is null for an any-argv grant. */
export interface HostProgramGrant {
  executable: string;
  sha256: string;
  folder: string;
  argv: string[] | null;
}

/** Whether the call lies in the grant's program, folder and arguments (the safety checks apart). */
export function hostProgramGrantCovers(g: HostProgramGrant, f: HostProgramFacts): boolean {
  if (g.executable !== f.executable || g.sha256 !== f.sha256) return false;
  let cwd: string;
  try {
    cwd = canonicalPath(f.cwd);
  } catch {
    return false;
  }
  if (!isUnder(cwd, g.folder)) return false;
  // A symlink inside the folder must not lead the command out of it.
  if (f.cwdReal !== undefined && !isUnder(f.cwdReal, g.folder)) return false;
  // Only any-argv grants exist; a row with an argv list is not one this build makes.
  if (g.argv !== null) return false;
  if (hostProgramCoverage(f.argv, f.executable) !== "any") return false;
  // Without the real cwd the operands cannot be judged: fail closed.
  if (f.cwdReal === undefined) return false;
  return operandsInside(f.argv[0] as string, f.argv.slice(1), f.cwdReal, g.folder);
}

/** Which kind of grant a card would offer for this argv. */
export function hostProgramCoverage(argv: readonly string[], executable: string): "any" | "exact" {
  const name = programName(argv[0] ?? "");
  // The real binary must carry the tool's own name: a link called `cat` to something else is
  // judged by the something else, so it is exact-argv only.
  if (programName(executable) !== name) return "exact";
  return HOST_PROGRAM_ANY_ARGV.includes(name) && anyArgvSafe(name, argv.slice(1)) ? "any" : "exact";
}
