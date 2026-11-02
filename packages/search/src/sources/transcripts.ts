import type { Provenance } from "@psyche/protocol";
import type { SourceAdapter, SourceItem, SourcePull } from "./types.ts";

/**
 * Meeting and voice-memo transcripts as a search source (docs/design/search-roadmap-2026.md §2,
 * "Meeting and voice transcripts"). The recording itself is already a Library document whose body
 * is the transcript; this source adds *speaker turns* as child documents (`parentId` = the
 * recording, so results collapse onto it): each chunk has a `from:` speaker, an `[mm:ss]` mark
 * when the transcript has one, and the recording's provenance (other people's words are
 * `untrusted`).
 */

export interface RecordingRef {
  /** Library item id. */
  id: string;
  name: string;
  /** Epoch ms. */
  createdAt: number;
  tags: string[];
  provenance: Extract<Provenance, "owner" | "untrusted">;
  /** The transcript (the item's text extract). */
  text: string;
}

export interface TranscriptsSourceDeps {
  /**
   * Recordings with a transcript, oldest first, created at or after `sinceMs`
   * (ties by id), at most `limit`. Reads the Library; never the audio.
   */
  recordings: (sinceMs: number, afterId: string | null, limit: number) => Promise<RecordingRef[]>;
}

export interface Turn {
  speaker?: string;
  /** `mm:ss` or `h:mm:ss` as written. */
  at?: string;
  text: string;
}

const CHUNK_CHARS = 1500;
/** `Maya: …`, `Speaker 2 [03:41]: …`, `[03:41] Maya: …` */
const TURN =
  /^\s*(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(?:([\p{L}][\p{L}\p{N} .'’-]{0,39}?)\s*(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\])?\s*:\s+)(.*)$/u;

/** A speaker label is a short run of capitalised words or numbers ("Maya", "Speaker 2"). */
function looksLikeName(label: string): boolean {
  const words = label.trim().split(/\s+/);
  return words.length <= 3 && words.every((w) => /^[\p{Lu}\d]/u.test(w));
}

/** Splits a transcript into speaker turns; text without labels becomes unlabeled paragraphs. */
export function splitTurns(text: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const m = TURN.exec(line);
    // "Note: …" style prose is not a speaker unless it looks like a short name.
    if (m !== null && looksLikeName(m[2] ?? "")) {
      const at = m[1] ?? m[3];
      turns.push({
        speaker: (m[2] ?? "").trim(),
        ...(at === undefined ? {} : { at }),
        text: m[4] ?? "",
      });
    } else if (turns.length > 0) {
      const last = turns[turns.length - 1] as Turn;
      last.text += `\n${line.trim()}`;
    } else {
      turns.push({ text: line.trim() });
    }
  }
  return turns;
}

/** Groups consecutive turns of one speaker, then cuts at ~1,500 characters on sentence ends. */
export function chunkTurns(turns: readonly Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (
      prev !== undefined &&
      prev.speaker === t.speaker &&
      prev.text.length + t.text.length < CHUNK_CHARS
    )
      prev.text += `\n${t.text}`;
    else merged.push({ ...t });
  }
  const out: Turn[] = [];
  for (const t of merged) {
    if (t.text.length <= CHUNK_CHARS) {
      if (t.text.trim() !== "") out.push(t);
      continue;
    }
    let rest = t.text;
    let first = true;
    while (rest.length > 0) {
      let cut = rest.length <= CHUNK_CHARS ? rest.length : rest.lastIndexOf(". ", CHUNK_CHARS);
      if (cut <= CHUNK_CHARS / 3) cut = Math.min(CHUNK_CHARS, rest.length);
      else if (cut < rest.length) cut += 1;
      out.push({
        ...(t.speaker === undefined ? {} : { speaker: t.speaker }),
        ...(first && t.at !== undefined ? { at: t.at } : {}),
        text: rest.slice(0, cut).trim(),
      });
      rest = rest.slice(cut).trim();
      first = false;
    }
  }
  return out;
}

/** The search items for one recording, `nativeId` = `<item id>#<n>`. */
export function transcriptItems(rec: RecordingRef): SourceItem[] {
  return chunkTurns(splitTurns(rec.text)).map((t, n) => ({
    nativeId: `${rec.id}#${n}`,
    parentId: rec.id,
    title: [rec.name, t.speaker, t.at].filter(Boolean).join(" · "),
    text: t.text,
    ...(t.speaker === undefined ? {} : { from: t.speaker }),
    createdAt: rec.createdAt + n,
    provenance: rec.provenance,
    tags: ["transcript", ...rec.tags],
  }));
}

/** Re-read window: a transcript attached to an older recording later is still picked up. */
const OVERLAP_MS = 7 * 86_400_000;
const PAGE = 20;

export function transcriptsAdapter(deps: TranscriptsSourceDeps): SourceAdapter {
  return {
    id: "transcripts",
    unavailable: () => undefined,
    async pull(cursor, { limit }): Promise<SourcePull> {
      const c = (cursor ?? { since: 0, after: null }) as { since: number; after: string | null };
      const recs = await deps.recordings(c.since, c.after, Math.min(limit, PAGE));
      const items = recs.flatMap(transcriptItems);
      const last = recs[recs.length - 1];
      if (last === undefined) {
        // Caught up: the next pass starts over at the same date; unchanged chunks are skipped by hash.
        return { items: [], cursor: { since: c.since, after: null }, hasMore: false };
      }
      const full = recs.length >= Math.min(limit, PAGE);
      return {
        items,
        cursor: full
          ? { since: last.createdAt, after: last.id }
          : { since: Math.max(0, last.createdAt - OVERLAP_MS), after: null },
        hasMore: full,
      };
    },
    async listIds(signal) {
      const ids: string[] = [];
      let since = 0;
      let after: string | null = null;
      for (let guard = 0; guard < 5000; guard += 1) {
        if (signal.aborted) return { ids, complete: false };
        const recs = await deps.recordings(since, after, 100);
        for (const r of recs)
          for (let n = 0; n < transcriptItems(r).length; n += 1) ids.push(`${r.id}#${n}`);
        const last = recs[recs.length - 1];
        if (last === undefined || recs.length < 100) return { ids, complete: true };
        since = last.createdAt;
        after = last.id;
      }
      return { ids, complete: false };
    },
  };
}
