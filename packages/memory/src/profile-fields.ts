import { blockingKinds, looksLikeInstruction } from "./filters.ts";

/**
 * USER.md's "About the owner" header (`- Name:`, `- Timezone:`, `- Work or study:`,
 * `- Home city:`): the structured half of what Psyche learns about the owner. A learned fact the
 * extractor tags with a `field` fills its header line in place; the dated Learned line stays as
 * provenance. Only facts from the owner's own words reach the header (security §8): the caller
 * (`learnUserFacts`) passes `ownerWords`, and nothing here reads untrusted content.
 */

export const PROFILE_FIELDS = ["name", "timezone", "work", "home_city"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export function isProfileField(v: unknown): v is ProfileField {
  return typeof v === "string" && (PROFILE_FIELDS as readonly string[]).includes(v);
}

const LABEL: Record<ProfileField, string> = {
  name: "Name",
  timezone: "Timezone",
  work: "Work or study",
  home_city: "Home city",
};

// --- normalization ------------------------------------------------------------------------------

/** US zone names and abbreviations the owner says, to an IANA id and the short label we show. */
const ZONES: Record<string, readonly [id: string, label: string]> = {
  pacific: ["America/Los_Angeles", "Pacific"],
  pst: ["America/Los_Angeles", "Pacific"],
  pdt: ["America/Los_Angeles", "Pacific"],
  pt: ["America/Los_Angeles", "Pacific"],
  mountain: ["America/Denver", "Mountain"],
  mst: ["America/Denver", "Mountain"],
  mdt: ["America/Denver", "Mountain"],
  mt: ["America/Denver", "Mountain"],
  central: ["America/Chicago", "Central"],
  cst: ["America/Chicago", "Central"],
  cdt: ["America/Chicago", "Central"],
  ct: ["America/Chicago", "Central"],
  eastern: ["America/New_York", "Eastern"],
  est: ["America/New_York", "Eastern"],
  edt: ["America/New_York", "Eastern"],
  et: ["America/New_York", "Eastern"],
  alaska: ["America/Anchorage", "Alaska"],
  akst: ["America/Anchorage", "Alaska"],
  akdt: ["America/Anchorage", "Alaska"],
  hawaii: ["Pacific/Honolulu", "Hawaii"],
  hst: ["Pacific/Honolulu", "Hawaii"],
};
const LABEL_OF_ID = new Map(Object.values(ZONES).map(([id, label]) => [id, label]));

function validZone(id: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: id }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * "Pacific time", "PST", "PT" and IANA ids to the header value (`America/Los_Angeles (Pacific)`;
 * plain `Europe/Berlin` for an id with no short label); `undefined` when it is not a zone.
 */
export function normalizeTimeZone(raw: string): string | undefined {
  const t = raw.trim();
  if (t === "" || t.length > 64) return undefined;
  const key = t
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(time|standard|daylight|zone|us|u\.s\.|the|usa)\b/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim();
  const hit = ZONES[key];
  if (hit !== undefined) return `${hit[0]} (${hit[1]})`;
  // An IANA id ("Region/City" or UTC); a bare abbreviation we do not know is not accepted.
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(t) && !/^(utc|gmt)$/i.test(t)) return undefined;
  const id = validZone(t);
  if (id === undefined) return undefined;
  const label = LABEL_OF_ID.get(id);
  return label === undefined ? id : `${id} (${label})`;
}

/** The IANA id at the start of a Timezone header value, if it is one. */
export function headerTimeZoneId(value: string): string | undefined {
  const first = value.trim().split(/\s+/)[0] ?? "";
  return first === "" ? undefined : validZone(first);
}

/**
 * A value ready for the header: one line, no markup, nothing sensitive or instruction-like.
 * `undefined` when the extractor's value is unusable (the fact then stays a plain Learned line).
 */
export function normalizeFieldValue(field: ProfileField, raw: string): string | undefined {
  const v = raw.replace(/\s+/g, " ").trim();
  if (v === "") return undefined;
  if (field === "timezone") return normalizeTimeZone(v);
  const max = field === "work" ? 80 : 60;
  if (v.length > max) return undefined;
  if (/^[#>|`-]|<!--|-->|[`[\]]/.test(v) || /https?:|@/.test(v)) return undefined;
  if (field !== "work" && /\d/.test(v)) return undefined;
  if (blockingKinds(v, false).length > 0 || looksLikeInstruction(v)) return undefined;
  return v;
}

// --- the header ---------------------------------------------------------------------------------

function headerEnd(lines: readonly string[]): number {
  const i = lines.findIndex((l) => l.startsWith("## "));
  return i < 0 ? lines.length : i;
}

function headerLine(field: ProfileField): RegExp {
  return new RegExp(`^- ${LABEL[field]}:[ \\t]*(.*?)(\\r?)$`);
}

/** The filled header fields (empty ones are absent). */
export function readHeader(content: string): Partial<Record<ProfileField, string>> {
  const lines = content.split("\n");
  const end = headerEnd(lines);
  const out: Partial<Record<ProfileField, string>> = {};
  for (const field of PROFILE_FIELDS) {
    const re = headerLine(field);
    for (let i = 0; i < end; i++) {
      const m = re.exec(lines[i] ?? "");
      if (m === null) continue;
      if ((m[1] ?? "").trim() !== "") out[field] = (m[1] ?? "").trim();
      break;
    }
  }
  return out;
}

/**
 * Sets one header line in place and nothing else (every other byte, line endings included, is
 * kept). "fill" only writes an empty field; "replace" also overwrites a different value. The
 * same value again, a missing line and an unusable value leave the content as it was.
 */
export function setHeaderField(
  content: string,
  field: ProfileField,
  value: string,
  mode: "fill" | "replace",
): string {
  const lines = content.split("\n");
  const end = headerEnd(lines);
  const re = headerLine(field);
  for (let i = 0; i < end; i++) {
    const m = re.exec(lines[i] ?? "");
    if (m === null) continue;
    const current = (m[1] ?? "").trim();
    if (current === value) return content;
    if (current !== "" && mode === "fill") return content;
    lines[i] = `- ${LABEL[field]}: ${value}${m[2] ?? ""}`;
    return lines.join("\n");
  }
  return content;
}

// --- facts written before the extractor tagged fields ---------------------------------------------

/**
 * The header field an older untagged Learned line states, by the plain wording the extractor
 * uses ("Timezone is Pacific time", "Is a UCSC student", "Lives in Santa Cruz"). Conservative:
 * a line that does not match plainly is left alone.
 */
export function legacyFieldOf(
  text: string,
  kind: string,
): { field: ProfileField; value: string } | undefined {
  const t = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");
  const make = (field: ProfileField, raw: string | undefined) => {
    const value = raw === undefined ? undefined : normalizeFieldValue(field, raw);
    return value === undefined ? undefined : { field, value };
  };
  let m = /^(?:time ?zone|tz) is (.+)$/i.exec(t) ?? /^(?:is )?(?:on|in) (.+? time)$/i.exec(t);
  if (m !== null) return make("timezone", m[1]);
  m =
    /^(?:is )?an? (.*?)\s*(?:undergrad(?:uate)?|graduate|grad|phd|college|university)? ?student(?: at (.+))?$/i.exec(
      t,
    );
  if (m !== null) {
    const school = (m[2] ?? m[1] ?? "").trim();
    return make("work", school === "" ? "Student" : `Student at ${school}`);
  }
  m = /^(?:works (?:at|for|as) .+)$/i.exec(t);
  if (m !== null) return make("work", t.charAt(0).toUpperCase() + t.slice(1));
  m = /^(?:lives in|is based in) (.+)$/i.exec(t);
  if (m !== null) return make("home_city", m[1]);
  if (kind === "name") {
    m = /^(?:name is|is called|is named|goes by) (.+)$/i.exec(t);
    if (m !== null) return make("name", m[1]);
  }
  return undefined;
}

export interface LearnedForRepair {
  date: string;
  kind: string;
  text: string;
  field?: ProfileField;
}

/**
 * One-time repair: fills the empty header fields from existing Learned lines, the latest
 * statement of each field winning. A field already filled is never touched.
 */
export function repairHeader(
  content: string,
  learned: readonly LearnedForRepair[],
): { content: string; filled: ProfileField[] } {
  const latest = new Map<ProfileField, { date: string; value: string }>();
  for (const l of learned) {
    if (l.field !== undefined) continue; // tagged lines were applied when they were written
    const hit = legacyFieldOf(l.text, l.kind);
    if (hit === undefined) continue;
    const prev = latest.get(hit.field);
    if (prev === undefined || l.date >= prev.date)
      latest.set(hit.field, { date: l.date, value: hit.value });
  }
  let next = content;
  const filled: ProfileField[] = [];
  for (const [field, { value }] of latest) {
    const after = setHeaderField(next, field, value, "fill");
    if (after !== next) filled.push(field);
    next = after;
  }
  return { content: next, filled };
}

/** The owner's IANA zone from USER.md's Timezone header, or from older Learned lines. */
export function ownerTimeZone(
  content: string,
  learned: readonly LearnedForRepair[] = [],
): string | undefined {
  const header = readHeader(content).timezone;
  if (header !== undefined) return headerTimeZoneId(header);
  const { content: repaired } = repairHeader(content, learned);
  const value = readHeader(repaired).timezone;
  return value === undefined ? undefined : headerTimeZoneId(value);
}
