import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type MemoryClaim, PsycheError } from "@psyche/protocol";
import { stripComments } from "./chunker.ts";
import { applyDailyWrite, oneLine } from "./daily.ts";
import { blockingKinds, looksLikeInstruction } from "./filters.ts";
import { dailyNoteDate, TEMPLATE_FILES } from "./layout.ts";
import type { SqliteMemoryStore } from "./store.ts";

/**
 * Memory import (feature H7; security §8 "Import validation"). Imports are data: every item
 * becomes a claim with `agent` provenance, is scanned for instruction-like text (flagged), is
 * size-capped, and is promoted to `owner` only item by item when the owner confirms it
 * (`confirmClaim`). Items are also written to `memory/imports/<format>-<date>.md` so they are
 * searchable and visible in the workspace.
 */

export type ImportFormat = "chatgpt" | "claude" | "text" | "openclaw";

export const IMPORT_LIMITS = {
  /** Characters of export text accepted. */
  inputChars: 2_000_000,
  items: 500,
  itemChars: 500,
  files: 2_000,
  fileChars: 1_000_000,
} as const;

export interface ImportItem {
  text: string;
  kind: MemoryClaim["kind"];
  flagged: boolean;
}

export interface ImportResult {
  claims: MemoryClaim[];
  flagged: string[];
  files: string[];
  skipped: number;
}

const TEXT_KEYS = ["content", "text", "memory", "value", "fact", "summary"];

/** Collects memory strings from the JSON shapes ChatGPT and Claude exports use. */
function collectJsonStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > IMPORT_LIMITS.items * 4) return;
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectJsonStrings(v, out, depth + 1);
  } else if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const direct = TEXT_KEYS.map((k) => obj[k]).find((v) => typeof v === "string");
    if (typeof direct === "string") {
      out.push(direct);
      return;
    }
    for (const key of ["memories", "memory", "items", "entries", "data", "results"]) {
      if (key in obj) collectJsonStrings(obj[key], out, depth + 1);
    }
  }
}

/** Splits prose into candidate facts: bullets and lines, long paragraphs by sentence. */
function splitText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/^#+\s.*$/, "")
      .trim();
    // Skip empty template fields such as "- Name:".
    if (line.length === 0 || /^[^:]{1,40}:$/.test(line)) continue;
    if (line.length <= IMPORT_LIMITS.itemChars) {
      out.push(line);
      continue;
    }
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

/** Heuristic claim kind; the owner can correct it on review. */
export function guessKind(text: string): MemoryClaim["kind"] {
  const t = text.toLowerCase();
  if (/\b(call me|don't|do not|never|always|stop|please)\b/.test(t)) return "directive";
  if (/\b(prefers?|likes?|loves?|hates?|dislikes?|favou?rite|enjoys?)\b/.test(t)) {
    return "preference";
  }
  if (
    /\b(wife|husband|partner|mother|mom|father|dad|sister|brother|son|daughter|friend|boss|manager|colleague|teacher)\b/.test(
      t,
    )
  ) {
    return "relationship";
  }
  if (
    /\b(\d{4}-\d{2}-\d{2}|on (mon|tues|wednes|thurs|fri|satur|sun)day|next week|tomorrow)\b/.test(t)
  ) {
    return "event";
  }
  return "fact";
}

/** Parses an export into items (no writes). */
export function parseImport(
  format: Exclude<ImportFormat, "openclaw">,
  content: string,
): {
  items: ImportItem[];
  skipped: number;
} {
  if (content.length > IMPORT_LIMITS.inputChars) {
    throw new PsycheError("invalid_params", "import is too large");
  }
  let strings: string[] | undefined;
  const trimmed = content.trim();
  if (format !== "text" && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      strings = [];
      collectJsonStrings(parsed, strings);
    } catch {
      strings = undefined; // not JSON after all: treat as text
    }
  }
  // Valid JSON with no memory strings imports nothing (never the raw JSON text).
  const candidates = (strings ?? [stripComments(content)]).flatMap(splitText);
  const items: ImportItem[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const raw of candidates) {
    const text = oneLine(raw);
    const key = text.toLowerCase();
    if (text.length < 3 || seen.has(key)) continue;
    seen.add(key);
    if (
      text.length > IMPORT_LIMITS.itemChars ||
      items.length >= IMPORT_LIMITS.items ||
      blockingKinds(text, false).length > 0
    ) {
      skipped++;
      continue;
    }
    items.push({ text, kind: guessKind(text), flagged: looksLikeInstruction(text) });
  }
  return { items, skipped };
}

async function stageItems(
  store: SqliteMemoryStore,
  format: ImportFormat,
  items: readonly ImportItem[],
  dryRun: boolean,
): Promise<{ claims: MemoryClaim[]; flagged: string[]; file?: string }> {
  if (items.length === 0) return { claims: [], flagged: [] };
  const path = `memory/imports/${format}-${store.now().date}.md`;
  if (dryRun) return { claims: [], flagged: [], file: path };
  const existing = (await store.readFile(path))?.content;
  const header = existing ?? `# Imported from ${format} on ${store.now().date}\n\n`;
  const body = items.map((i) => `- ${i.flagged ? "[flagged] " : ""}${i.text}`).join("\n");
  await store.write(path, `${header}${header.endsWith("\n") ? "" : "\n"}${body}\n`, {
    provenance: "agent",
    actor: "job",
    source: "job",
  });
  const claims: MemoryClaim[] = [];
  const flagged: string[] = [];
  for (const item of items) {
    const claim = await store.addClaim({
      text: item.text,
      kind: item.kind,
      provenance: "agent",
      confidence: item.flagged ? 0.2 : 0.5,
      sources: [path],
    });
    claims.push(claim);
    if (item.flagged) flagged.push(claim.id);
  }
  return { claims, flagged, file: path };
}

/** Imports a ChatGPT / Claude memory export or free text. */
export async function importMemory(
  store: SqliteMemoryStore,
  format: Exclude<ImportFormat, "openclaw">,
  content: string,
  options: { dryRun?: boolean } = {},
): Promise<ImportResult> {
  const job = options.dryRun === true ? undefined : store.startJob("import");
  try {
    const { items, skipped } = parseImport(format, content);
    const staged = await stageItems(store, format, items, options.dryRun === true);
    if (job !== undefined)
      store.finishJob(job, "ok", `${format}: ${items.length} staged, ${skipped} skipped`);
    return {
      claims: staged.claims,
      flagged: staged.flagged,
      files: staged.file === undefined ? [] : [staged.file],
      skipped,
    };
  } catch (err) {
    if (job !== undefined) store.finishJob(job, "failed", `${format} import failed`);
    throw err;
  }
}

/** Reads an OpenClaw workspace folder into `{path, content}` pairs (CLI and desktop use). */
export function readWorkspaceFolder(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const visit = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".") || out.length >= IMPORT_LIMITS.files) continue;
      const child = join(abs, e.name);
      if (e.isDirectory()) visit(child);
      else if (
        e.isFile() &&
        e.name.endsWith(".md") &&
        statSync(child).size <= IMPORT_LIMITS.fileChars
      ) {
        out.push({
          path: relative(dir, child).split(sep).join("/"),
          content: readFileSync(child, "utf8"),
        });
      }
    }
  };
  visit(dir);
  return out;
}

/**
 * Imports an OpenClaw workspace (ADR-018: same names and roles). A file lands under its own
 * name only when the workspace has no such file or still holds the untouched template;
 * otherwise it goes to `memory/imports/openclaw/<path>` for the owner to merge. Bullets of
 * `USER.md` and `MEMORY.md` are staged as agent claims like any other import.
 */
export async function importOpenClaw(
  store: SqliteMemoryStore,
  files: readonly { path: string; content: string }[],
  options: { dryRun?: boolean } = {},
): Promise<ImportResult> {
  if (files.length > IMPORT_LIMITS.files) throw new PsycheError("invalid_params", "too many files");
  const job = options.dryRun === true ? undefined : store.startJob("import");
  try {
    const result = await importOpenClawFiles(store, files, options.dryRun === true);
    if (job !== undefined) {
      store.finishJob(
        job,
        "ok",
        `openclaw: ${result.files.length} files, ${result.claims.length} staged, ${result.skipped} skipped`,
      );
    }
    return result;
  } catch (err) {
    if (job !== undefined) store.finishJob(job, "failed", "openclaw import failed");
    throw PsycheError.from(err);
  }
}

async function importOpenClawFiles(
  store: SqliteMemoryStore,
  files: readonly { path: string; content: string }[],
  dryRun: boolean,
): Promise<ImportResult> {
  const written: string[] = [];
  const items: ImportItem[] = [];
  let skipped = 0;
  const templates = new Set<string>(TEMPLATE_FILES);
  for (const f of files) {
    let path: string;
    try {
      path = store.canonicalPath(f.path);
    } catch {
      skipped++;
      continue;
    }
    if (
      !path.endsWith(".md") ||
      f.content.length > IMPORT_LIMITS.fileChars ||
      path === "BOOTSTRAP.md" ||
      blockingKinds(f.content, true).length > 0
    ) {
      skipped++;
      continue;
    }
    const current = await store.readFile(path);
    const untouchedTemplate =
      current !== undefined && templates.has(path) && store.isUnmodifiedTemplate(path);
    // An existing file (including a daily note) is never overwritten: the import goes beside it.
    // Skills are never installed by an import (security §11 needs a scan and an approval): they
    // land as notes for the owner to install through the skills flow.
    const target =
      (current === undefined || untouchedTemplate) && !path.startsWith("skills/")
        ? path
        : `memory/imports/openclaw/${path}`;
    if (path === "USER.md" || path === "MEMORY.md") {
      items.push(...parseImport("text", f.content).items);
    }
    written.push(target);
    if (dryRun) continue;
    // Imported daily notes keep their entries but no imported tag outranks `agent`.
    const content =
      dailyNoteDate(path) !== undefined
        ? applyDailyWrite(undefined, f.content, { provenance: "agent" }, "00:00")
        : f.content;
    await store.write(target, content, {
      // Persona files keep their role but are marked agent: nothing imported is an owner fact
      // until the owner confirms it.
      provenance: "agent",
      actor: "job",
      source: "job",
    });
  }
  const staged = await stageItems(store, "openclaw", items, dryRun);
  return {
    claims: staged.claims,
    flagged: staged.flagged,
    files: staged.file === undefined ? written : [...written, staged.file],
    skipped,
  };
}

/**
 * The owner confirms a staged claim: a new `owner` claim supersedes it. Refused (`policy_denied`)
 * when the claim derives from untrusted or system content.
 */
export async function confirmClaim(
  store: SqliteMemoryStore,
  claimId: string,
): Promise<MemoryClaim> {
  const claim = store.getClaim(claimId);
  if (claim === undefined || typeof claim.retractedAt === "string") {
    throw new PsycheError("not_found", "no such claim");
  }
  if (claim.provenance === "owner") return claim;
  // Confirming twice returns the owner claim made the first time.
  if (typeof claim.supersededBy === "string") {
    const successor = store.getClaim(claim.supersededBy);
    if (successor?.provenance === "owner" && typeof successor.retractedAt !== "string") {
      return successor;
    }
  }
  if (claim.provenance === "untrusted" || claim.provenance === "system") {
    throw new PsycheError(
      "policy_denied",
      "untrusted or system content cannot become an owner claim",
    );
  }
  return store.addClaim({
    text: claim.text,
    kind: claim.kind,
    provenance: "owner",
    confidence: Math.max(claim.confidence, 0.9),
    sources: [`claim:${claim.id}`],
    supersedes: claim.id,
  });
}
