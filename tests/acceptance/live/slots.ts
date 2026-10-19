import type { ModelProvider } from "@psyche/protocol";

/**
 * Proposed meeting slots in a live model's own words (tests/scenarios/README.md
 * `proposed_slots`: "in live mode a utility-model extractor that returns JSON is the fallback").
 * S18's deterministic parser reads `Thu Oct 22, 4:00-4:45 PM` lines only; a live model writes
 * "Thursday, October 22 from 4:00 PM to 4:45 PM", "4:00–4:45 PM on Thu Oct 22", ISO ranges, …
 * `extractSlots` covers those shapes; `extractSlotsWithModel` asks the model for JSON when they
 * do not match. Both return local slots; `canonicalLines` renders them for S18's parser, so its
 * working-hours, lunch and free/busy checks run unchanged.
 */

export interface LocalSlot {
  /** `YYYY-MM-DD` in the owner's zone. */
  date: string;
  /** Minutes since local midnight. */
  start: number;
  end: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const WD = "(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s*)?";
const TIME = "(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?";
const SEP = "\\s*(?:-|–|—|to|until|till)\\s*";

const to24 = (h: number, ap: string | undefined, fallback: string | undefined) => {
  const m = (ap ?? fallback ?? "").replace(/\./g, "").toLowerCase();
  const hh = h % 12;
  return m === "pm" ? hh + 12 : m === "am" ? hh : h;
};

function slot(
  date: string,
  sh: string,
  sm: string | undefined,
  sap: string | undefined,
  eh: string,
  em: string | undefined,
  eap: string | undefined,
): LocalSlot | undefined {
  const endAp = eap ?? sap;
  let start = to24(Number(sh), sap, endAp) * 60 + Number(sm ?? 0);
  const end = to24(Number(eh), eap, sap) * 60 + Number(em ?? 0);
  if (sap === undefined && start > end) start -= 12 * 60;
  if (!(end > start)) return undefined;
  return { date, start, end };
}

const dateOf = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** Slots from prose, for the year the scenario runs in. */
export function extractSlots(text: string, year: number): LocalSlot[] {
  // Slots keep the order the model gave them (captures like `${slots[1].start}` depend on it),
  // whichever pattern matched, so each match remembers where in the text it was.
  const found: { at: number; slot: LocalSlot }[] = [];
  const seen = new Set<string>();
  const add = (s: LocalSlot | undefined, at: number) => {
    if (s === undefined) return;
    const key = `${s.date}|${s.start}|${s.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ at, slot: s });
    }
  };
  // "Thursday, October 22(nd), (from) 4:00 PM (to|-) 4:45 PM" and "Thu Oct 22, 4:00-4:45 PM".
  const dateFirst = new RegExp(
    `${WD}${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*\\d{4})?,?\\s*(?:from|at|@)?\\s*${TIME}${SEP}${TIME}`,
    "gi",
  );
  for (const m of text.matchAll(dateFirst)) {
    const month = MONTHS.indexOf((m[1] ?? "").slice(0, 3).toLowerCase()) + 1;
    if (month === 0) continue;
    add(
      slot(dateOf(year, month, Number(m[2])), m[3] ?? "", m[4], m[5], m[6] ?? "", m[7], m[8]),
      m.index ?? 0,
    );
  }
  // "4:00–4:45 PM on Thursday, October 22".
  const timeFirst = new RegExp(
    `${TIME}${SEP}${TIME}\\s+(?:on\\s+)?${WD}${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?`,
    "gi",
  );
  for (const m of text.matchAll(timeFirst)) {
    const month = MONTHS.indexOf((m[7] ?? "").slice(0, 3).toLowerCase()) + 1;
    if (month === 0) continue;
    add(
      slot(dateOf(year, month, Number(m[8])), m[1] ?? "", m[2], m[3], m[4] ?? "", m[5], m[6]),
      m.index ?? 0,
    );
  }
  // "10/22, 4:00-4:45 PM" and "10/22 from 4:00 PM to 4:45 PM".
  const numeric = new RegExp(
    `${WD}(\\d{1,2})/(\\d{1,2})(?:/\\d{2,4})?,?\\s*(?:from|at|@)?\\s*${TIME}${SEP}${TIME}`,
    "gi",
  );
  for (const m of text.matchAll(numeric)) {
    const month = Number(m[1]);
    if (month < 1 || month > 12) continue;
    add(
      slot(dateOf(year, month, Number(m[2])), m[3] ?? "", m[4], m[5], m[6] ?? "", m[7], m[8]),
      m.index ?? 0,
    );
  }
  // ISO: "2026-10-22T16:00(:00-07:00) – (2026-10-22T)16:45".
  const iso =
    /(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?\s*(?:-|–|—|to|until)\s*(?:\d{4}-\d{2}-\d{2}T)?(\d{2}):(\d{2})/g;
  for (const m of text.matchAll(iso)) {
    const start = Number(m[2]) * 60 + Number(m[3]);
    const end = Number(m[4]) * 60 + Number(m[5]);
    if (end > start) add({ date: m[1] ?? "", start, end }, m.index ?? 0);
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.slot);
}

/** `Thu Oct 22, 4:00 PM-4:45 PM` lines: what S18's `parseSlots` reads. */
export function canonicalLines(slots: readonly LocalSlot[]): string {
  const clock = (min: number) => {
    const h = Math.floor(min / 60) % 24;
    const ap = h >= 12 ? "PM" : "AM";
    return `${h % 12 === 0 ? 12 : h % 12}:${String(min % 60).padStart(2, "0")} ${ap}`;
  };
  return slots
    .map((s) => {
      const [y, m, d] = s.date.split("-").map(Number);
      const day = DAYS[new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1, 12)).getUTCDay()];
      const mon = MONTHS[(m ?? 1) - 1] ?? "jan";
      const month = mon.charAt(0).toUpperCase() + mon.slice(1);
      return `${day} ${month} ${d}, ${clock(s.start)}-${clock(s.end)}`;
    })
    .join("\n");
}

const EXTRACT_SYSTEM =
  "You extract meeting time slots from text. Reply with JSON only, no prose, in the form " +
  '{"slots":[{"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM"}]} using 24-hour local times ' +
  "in the owner's time zone. Include only the slots offered to the owner, in the order given; " +
  'never busy times, existing events or examples. If there are none, reply {"slots":[]}.';

/** The utility-model fallback: the same provider, one short JSON-only turn. */
export async function extractSlotsWithModel(
  provider: ModelProvider,
  model: string,
  text: string,
  context: { timeZone: string; year: number },
): Promise<LocalSlot[]> {
  let reply = "";
  const stream = provider.stream({
    model,
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: `Time zone: ${context.timeZone}. Year: ${context.year}.\n\nText:\n${text}`,
          },
        ],
      },
    ],
    maxOutputTokens: 600,
    temperature: 0,
  });
  for await (const ev of stream) if (ev.type === "text_delta") reply += ev.text;
  const json = reply.match(/\{[\s\S]*\}/)?.[0];
  if (json === undefined) return [];
  try {
    const parsed = JSON.parse(json) as {
      slots?: { date?: string; start?: string; end?: string }[];
    };
    const out: LocalSlot[] = [];
    for (const s of parsed.slots ?? []) {
      const [sh, sm] = String(s.start ?? "")
        .split(":")
        .map(Number);
      const [eh, em] = String(s.end ?? "")
        .split(":")
        .map(Number);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.date)) || sh === undefined || eh === undefined)
        continue;
      const start = sh * 60 + (sm ?? 0);
      const end = eh * 60 + (em ?? 0);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start)
        out.push({ date: String(s.date), start, end });
    }
    return out;
  } catch {
    return [];
  }
}
