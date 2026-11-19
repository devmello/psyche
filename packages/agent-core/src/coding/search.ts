import { constants, type Dirent } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { sameHostPath } from "@psyche/hostfs";
import { PsycheError } from "@psyche/protocol";
import { assertContained } from "./contain.ts";
import { relativeTo } from "./workspace.ts";

/** `code.search` bounds: files read, bytes per file, folder depth, hits, characters per hit. */
export const CODE_SEARCH_LIMITS = {
  files: 20_000,
  fileBytes: 1024 * 1024,
  depth: 24,
  matches: 500,
  lineChars: 300,
  /** Characters of one line a pattern is tested on (minified bundles stay cheap). */
  testChars: 4000,
};

/**
 * JavaScript regexes backtrack, and a pattern from a tainted turn runs in the Gateway process:
 * a quantified group that itself holds a quantifier (`(a+)+`, `(x*y?)*`) is refused, the
 * classic catastrophic-backtracking shape. ripgrep's engine has no such case; this keeps ours
 * close enough for code search.
 */
export function riskyRegex(pattern: string): boolean {
  return (
    /\((?:[^()\\]|\\.)*[+*}?](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern) || /\\[1-9]/.test(pattern)
  );
}

/** Never searched: version control internals and dependency or build output. */
export const SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".next",
  "dist",
  "build",
  "target",
  "coverage",
]);

/** A small glob → RegExp: `**` any folders, `*` within a name, `?` one char, `{a,b}` either. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        const alts = glob.slice(i + 1, end).split(",");
        re += `(?:${alts.map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // A glob without a slash matches the file name anywhere (ripgrep's `-g '*.ts'`).
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}

export interface CodeSearchInput {
  /** Real path of the folder to search (the root or a folder under it). */
  dir: string;
  root: string;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  globs: string[];
  maxResults: number;
  signal?: AbortSignal;
}

export interface CodeSearchResult {
  matches: { path: string; line: number; column: number; text: string }[];
  filesSearched: number;
  truncated: boolean;
}

/**
 * One file of the walk, or `undefined` to skip it. `O_NONBLOCK`: a file swapped for a FIFO after
 * the listing does not hang a thread of the pool on open; `fstat` then skips anything that is not
 * a regular file, and a file with other hard links (another name for a file anywhere on the
 * volume, which no realpath shows).
 */
async function readSmall(path: string): Promise<Buffer | undefined> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink > 1 || st.size > CODE_SEARCH_LIMITS.fileBytes) return undefined;
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/**
 * A folder of the walk is still its own real path. Checked after it is listed and again after its
 * files are read: a folder swapped for a link meanwhile ends the search with nothing returned.
 */
async function assertStillReal(dir: string): Promise<void> {
  const real = await realpath(dir).catch(() => undefined);
  if (real === undefined || !sameHostPath(real, dir)) {
    throw new PsycheError(
      "forbidden",
      `${dir} moved or became a symlink during the search; search again`,
      {
        details: { reason: "symlink_escape" },
      },
    );
  }
}

/**
 * ripgrep-style search over a workspace: sorted walk, no symlinks, no binaries. The folder to
 * search must be inside the root by its real path, with no link on the way (`contain.ts`); the
 * walk never descends into a linked folder or opens a linked file.
 */
export async function searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
  let re: RegExp;
  if (input.regex && riskyRegex(input.pattern)) {
    throw new PsycheError(
      "invalid_params",
      "pattern: nested quantifiers and backreferences are not supported; simplify the pattern",
    );
  }
  try {
    const source = input.regex
      ? input.pattern
      : input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(source, input.caseSensitive ? "" : "i");
  } catch (err) {
    throw new PsycheError("invalid_params", `pattern: ${(err as Error).message}`);
  }
  await assertContained(input.root, input.dir);
  const include = input.globs.filter((g) => !g.startsWith("!")).map(globToRegExp);
  const exclude = input.globs.filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1)));
  const matches: CodeSearchResult["matches"] = [];
  let files = 0;
  let truncated = false;
  const queue: { dir: string; depth: number }[] = [{ dir: input.dir, depth: 0 }];
  /** The folder whose files are being read, re-checked when the walk leaves it (`break` too). */
  let reading: string | undefined;
  walk: while (queue.length > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === input.dir)
        throw new PsycheError("not_found", `${dir}: ${(err as Error).message}`);
      continue;
    }
    await assertStillReal(dir);
    reading = dir;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (input.signal?.aborted) throw new PsycheError("cancelled", "cancelled");
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIPPED_DIRS.has(e.name)) continue;
        if (depth + 1 > CODE_SEARCH_LIMITS.depth) truncated = true;
        else queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relativeTo(input.root, full);
      if (include.length > 0 && !include.some((g) => g.test(rel))) continue;
      if (exclude.some((g) => g.test(rel))) continue;
      if (files >= CODE_SEARCH_LIMITS.files) {
        truncated = true;
        break walk;
      }
      files++;
      const buf = await readSmall(full);
      if (buf === undefined || buf.includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const m = re.exec(line.slice(0, CODE_SEARCH_LIMITS.testChars));
        if (m === null) continue;
        const text =
          line.length > CODE_SEARCH_LIMITS.lineChars
            ? `${line.slice(0, CODE_SEARCH_LIMITS.lineChars)}…`
            : line;
        matches.push({ path: rel, line: i + 1, column: m.index + 1, text });
        if (matches.length >= input.maxResults) {
          truncated = true;
          break walk;
        }
      }
    }
    await assertStillReal(dir);
    reading = undefined;
  }
  if (reading !== undefined) await assertStillReal(reading);
  return { matches, filesSearched: files, truncated };
}
