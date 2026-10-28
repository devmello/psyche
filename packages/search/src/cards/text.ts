import type { ContextCard } from "./types.ts";

/**
 * The words of a card that go into full-text and embedding indexes: title, summary, the
 * questions it answers, entities, places, dates and tags. Quotes are not repeated (the document
 * body already has them).
 */
export function cardText(card: ContextCard): string {
  const lines: string[] = [card.title.value, card.summary.value];
  if (card.why !== undefined) lines.push(card.why.value);
  for (const q of card.questions) lines.push(q.value);
  const names = [...card.who, ...card.what, ...card.where].map((c) => c.value);
  if (names.length > 0) lines.push(names.join(", "));
  const dates = card.when.map((w) => (w.iso === undefined ? w.value : `${w.value} ${w.iso}`));
  if (dates.length > 0) lines.push(dates.join(", "));
  if (card.tags.length > 0) lines.push(card.tags.map((t) => t.value).join(" "));
  return lines.join("\n");
}

/** Normalised entity names for the filter table (people, organisations, topics, projects). */
export function cardEntities(
  card: ContextCard,
): { name: string; kind: string; personId?: string }[] {
  const seen = new Set<string>();
  const out: { name: string; kind: string; personId?: string }[] = [];
  const add = (name: string, kind: string, personId?: string) => {
    const key = name.normalize("NFC").toLowerCase().trim();
    if (key.length === 0 || seen.has(`${kind}:${key}`)) return;
    seen.add(`${kind}:${key}`);
    out.push({ name: key, kind, ...(personId === undefined ? {} : { personId }) });
  };
  for (const w of card.who) add(w.value, w.kind, w.personId);
  for (const w of card.what) add(w.value, w.kind);
  return out;
}

/** Epoch-ms days (UTC) the card mentions; the item's own date is included. */
export function cardDates(card: ContextCard): number[] {
  const out = new Set<number>([Math.floor(card.eventAt / 86_400_000) * 86_400_000]);
  for (const w of card.when) {
    if (w.iso !== undefined) out.add(Date.parse(`${w.iso}T00:00:00Z`));
  }
  return [...out].filter((n) => Number.isFinite(n));
}

/** One line of document-level context for chunks (see `contextualChunks`). */
export function contextLine(parts: {
  title: string;
  source?: string | undefined;
  createdAt?: number | undefined;
  section?: string | undefined;
}): string {
  const bits = [parts.title.replace(/\s+/g, " ").trim()];
  if (parts.source !== undefined && parts.source !== "") bits.push(parts.source);
  if (parts.createdAt !== undefined && Number.isFinite(parts.createdAt))
    bits.push(new Date(parts.createdAt).toISOString().slice(0, 10));
  if (parts.section !== undefined && parts.section !== "") bits.push(parts.section);
  return bits.filter((b) => b !== "").join(" · ");
}

/** Prefixes every chunk with the context line so a chunk is findable on its own. */
export function contextualChunks(chunks: string[], line: string): string[] {
  return line === "" ? chunks : chunks.map((c) => `${line}\n${c}`);
}
