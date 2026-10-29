import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { SourceAdapter, SourceItem } from "./types.ts";

/**
 * Files in the folders the owner granted (#962) as a search source: text, Markdown and code are
 * read directly, PDF, DOCX and XLSX go through the files package's extractors (worker thread,
 * capped heap). Scanned PDFs and images need OCR; the mac-helper has no OCR capability yet, so
 * `ocr` is a hook: while it is undefined those files are indexed by name only.
 */

const TEXT_EXT = new Set(
  (
    "txt md markdown mdx rst org csv tsv json jsonl yaml yml toml ini cfg conf log xml html htm " +
    "css scss js jsx mjs cjs ts tsx py rb go rs java kt swift c h cpp hpp cs php sh zsh sql tex " +
    "bib srt vtt ics"
  ).split(" "),
);
const DOC_EXT = new Set(["pdf", "docx", "docm", "xlsx", "xlsm"]);
const OCR_EXT = new Set(["png", "jpg", "jpeg", "heic", "tiff", "tif", "gif", "webp"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv"]);
/** Text kept per file; the index caps the body too. */
const MAX_CHARS = 200_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 100_000;
const MIN_PDF_TEXT = 30;
const LISTING_TTL_MS = 30_000;

export interface FilesSourceDeps {
  /** The granted folders, read on every pass so a revoked grant applies at once. */
  folders: () => readonly { path: string }[];
  /** True for a path no grant opens (`~/.psyche`, credential stores); such paths are skipped. */
  isProtected?: (path: string) => boolean;
  /**
   * Text of a PDF, DOCX or XLSX file (the files package's extractors), or undefined when the path
   * is not such a document. Without it those files are indexed by name.
   */
  extractDocument?: (path: string, signal: AbortSignal) => Promise<string | undefined>;
  /** Apple Vision OCR in the mac-helper, when it offers one (`ocr.recognize`); not available yet. */
  ocr?: (path: string, signal: AbortSignal) => Promise<string | undefined>;
  now?: () => number;
}

interface Entry {
  path: string;
  mtime: number;
  size: number;
}

export function filesAdapter(deps: FilesSourceDeps): SourceAdapter & { invalidate(): void } {
  let listing: { at: number; entries: Entry[]; complete: boolean } | undefined;
  const now = deps.now ?? Date.now;

  const walk = async (signal: AbortSignal) => {
    if (listing !== undefined && now() - listing.at < LISTING_TTL_MS) return listing;
    const entries: Entry[] = [];
    let complete = true;
    const visit = async (dir: string): Promise<void> => {
      if (signal.aborted) throw new Error("cancelled");
      let names: Dirent[];
      try {
        names = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names) {
        if (d.name.startsWith(".") || d.isSymbolicLink()) continue;
        const path = join(dir, d.name);
        if (deps.isProtected?.(path) === true) continue;
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name)) await visit(path);
        } else if (d.isFile()) {
          if (entries.length >= MAX_FILES) {
            complete = false;
            return;
          }
          const ext = extname(d.name).slice(1).toLowerCase();
          if (!TEXT_EXT.has(ext) && !DOC_EXT.has(ext) && !OCR_EXT.has(ext)) continue;
          const st = await lstat(path).catch(() => undefined);
          if (st !== undefined) entries.push({ path, mtime: st.mtimeMs, size: st.size });
        }
      }
    };
    for (const f of deps.folders()) await visit(f.path);
    entries.sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : 1));
    listing = { at: now(), entries, complete };
    return listing;
  };

  const read = async (e: Entry, signal: AbortSignal): Promise<string> => {
    const ext = extname(e.path).slice(1).toLowerCase();
    try {
      if (DOC_EXT.has(ext)) {
        const text = (await deps.extractDocument?.(e.path, signal)) ?? "";
        if (ext === "pdf" && text.trim().length < MIN_PDF_TEXT && deps.ocr !== undefined)
          return (await deps.ocr(e.path, signal).catch(() => undefined)) ?? text;
        return text.slice(0, MAX_CHARS);
      }
      if (OCR_EXT.has(ext)) return (await deps.ocr?.(e.path, signal).catch(() => undefined)) ?? "";
      if (e.size > MAX_TEXT_BYTES) return "";
      return (await readFile(e.path, "utf8")).slice(0, MAX_CHARS);
    } catch {
      return "";
    }
  };

  return {
    id: "files",
    invalidate: () => {
      listing = undefined;
    },
    unavailable: () => (deps.folders().length === 0 ? "no folder has been shared" : undefined),
    async pull(raw, { signal, limit }) {
      const c = raw as { mtime?: number; path?: string } | null;
      const after = (e: Entry) =>
        c?.mtime === undefined ||
        e.mtime > c.mtime ||
        (e.mtime === c.mtime && e.path > (c.path ?? ""));
      const { entries } = await walk(signal);
      const todo = entries.filter(after);
      const page = todo.slice(0, Math.min(limit, 40));
      const items: SourceItem[] = [];
      for (const e of page) {
        const ext = extname(e.path).slice(1).toLowerCase();
        const body = await read(e, signal);
        items.push({
          nativeId: e.path,
          title: basename(e.path),
          text: `Path: ${e.path}\n${body}`,
          createdAt: e.mtime,
          // Downloads come from third parties; anything else in a granted folder is the owner's.
          provenance: /\/Downloads(\/|$)/.test(e.path) ? "untrusted" : "owner",
          tags: ["file", ext],
          path: e.path,
        });
      }
      const last = page.at(-1);
      return {
        items,
        cursor: last === undefined ? raw : { mtime: last.mtime, path: last.path },
        hasMore: todo.length > page.length,
      };
    },
    async listIds(signal) {
      listing = undefined;
      const { entries, complete } = await walk(signal);
      return { ids: entries.map((e) => e.path), complete };
    },
  };
}
