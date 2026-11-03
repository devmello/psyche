import { isAbsolute, normalize } from "node:path";

/**
 * The read-only class of `exec_host` (security §5.4): commands that only read and print, which
 * run without a card when the turn is untainted, the mode is not `manual`, the cwd is granted and
 * srt runs them with no network and no writable folder. Code-checked here from the argv alone, so
 * the broker re-checks what the Gateway's description claims (`meta.hostCommand`); the Gateway
 * adds what needs the file system (symlinks, the system binary).
 *
 * The argv is the boundary, not a hint: a small allowlist of programs, each with its own argument
 * rules. Anything else, or anything this cannot tell, is not read-only and asks as before.
 */

/** Apple's binaries under System Integrity Protection: a same-user process cannot swap them. */
export const SYSTEM_BIN_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

export const READ_ONLY_RULE = "exec_host:read_only";

/** Interpreters and launchers: never anywhere in a read-only argv, whatever position. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "env",
  "xargs",
  "find",
  "python",
  "python3",
  "perl",
  "ruby",
  "node",
  "deno",
  "bun",
  "osascript",
  "awk",
  "sed",
  "tclsh",
  "php",
  "lua",
  "open",
  "sudo",
  "exec",
  "eval",
]);

/** Flags that write a file or run something, refused for every program. */
const WRITE_OR_EXEC_FLAGS = /^(-o|-i|--output(=.*)?|--in-place(=.*)?|-exec|-execdir|-ok|-okdir)$/;

export type HostReadOnly =
  | { readOnly: true; program: string; paths: string[] }
  | { readOnly: false; reason: string };

const no = (reason: string): HostReadOnly => ({ readOnly: false, reason });

type Rule = (args: string[], cwd: string) => { paths: string[] } | string;

/** Positional args are files inside the cwd: relative without `..`, or absolute under it. */
function insideCwd(arg: string, cwd: string): boolean {
  if (arg === "" || arg.startsWith("~") || arg.includes("\0")) return false;
  if (isAbsolute(arg)) {
    const root = normalize(cwd).replace(/\/+$/, "");
    const n = normalize(arg);
    return n === root || n.startsWith(`${root}/`);
  }
  return !arg.split("/").includes("..");
}

/**
 * Flags matching `flag` (and the `withValue` ones, which take the next arg as a value) plus file
 * operands inside the cwd. `--` ends the flags.
 */
function filesRule(flag: RegExp, withValue: ReadonlySet<string> = new Set()): Rule {
  return (args, cwd) => {
    const paths: string[] = [];
    let flagsDone = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (!flagsDone && a === "--") {
        flagsDone = true;
        continue;
      }
      if (!flagsDone && a.startsWith("-") && a !== "-") {
        if (withValue.has(a)) {
          if (i + 1 >= args.length) return `${a} needs a value`;
          i++;
          continue;
        }
        if (!flag.test(a)) return `flag ${a} is not in the read-only set`;
        continue;
      }
      // `-` is stdin, which is empty for a host command.
      if (a === "-") continue;
      if (!insideCwd(a, cwd)) return `${a} is outside the folder`;
      paths.push(a);
    }
    return { paths };
  };
}

/** Only flags from `flag`; no operands at all. */
function flagsOnly(flag: RegExp): Rule {
  return (args) => {
    for (const a of args) if (!flag.test(a)) return `${a} is not in the read-only set`;
    return { paths: [] };
  };
}

/** git: no global options (`-C`, `-c`, `--git-dir`…), then a reading subcommand. */
const GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch"]);
/** Reading subcommands' flags that write a file, run a program or read outside the repo. */
const GIT_REFUSED =
  /^(--output(=.*)?|--ext-diff|--textconv|--no-index|--exec(=.*)?|--upload-pack(=.*)?|--open-files-in-pager.*|-O.*)$/;
/** `git branch` only lists: these flags, and patterns only with `--list` / `-l`. */
const GIT_BRANCH_FLAGS =
  /^(-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--list|-l|--no-color|--color(=.*)?|--sort=.+|--format=.+|--column(=.*)?|--no-column|--ignore-case|--abbrev(=.*)?|--no-abbrev|--omit-empty)$/;
const GIT_BRANCH_VALUE = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);

const gitRule: Rule = (args, cwd) => {
  const sub = args[0];
  if (sub === undefined || !GIT_SUBCOMMANDS.has(sub)) {
    return sub?.startsWith("-") === true
      ? `git option ${sub} before the subcommand`
      : `git ${sub ?? ""} is not a reading subcommand`;
  }
  const rest = args.slice(1);
  if (sub === "branch") {
    let listing = false;
    let patterns = 0;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] as string;
      if (GIT_BRANCH_VALUE.has(a)) {
        if (i + 1 >= rest.length) return `${a} needs a value`;
        i++;
        continue;
      }
      if (a.startsWith("-")) {
        if (!GIT_BRANCH_FLAGS.test(a)) return `git branch ${a} is not a listing flag`;
        if (a === "--list" || a === "-l") listing = true;
        continue;
      }
      patterns++;
    }
    // A bare name creates a branch; with --list it is a pattern.
    if (patterns > 0 && !listing) return "git branch with a name creates a branch";
    return { paths: [] };
  }
  const paths: string[] = [];
  let pathsOnly = false;
  for (const a of rest) {
    if (!pathsOnly && a === "--") {
      pathsOnly = true;
      continue;
    }
    if (!pathsOnly && a.startsWith("-")) {
      if (GIT_REFUSED.test(a)) return `git ${sub} ${a} writes, runs a program or leaves the repo`;
      continue;
    }
    // Revisions (`HEAD~1`, `main..topic`, `origin/main`) and paths: neither may leave the folder.
    if (!insideCwd(a, cwd)) return `${a} is outside the folder`;
    if (pathsOnly) paths.push(a);
  }
  return { paths };
};

const RULES: Readonly<Record<string, Rule>> = {
  date: flagsOnly(/^(-u|-R|\+[^\n]{0,200})$/),
  pwd: flagsOnly(/^-[LP]$/),
  whoami: flagsOnly(/^$/),
  uname: flagsOnly(/^-[amnoprsv]+$/),
  ls: filesRule(/^-[ABCFGHLOPRSTUWabcdefghklmnopqrstuvwx1%,@]+$/),
  cat: filesRule(/^-[benstuv]+$/),
  head: filesRule(/^(-[qv]|-n\d+|-c\d+|-\d+)$/, new Set(["-n", "-c"])),
  tail: filesRule(/^(-[qr]|-n[+-]?\d+|-c[+-]?\d+|-[+-]?\d+|-b\d+)$/, new Set(["-n", "-c", "-b"])),
  wc: filesRule(/^-[clmwL]+$/),
  file: filesRule(/^(-[bhIiLkz0]+|--mime|--mime-type|--mime-encoding|--brief)$/),
  stat: filesRule(/^-[FLlnqrsx]+$/, new Set(["-f", "-t"])),
  which: (args) => {
    for (const a of args) {
      if (a.startsWith("-")) {
        if (!/^-[as]+$/.test(a)) return `which ${a} is not in the read-only set`;
      } else if (a.includes("/") || a === "") return `which takes program names, not ${a}`;
    }
    return { paths: [] };
  },
  git: gitRule,
};

export const READ_ONLY_HOST_PROGRAMS: readonly string[] = Object.keys(RULES);

/** Whether `argv`, run in `cwd`, is in the read-only class, and if not why. */
export function classifyHostCommand(argv: readonly unknown[], cwd: string): HostReadOnly {
  if (argv.length === 0 || argv.length > 64) return no("argv is empty or too long");
  if (!argv.every((a): a is string => typeof a === "string" && a.length <= 4096)) {
    return no("argv must be short strings");
  }
  if (!isAbsolute(cwd)) return no("cwd must be absolute");
  const [program, ...args] = argv as string[];
  if (program === undefined || program.includes("/")) {
    return no("only a bare program name from the system folders is read-only");
  }
  const rule = RULES[program];
  if (rule === undefined) return no(`${program} is not in the read-only set`);
  for (const a of argv as string[]) {
    if (/[\0\n\r]/.test(a)) return no("argv contains a control character");
    if (WRITE_OR_EXEC_FLAGS.test(a)) return no(`${a} writes a file or runs a program`);
    const base = a.split("/").at(-1) ?? a;
    if (INTERPRETERS.has(a) || INTERPRETERS.has(base)) return no(`${a} is an interpreter`);
  }
  const out = rule(args, cwd);
  return typeof out === "string" ? no(out) : { readOnly: true, program, paths: out.paths };
}
