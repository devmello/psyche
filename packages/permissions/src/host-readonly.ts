import { posix } from "node:path";

/**
 * The read-only class of `exec_host` (security §5.4): basic file and info commands that only read
 * and print, which run without a card when the turn is untainted, the mode is not `manual`, the
 * cwd is granted and srt runs them with no network and no writable folder. Code-checked here from
 * the argv alone, so the broker re-checks what the Gateway's description claims
 * (`meta.hostCommand`); the Gateway adds what needs the file system (real paths, regular files,
 * the system binary).
 *
 * The argv is the boundary, not a hint: a small allowlist of programs, each with its own argument
 * rules. Anything else, or anything this cannot tell, is not read-only and asks as before.
 *
 * Git is in it again, narrowly (security §5.4): `status`, `log`, `diff`, `show`, `branch` (list
 * only), `rev-parse`, `ls-files`, `blame` and `remote -v`. git runs filters, textconv drivers,
 * fsmonitor, pagers and gpg from repository config, so this file only fixes WHICH argv counts (an
 * allowlist of exact subcommands and flags, no option before the subcommand at all) and the
 * Gateway runs it hardened: the system git, every config-driven program switched off, no system
 * or global config, no pager, no optional locks, and the repository checked to be a plain `.git`
 * directory inside the granted folder (`exec-host.ts`, `gitRepoRoot`).
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
  if (posix.isAbsolute(arg)) {
    const root = posix.normalize(cwd).replace(/\/+$/, "");
    const n = posix.normalize(arg);
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

/** Alternatives for one `^(…)$` flag pattern. */
const alt = (...parts: string[]) => new RegExp(`^(${parts.join("|")})$`);

/** Flags `diff`, `log` and `show` share: they shape the diff output and run nothing. */
const GIT_DIFF_FLAGS = [
  "-p",
  "-s",
  "-z",
  "-w",
  "-b",
  "--patch",
  "--no-patch",
  "--stat(=\\d{1,4}(,\\d{1,4}){0,2})?",
  "--shortstat",
  "--numstat",
  "--name-only",
  "--name-status",
  "--summary",
  "--raw",
  "--no-color",
  "--color=never",
  "--no-renames",
  "-M(\\d{1,3}%?)?",
  "--find-renames(=\\d{1,3}%?)?",
  "--minimal",
  "--patience",
  "--histogram",
  "--ignore-space-change",
  "--ignore-all-space",
  "--ignore-space-at-eol",
  "--word-diff(=(plain|color|porcelain|none))?",
  "-U\\d{1,4}",
  "--unified=\\d{1,4}",
  "--diff-filter=[ACDMRTUXB]{1,9}",
  "--abbrev(=\\d{1,2})?",
  "--no-abbrev",
  "--full-index",
];

/** Flags `log` and `show` share. `--format`/`--pretty` are checked apart (no `%G`: it runs gpg). */
const GIT_LOG_FLAGS = [
  "--oneline",
  "--abbrev-commit",
  "--no-abbrev-commit",
  "--decorate(=(short|full|no))?",
  "--no-decorate",
  "--date=[A-Za-z0-9:.,-]{1,40}",
  "--relative-date",
  "(--pretty|--format)=[^\\x00-\\x1f]{0,300}",
];

const GIT_REV_SELECT_FLAGS = [
  "-\\d{1,5}",
  "-n\\d{1,6}",
  "--max-count=\\d{1,6}",
  "--skip=\\d{1,6}",
  "--graph",
  "--all",
  "--branches",
  "--tags",
  "--remotes",
  "--follow",
  "--reverse",
  "--merges",
  "--no-merges",
  "--first-parent",
  "--topo-order",
  "--date-order",
  "--author-date-order",
  "--left-right",
  "--boundary",
  "--all-match",
  "--invert-grep",
  "--regexp-ignore-case",
  "--(author|committer|grep|since|until|after|before)=[^\\x00-\\x1f]{0,300}",
];

const GIT_NUMBER = /^\d{1,6}$/;

interface GitSpec {
  flags: RegExp;
  /** Flags whose value is the next argument, with the pattern that value must match. */
  withValue?: Readonly<Record<string, RegExp>>;
  /** Whether revisions and pathspecs may follow; they all stay inside the folder. */
  operands: boolean;
}

const GIT_SPECS: Readonly<Record<string, GitSpec>> = {
  status: {
    flags: alt(
      "-s",
      "-b",
      "-z",
      "--short",
      "--branch",
      "--long",
      "--porcelain(=v[12])?",
      "--show-stash",
      "--renames",
      "--no-renames",
      "--ahead-behind",
      "--no-ahead-behind",
      "-u(no|normal|all)?",
      "--untracked-files(=(no|normal|all))?",
      "--ignored(=(traditional|matching|no))?",
    ),
    operands: true,
  },
  log: {
    flags: alt(...GIT_DIFF_FLAGS, ...GIT_LOG_FLAGS, ...GIT_REV_SELECT_FLAGS),
    withValue: { "-n": GIT_NUMBER },
    operands: true,
  },
  show: { flags: alt(...GIT_DIFF_FLAGS, ...GIT_LOG_FLAGS), operands: true },
  diff: {
    flags: alt(...GIT_DIFF_FLAGS, "--cached", "--staged", "--exit-code", "--quiet", "--check"),
    operands: true,
  },
  // List only: a name argument would create a branch, so no operand and no option that edits.
  branch: {
    flags: alt("-[arv]{1,4}", "--list", "--all", "--remotes", "--verbose", "--show-current"),
    operands: false,
  },
  "rev-parse": {
    flags: alt(
      "--show-toplevel",
      "--git-dir",
      "--absolute-git-dir",
      "--git-common-dir",
      "--is-inside-work-tree",
      "--is-inside-git-dir",
      "--is-bare-repository",
      "--show-prefix",
      "--show-cdup",
      "--abbrev-ref",
      "--short(=\\d{1,2})?",
      "--verify",
      "--symbolic",
      "--symbolic-full-name",
    ),
    operands: true,
  },
  "ls-files": {
    flags: alt(
      "-[cmodsuivzt]{1,6}",
      "--cached",
      "--modified",
      "--others",
      "--deleted",
      "--stage",
      "--unmerged",
      "--ignored",
      "--exclude-standard",
      "--full-name",
      "--deduplicate",
      "--eol",
      "--directory",
      "--no-empty-directory",
    ),
    operands: true,
  },
  blame: {
    flags: alt(
      "-[lsewtfnp]{1,4}",
      "--porcelain",
      "--line-porcelain",
      "--show-email",
      "--show-name",
      "--show-number",
      "--abbrev=\\d{1,2}",
      "-M",
      "-w",
    ),
    withValue: { "-L": /^\d{1,7}(,[+-]?\d{1,7})?$/ },
    operands: true,
  },
};

/** `%G…` placeholders make git run its gpg program: not in a quiet format string. */
const GIT_GPG_FORMAT = /^(--pretty|--format)=.*%G/s;

/**
 * `git <subcommand> …` from the allowlist: no option before the subcommand (`-c`, `-C`,
 * `--git-dir`, `--work-tree`, `--exec-path`, `--config-env`, `--no-pager`… are all refused),
 * only the flags listed for that subcommand, and every revision or pathspec inside the folder.
 */
const gitRule: Rule = (args, cwd) => {
  const [sub, ...rest] = args;
  if (sub === undefined) return "git needs a subcommand";
  if (sub === "remote") {
    return rest.length === 0 || (rest.length === 1 && /^(-v|--verbose)$/.test(rest[0] as string))
      ? { paths: [] }
      : "only `git remote` and `git remote -v` are read-only";
  }
  const spec = Object.hasOwn(GIT_SPECS, sub) ? GIT_SPECS[sub] : undefined;
  if (spec === undefined) return `git ${sub} is not in the read-only set`;
  const paths: string[] = [];
  let flagsDone = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (!flagsDone && a === "--") {
      if (!spec.operands) return `git ${sub} takes no operands`;
      flagsDone = true;
      continue;
    }
    if (!flagsDone && a.startsWith("-")) {
      const valueRule =
        spec.withValue !== undefined && Object.hasOwn(spec.withValue, a)
          ? spec.withValue[a]
          : undefined;
      if (valueRule !== undefined) {
        const next = rest[i + 1];
        if (next === undefined || !valueRule.test(next)) {
          return `${a} needs a plain value`;
        }
        i++;
        continue;
      }
      if (!spec.flags.test(a)) return `git ${sub} ${a} is not in the read-only set`;
      if (GIT_GPG_FORMAT.test(a)) return `${a} would run gpg`;
      continue;
    }
    if (!spec.operands) return `git ${sub} takes no operands (a name would create a branch)`;
    if (!insideCwd(a, cwd)) return `${a} is outside the folder`;
    // No shell runs this, but an operand that reads as shell syntax is a model mistake or an
    // attempt: it asks. Globs (`*.ts`) and revision syntax (`HEAD@{1}`, `a..b`, `~`, `^`) stay.
    if (/[\s;&|<>`$()\\'"]/.test(a)) return `${a} looks like shell syntax`;
    paths.push(a);
  }
  return { paths };
};

const RULES: Readonly<Record<string, Rule>> = {
  git: gitRule,
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
  // POSIX paths for the system binaries under srt: a Windows cwd (`C:\…`) is never read-only
  // (there is no srt there, and `\` would be a separator this check does not see).
  if (!posix.isAbsolute(cwd)) return no("cwd must be absolute");
  const [program, ...args] = argv as string[];
  if (program === undefined || program.includes("/")) {
    return no("only a bare program name from the system folders is read-only");
  }
  const rule = RULES[program];
  if (rule === undefined) return no(`${program} is not in the read-only set`);
  for (const a of argv as string[]) {
    if (/[\0\n\r]/.test(a)) return no("argv contains a control character");
    if (!a.startsWith("-") && !a.startsWith("+") && a.includes(":")) return no(`${a} contains ":"`);
    // git's own allowlist decides its flags (`ls-files -o` lists untracked files; `diff`/`log`
    // have no `-o`/`--output` in it).
    if (program !== "git" && WRITE_OR_EXEC_FLAGS.test(a))
      return no(`${a} writes a file or runs a program`);
    const base = a.split("/").at(-1) ?? a;
    if (INTERPRETERS.has(a) || INTERPRETERS.has(base)) return no(`${a} is an interpreter`);
  }
  const out = rule(args, cwd);
  return typeof out === "string" ? no(out) : { readOnly: true, program, paths: out.paths };
}
