import { PsycheError } from "@psyche/protocol";

/**
 * Unified diffs for `code.edit` (V10): the model sends a patch, the owner approves that exact
 * text (the card shows it as a diff), and the executor applies it hunk by hunk with exact
 * context. Git-style headers (`diff --git`, `index`, `a/` and `b/` prefixes) are accepted; a
 * new file comes from `/dev/null`. Deleting files, renames, mode changes and binary patches are
 * refused: they are not edits a card can show line by line.
 */

export interface Hunk {
  /** 1-based line where the hunk starts in the old file (0 for an empty old file). */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines with their prefix: ` ` context, `-` removed, `+` added. */
  lines: string[];
}

export interface FilePatch {
  /** Path relative to the workspace root, without `a/` / `b/`. */
  path: string;
  create: boolean;
  hunks: Hunk[];
}

/** Files one patch may touch, and lines of one patch. */
export const PATCH_LIMITS = { files: 50, lines: 20_000 };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function invalid(message: string): never {
  throw new PsycheError("invalid_params", `patch: ${message}`);
}

/** `a/src/x.ts` → `src/x.ts`; a tab-separated timestamp after the name is dropped. */
function headerPath(raw: string): string | null {
  const name = raw.split("\t")[0]?.trim() ?? "";
  if (name === "/dev/null") return null;
  if (name.startsWith('"')) invalid(`quoted file names are not supported: ${name}`);
  return name.replace(/^[ab]\//, "");
}

/** Parses a unified diff into per-file hunks; throws `invalid_params` on anything else. */
export function parsePatch(text: string): FilePatch[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > PATCH_LIMITS.lines) invalid(`more than ${PATCH_LIMITS.lines} lines`);
  const files: FilePatch[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (
      /^(deleted file mode|new mode|old mode|rename from|rename to|copy from|copy to)/.test(line)
    ) {
      invalid(`"${line}" is not supported; send content changes only`);
    }
    if (line.startsWith("GIT binary patch") || line.startsWith("Binary files")) {
      invalid("binary patches are not supported");
    }
    if (!line.startsWith("--- ")) {
      i++;
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (!next.startsWith("+++ ")) invalid(`"--- " at line ${i + 1} is not followed by "+++ "`);
    const from = headerPath(line.slice(4));
    const to = headerPath(next.slice(4));
    if (to === null) invalid("deleting files is not supported");
    if (from !== null && from !== to) invalid(`renames are not supported (${from} → ${to})`);
    const file: FilePatch = { path: to, create: from === null, hunks: [] };
    i += 2;
    while (i < lines.length && HUNK.test(lines[i] ?? "")) {
      const m = HUNK.exec(lines[i] ?? "") as RegExpExecArray;
      const hunk: Hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      i++;
      let old = 0;
      let added = 0;
      while (i < lines.length && (old < hunk.oldLines || added < hunk.newLines)) {
        const l = lines[i] ?? "";
        if (l.startsWith("\\")) {
          i++;
          continue;
        }
        const tag = l === "" ? " " : l[0];
        if (tag === " ") {
          old++;
          added++;
        } else if (tag === "-") old++;
        else if (tag === "+") added++;
        else invalid(`unexpected line in hunk at line ${i + 1}: ${JSON.stringify(l.slice(0, 80))}`);
        hunk.lines.push(l === "" ? " " : l);
        i++;
      }
      if (old !== hunk.oldLines || added !== hunk.newLines) {
        invalid(`hunk at line ${hunk.oldStart} of ${to} has the wrong line counts`);
      }
      // "\ No newline at end of file" after the last line of a hunk.
      while (i < lines.length && (lines[i] ?? "").startsWith("\\")) i++;
      file.hunks.push(hunk);
    }
    if (file.hunks.length === 0) invalid(`${to} has no hunks`);
    if (file.create && file.hunks.some((h) => h.oldLines !== 0)) {
      invalid(`${to} comes from /dev/null but its hunks remove lines`);
    }
    if (files.some((f) => f.path === file.path)) invalid(`${to} appears twice`);
    files.push(file);
    if (files.length > PATCH_LIMITS.files) invalid(`more than ${PATCH_LIMITS.files} files`);
  }
  if (files.length === 0) invalid('no file headers ("--- a/path" / "+++ b/path") found');
  return files;
}

/**
 * Applies one file's hunks to its text. Each hunk must match its context and removed lines
 * exactly; it is searched near its stated line first, then anywhere after the previous hunk
 * (offsets from earlier edits), and a hunk that matches nowhere refuses the whole patch.
 */
export function applyFilePatch(before: string, patch: FilePatch): string {
  const endsWithNewline = before === "" || before.endsWith("\n");
  const src = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of patch.hunks) {
    const old = hunk.lines.filter((l) => l[0] !== "+").map((l) => l.slice(1));
    const repl = hunk.lines.filter((l) => l[0] !== "-").map((l) => l.slice(1));
    const matchesAt = (at: number) =>
      at >= cursor && at + old.length <= src.length && old.every((l, k) => src[at + k] === l);
    const want = Math.max(hunk.oldStart - 1, 0);
    let at = -1;
    if (old.length === 0) at = Math.max(Math.min(want, src.length), cursor);
    else if (matchesAt(want)) at = want;
    else {
      for (let k = cursor; k + old.length <= src.length; k++) {
        if (matchesAt(k)) {
          at = k;
          break;
        }
      }
    }
    if (at < 0) {
      throw new PsycheError(
        "conflict",
        `patch: the hunk at line ${hunk.oldStart} of ${patch.path} does not match the file; read it again`,
      );
    }
    out.push(...src.slice(cursor, at), ...repl);
    cursor = at + old.length;
  }
  out.push(...src.slice(cursor));
  if (out.length === 0) return "";
  return `${out.join("\n")}${endsWithNewline ? "\n" : ""}`;
}

/** Lines added and removed, for the card summary and the receipt. */
export function patchStats(files: readonly FilePatch[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l[0] === "+") added++;
        else if (l[0] === "-") removed++;
      }
    }
  }
  return { added, removed };
}
