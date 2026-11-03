import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { PowerState } from "./manager.ts";
import type { SourceAdapter, SourceItem } from "./types.ts";

/**
 * Files in the folders the owner granted (#962) as a search source: text, Markdown and code are
 * read directly, PDF, DOCX and XLSX go through the files package's extractors (worker thread,
 * capped heap). Scanned PDFs and images need OCR (roadmap §3.4): `ocr` is the Mac helper's Apple
 * Vision (on-device), opt-in per source. While it is undefined or off those files are indexed by
 * name only. OCR is throttled: one file at a time, only on power and outside low-power mode, a
 * page budget per pull, and a file the budget or the power state skipped is remembered in the
 * cursor and read on a later pull. The text keeps the provenance of its file.
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
/** Recognised pages per pull (about 0.3 s each on Apple Silicon). */
const OCR_PAGES_PER_PULL = 10;
/** Largest image or PDF sent to OCR. */
const OCR_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Files waiting for OCR that the cursor remembers; more are caught by a Rebuild. */
const OCR_MAX_PENDING = 5000;

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
  /** Apple Vision OCR in the Mac helper (`ocr.recognize`), when it offers one. */
  ocr?: FilesOcr;
  now?: () => number;
}

/** Text recognised in an image or in the image-only pages of a PDF. */
export interface OcrText {
  text: string;
  /** Pages recognised (a PDF page with a text layer is not one). */
  pages: number;
}

export interface FilesOcr {
  /** The owner's switch (Settings → Search sources), read on every pull. */
  enabled: () => boolean;
  /** Battery state: nothing is recognised on battery or in low-power mode. Unknown = on power. */
  power?: () => PowerState;
  /**
   * The owner's "Index on battery" setting: on, recognition also runs on battery (never in
   * low-power mode). Read on every pull.
   */
  runOnBattery?: () => boolean;
  /**
   * Recognises one file, whole (an image, or a PDF's image-only pages: the helper reads the text
   * layer of each page and recognises those with fewer than 30 characters). Undefined when
   * nothing can be read; throws when the helper fails.
   */
  recognize: (path: string, signal: AbortSignal) => Promise<OcrText | undefined>;
  /** Recognised pages per pull (default 10). */
  pagesPerPull?: number;
  /** Larger files are not sent (default 25 MB). */
  maxFileBytes?: number;
}

interface Cursor {
  mtime?: number;
  path?: string;
  /** Files whose OCR was skipped (battery, budget); read when power and budget allow. */
  ocr?: string[];
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

  /** Whether OCR may run now: the switch is on and the Mac is on power (or battery, if the owner allows it) outside low-power mode. */
  const ocrReady = (): boolean => {
    const o = deps.ocr;
    if (o === undefined || !o.enabled()) return false;
    const power = o.power?.();
    return (
      power === undefined || (!power.lowPower && (!power.onBattery || o.runOnBattery?.() === true))
    );
  };

  /** What one pull has left to spend on OCR. */
  interface Budget {
    left: number;
    /** Files OCR skipped this pull for want of power or budget. */
    skipped: string[];
  }

  const read = async (e: Entry, signal: AbortSignal, budget: Budget): Promise<string> => {
    const ext = extname(e.path).slice(1).toLowerCase();
    const ocr = deps.ocr;
    const wantsOcr = ocr !== undefined && ocr.enabled() && (ext === "pdf" || OCR_EXT.has(ext));
    /** Recognised text, or undefined when OCR was skipped (the file is queued) or failed. */
    const recognise = async (): Promise<OcrText | undefined> => {
      if (ocr === undefined || e.size > (ocr.maxFileBytes ?? OCR_MAX_FILE_BYTES)) return undefined;
      if (!ocrReady() || budget.left <= 0) {
        budget.skipped.push(e.path);
        return undefined;
      }
      const out = await ocr.recognize(e.path, signal).catch(() => undefined);
      // An image costs a page even when nothing was found, so failures cannot spin.
      budget.left -= out?.pages ?? (ext === "pdf" ? 0 : 1);
      return out;
    };
    try {
      if (DOC_EXT.has(ext)) {
        const text = (await deps.extractDocument?.(e.path, signal)) ?? "";
        if (ext === "pdf" && wantsOcr) {
          // Pages with a text layer of 30+ characters keep it; the helper reads the rest.
          const out = await recognise();
          const merged = out === undefined ? text : `${text}\n${out.text}`;
          return merged.slice(0, MAX_CHARS);
        }
        return text.slice(0, MAX_CHARS);
      }
      if (OCR_EXT.has(ext)) return ((await recognise())?.text ?? "").slice(0, MAX_CHARS);
      if (e.size > MAX_TEXT_BYTES) return "";
      return (await readFile(e.path, "utf8")).slice(0, MAX_CHARS);
    } catch {
      return "";
    }
  };

  const itemOf = (e: Entry, body: string): SourceItem => ({
    nativeId: e.path,
    title: basename(e.path),
    text: `Path: ${e.path}\n${body}`,
    createdAt: e.mtime,
    // Downloads come from third parties; anything else in a granted folder is the owner's.
    // Text read from an image or a scan keeps the provenance of its file.
    provenance: /\/Downloads(\/|$)/.test(e.path) ? "untrusted" : "owner",
    tags: ["file", extname(e.path).slice(1).toLowerCase()],
    path: e.path,
  });

  return {
    id: "files",
    invalidate: () => {
      listing = undefined;
    },
    unavailable: () => (deps.folders().length === 0 ? "no folder has been shared" : undefined),
    async pull(raw, { signal, limit }) {
      const c = (raw ?? {}) as Cursor;
      const after = (e: Entry) =>
        c.mtime === undefined ||
        e.mtime > c.mtime ||
        (e.mtime === c.mtime && e.path > (c.path ?? ""));
      const { entries } = await walk(signal);
      const todo = entries.filter(after);
      const page = todo.slice(0, Math.min(limit, 40));
      const budget: Budget = { left: deps.ocr?.pagesPerPull ?? OCR_PAGES_PER_PULL, skipped: [] };
      const items: SourceItem[] = [];
      for (const e of page) items.push(itemOf(e, await read(e, signal, budget)));
      // Files skipped earlier (on battery, over budget): read them now that OCR may run again.
      const byPath = new Map(entries.map((e) => [e.path, e]));
      const waiting = (c.ocr ?? []).filter((p) => byPath.has(p));
      let retried = 0;
      if (ocrReady()) {
        for (const p of waiting) {
          const e = byPath.get(p);
          if (e === undefined || budget.left <= 0 || signal.aborted) break;
          items.push(itemOf(e, await read(e, signal, budget)));
          retried += 1;
        }
      }
      // Skipped files wait in the cursor (only while the owner's switch is on).
      const queue =
        deps.ocr?.enabled() === true
          ? [...new Set([...waiting.slice(retried), ...budget.skipped])].slice(0, OCR_MAX_PENDING)
          : [];
      const last = page.at(-1);
      const mtime = last?.mtime ?? c.mtime;
      const path = last?.path ?? c.path;
      const cursor: Cursor = {
        ...(mtime === undefined ? {} : { mtime }),
        ...(path === undefined ? {} : { path }),
        ...(queue.length > 0 ? { ocr: queue } : {}),
      };
      return {
        items,
        cursor: raw === null && Object.keys(cursor).length === 0 ? raw : cursor,
        hasMore: todo.length > page.length || (queue.length > 0 && ocrReady() && budget.left <= 0),
      };
    },
    async listIds(signal) {
      listing = undefined;
      const { entries, complete } = await walk(signal);
      return { ids: entries.map((e) => e.path), complete };
    },
  };
}
