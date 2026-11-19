import { basename } from "node:path";
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
  "/usr",
  "/bin",
  "/sbin",
  "/opt/homebrew",
  "/Library/Developer/CommandLineTools",
  "/Applications/Xcode.app",
];

const programName = (p: string): string =>
  basename(p)
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
  switch (name) {
    case "find":
      return !args.some((a) => FIND_UNSAFE.has(a));
    case "sed":
      return sedSafe(args);
    case "rg": {
      for (const a of args) {
        if (a === "--") break;
        if (/^--(pre|hostname-bin|search-zip)/.test(a)) return false;
        // `-z` (decompress through external programs), also inside a cluster such as `-uz`.
        if (has(a, "z")) return false;
      }
      return true;
    }
    case "tree":
      return !args.some((a) => a === "--output" || a.startsWith("--output=") || has(a, "o"));
    case "file":
      return !args.some((a) => /^--(compile|uncompress|magic-file)/.test(a) || has(a, "CzZm"));
    default:
      return true;
  }
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
  if (g.argv !== null) {
    return g.argv.length === f.argv.length && g.argv.every((a, i) => a === f.argv[i]);
  }
  return hostProgramCoverage(f.argv, f.executable) === "any";
}

/** Which kind of grant a card would offer for this argv. */
export function hostProgramCoverage(argv: readonly string[], executable: string): "any" | "exact" {
  const name = programName(argv[0] ?? "");
  // The real binary must carry the tool's own name: a link called `cat` to something else is
  // judged by the something else, so it is exact-argv only.
  if (programName(executable) !== name) return "exact";
  return HOST_PROGRAM_ANY_ARGV.includes(name) && anyArgvSafe(name, argv.slice(1)) ? "any" : "exact";
}
