import { isAbsolute, normalize } from "node:path";

/**
 * The read-only class of `exec_host` (security §5.4): basic file and info commands that only read
 * and print, which run without a card when the turn is untainted, the mode is not `manual`, the
 * cwd is granted and srt runs them with no network and no writable folder. Code-checked here from
 * the argv alone, so the broker re-checks what the Gateway's description claims
 * (`meta.hostCommand`); the Gateway adds what needs the file system (real paths, regular files,
 * the system binary).
 *
 * The argv is the boundary, not a hint: a small allowlist of programs, each with its own argument
 * rules. Anything else, or anything this cannot tell, is not read-only and asks as before. Nothing
 * that reads configuration naming programs to run is in it: git runs filters, textconv drivers,
 * fsmonitor and gpg from repository config, so git always asks (re-adding it would need, at least,
 * the real git from `xcrun -f git` and every config-driven program switched off).
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

/**
 * Positional args are files inside the cwd: relative without `..`, or absolute under it. Never a
 * `:` (revision and pathspec syntax such as `HEAD:../x` or `:/`, resolved by whatever reads it).
 */
function insideCwd(arg: string, cwd: string): boolean {
  if (arg === "" || arg.startsWith("~") || arg.includes("\0") || arg.includes(":")) return false;
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

const RULES: Readonly<Record<string, Rule>> = {
  date: flagsOnly(/^(-u|-R|\+[^\n]{0,200})$/),
  pwd: flagsOnly(/^-[LP]$/),
  whoami: flagsOnly(/^$/),
  uname: flagsOnly(/^-[amnoprsv]+$/),
  // Not -L / -H (they follow symlinks, out of the folder with -R).
  ls: filesRule(/^-[ABCFGOPRSTUWabcdefghklmnopqrstuvwx1%,@]+$/),
  cat: filesRule(/^-[benstuv]+$/),
  head: filesRule(/^(-[qv]|-n\d+|-c\d+|-\d+)$/, new Set(["-n", "-c"])),
  tail: filesRule(/^(-[qr]|-n[+-]?\d+|-c[+-]?\d+|-[+-]?\d+|-b\d+)$/, new Set(["-n", "-c", "-b"])),
  wc: filesRule(/^-[clmwL]+$/),
  // Not -z / -Z (they run decompressors) nor -L (follows symlinks).
  file: filesRule(/^(-[bhIik0]+|--mime|--mime-type|--mime-encoding|--brief)$/),
  stat: filesRule(/^-[FLlnqrsx]+$/, new Set(["-f", "-t"])),
  which: (args) => {
    for (const a of args) {
      if (a.startsWith("-")) {
        if (!/^-[as]+$/.test(a)) return `which ${a} is not in the read-only set`;
      } else if (a.includes("/") || a === "") return `which takes program names, not ${a}`;
    }
    return { paths: [] };
  },
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
    if (!a.startsWith("-") && !a.startsWith("+") && a.includes(":")) return no(`${a} contains ":"`);
    if (WRITE_OR_EXEC_FLAGS.test(a)) return no(`${a} writes a file or runs a program`);
    const base = a.split("/").at(-1) ?? a;
    if (INTERPRETERS.has(a) || INTERPRETERS.has(base)) return no(`${a} is an interpreter`);
  }
  const out = rule(args, cwd);
  return typeof out === "string" ? no(out) : { readOnly: true, program, paths: out.paths };
}
