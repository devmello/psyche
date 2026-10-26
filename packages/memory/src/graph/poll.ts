import type { Clock, GraphSource } from "@psyche/protocol";
import {
  type ContactRecord,
  type EventRecord,
  GraphIngester,
  type IngestReport,
  type MailRecord,
  type MessageRecord,
} from "./ingest.ts";
import type { GraphStore } from "./store.ts";

/**
 * The deterministic pass's polling loop (docs/memory/people-and-projects-2026.md §5.1), connector
 * neutral: each adapter turns one connected app's reads into ingest records since its cursor.
 * Only sources the owner turned on are polled. Cursors live in `graph_cursors` under
 * `poll:<adapter id>`, so a restart continues where it stopped and a failed pull retries from the
 * same place.
 */

export interface GraphPull {
  contacts?: ContactRecord[];
  mails?: MailRecord[];
  events?: EventRecord[];
  messages?: MessageRecord[];
  /** Stored as the adapter's cursor once the records are ingested. */
  cursor: unknown;
}

export interface GraphSourceAdapter {
  /** Stable per connected instance, e.g. `mail:apple-mail-1`. */
  readonly id: string;
  readonly source: GraphSource;
  /** The owner's own addresses or phones on this account (the mail account, the phone number). */
  ownerIdentities?(): Promise<{ emails?: string[]; phones?: string[] }>;
  pull(cursor: unknown, signal: AbortSignal): Promise<GraphPull>;
}

export interface GraphPollOptions {
  enabled: Partial<Record<GraphSource, boolean>>;
  ownerEmails?: string[];
  ownerPhones?: string[];
  clock?: Clock;
  signal?: AbortSignal;
}

export interface GraphPollReport {
  adapters: { id: string; source: GraphSource; ok: boolean; report?: IngestReport }[];
  interactions: number;
  created: number;
}

/** Contacts first, so mail and calendar people resolve to them; the no-reply check last. */
const ORDER: GraphSource[] = ["contacts", "mail", "calendar", "messages", "notes", "chats"];

export const pollCursorKey = (adapterId: string) => `poll:${adapterId}`;

export async function runGraphPoll(
  graph: GraphStore,
  adapters: readonly GraphSourceAdapter[],
  options: GraphPollOptions,
): Promise<GraphPollReport> {
  const signal = options.signal ?? new AbortController().signal;
  const active = adapters
    .filter((a) => options.enabled[a.source] === true)
    .sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
  const emails = new Set(options.ownerEmails ?? []);
  const phones = new Set(options.ownerPhones ?? []);
  const owner = graph.ownerEntity();
  if (owner !== undefined)
    for (const i of graph.identifiers(owner.id)) {
      if (i.kind === "email") emails.add(i.value);
      if (i.kind === "phone") phones.add(i.value);
    }
  for (const a of active) {
    const own = await a.ownerIdentities?.().catch(() => undefined);
    for (const e of own?.emails ?? []) emails.add(e);
    for (const p of own?.phones ?? []) phones.add(p);
  }
  const ingest = new GraphIngester(graph, {
    ownerEmails: [...emails],
    ownerPhones: [...phones],
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const report: GraphPollReport = { adapters: [], interactions: 0, created: 0 };
  let mail = false;
  for (const a of active) {
    if (signal.aborted) break;
    const key = pollCursorKey(a.id);
    try {
      const pulled = await a.pull(graph.cursor(key) ?? null, signal);
      const parts: IngestReport[] = [];
      if (pulled.contacts !== undefined && pulled.contacts.length > 0)
        parts.push(ingest.ingestContacts(pulled.contacts));
      if (pulled.mails !== undefined && pulled.mails.length > 0) {
        parts.push(ingest.ingestMail(pulled.mails));
        mail = true;
      }
      if (pulled.events !== undefined && pulled.events.length > 0)
        parts.push(ingest.ingestEvents(pulled.events));
      if (pulled.messages !== undefined && pulled.messages.length > 0)
        parts.push(ingest.ingestMessages(pulled.messages));
      graph.setCursor(key, pulled.cursor);
      const merged = sum(parts);
      report.adapters.push({ id: a.id, source: a.source, ok: true, report: merged });
      report.interactions += merged.interactions;
      report.created += merged.created;
    } catch {
      // The cursor stays: the next round retries from the same place.
      report.adapters.push({ id: a.id, source: a.source, ok: false });
    }
  }
  if (mail) ingest.checkNoReply();
  return report;
}

function sum(reports: IngestReport[]): IngestReport {
  return reports.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      interactions: acc.interactions + r.interactions,
      skipped: acc.skipped + r.skipped,
      suggestions: acc.suggestions + r.suggestions,
      loops: acc.loops + r.loops,
    }),
    { created: 0, interactions: 0, skipped: 0, suggestions: 0, loops: 0 },
  );
}
