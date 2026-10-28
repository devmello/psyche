import { type ModelEvent, StringEnum } from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * The closed output form of the extractor (docs/design/everything-memory-2026.md §5.1 stage 2).
 * The model fills this form and nothing else: every object is `additionalProperties: false`, so
 * an unknown field (an entity id, an email, a tool name, a "setting") rejects the whole batch.
 * Every id the model sees or returns is an opaque handle (`p1`, `i3`) that code maps back; it
 * never handles an address, a number or an entity id, so it cannot create an identifier or a
 * merge.
 */

export const Handle = Type.String({ pattern: "^[a-z][0-9]{1,4}$" });

export const ExtractionAttribute = StringEnum([
  "role",
  "title",
  "employer",
  "team",
  "timezone",
  "city",
  "birthday",
  "preference",
  "note",
  "anniversary",
  "hometown",
  "school",
  "pronouns",
  "partner_name",
  "children_names",
  "pet_names",
  "likes",
  "dislikes",
  "diet",
  "gift_idea",
  "languages",
  "contact_pref",
  "life_event",
]);
export type ExtractionAttribute = Static<typeof ExtractionAttribute>;

export const ExtractionSubjectKind = StringEnum(["self_disclosure", "about_other", "owner_stated"]);

export const ExtractionSensitivity = StringEnum([
  "none",
  "health",
  "finance",
  "sexuality",
  "religion",
  "politics",
  "ethnicity",
  "legal",
  "precise_location",
  "gov_id",
  "account_numbers",
]);

export const ExtractionRel = StringEnum([
  "works_at",
  "member_of",
  "stakeholder_of",
  "located_at",
  "part_of",
  "family",
  "friend",
  "neighbour",
  "classmate",
  "roommate",
  "colleague",
  "manager",
  "client",
  "vendor",
  "mentor",
  "studied_at",
  "lives_in",
  "attended",
  "about",
]);

export const ExtractionFamilyRole = StringEnum([
  "parent",
  "child",
  "sibling",
  "partner",
  "spouse",
  "grandparent",
  "grandchild",
  "cousin",
  "in_law",
  "other",
]);

// Lengths are generous here and enforced per fact by the validator, so one long value drops one
// fact instead of rejecting the batch; the raw output size is capped before parsing.
export const ExtractionFact = Type.Object(
  {
    handle: Handle,
    attribute: ExtractionAttribute,
    value: Type.String({ maxLength: 2000 }),
    item: Handle,
    quote: Type.String({ maxLength: 2000 }),
    start: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    end: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    subject_kind: ExtractionSubjectKind,
    sensitivity: ExtractionSensitivity,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    derived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ExtractionFact = Static<typeof ExtractionFact>;

export const ExtractionEdge = Type.Object(
  {
    src: Handle,
    dst: Handle,
    rel: ExtractionRel,
    role: Type.Optional(ExtractionFamilyRole),
    item: Handle,
    quote: Type.String({ maxLength: 2000 }),
    start: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    end: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export type ExtractionEdge = Static<typeof ExtractionEdge>;

/** What the model saw in an item, reported without acting on it. */
export const ExtractionFlag = Type.Object(
  {
    item: Handle,
    instruction_like: Type.Boolean(),
    about_owner: Type.Boolean(),
    identity_claim: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ExtractionFlag = Static<typeof ExtractionFlag>;

/** Hard caps on the whole object; a model returning more is hostile or broken. */
export const MAX_OUTPUT_FACTS = 200;
export const MAX_OUTPUT_EDGES = 50;
export const MAX_OUTPUT_FLAGS = 50;
export const MAX_OUTPUT_CHARS = 200_000;

export const ExtractionOutput = Type.Object(
  {
    facts: Type.Array(ExtractionFact, { maxItems: MAX_OUTPUT_FACTS }),
    edges: Type.Array(ExtractionEdge, { maxItems: MAX_OUTPUT_EDGES }),
    flags: Type.Array(ExtractionFlag, { maxItems: MAX_OUTPUT_FLAGS }),
  },
  { additionalProperties: false },
);
export type ExtractionOutput = Static<typeof ExtractionOutput>;

export type ParseFailure = "too_large" | "not_json" | "schema" | "tool_call" | "not_finished";

export type ParseResult =
  | { ok: true; output: ExtractionOutput }
  | { ok: false; reason: ParseFailure };

/** Strict parse of the model's text. A single wrapping code fence is tolerated; nothing else. */
export function parseExtraction(text: string): ParseResult {
  if (text.length > MAX_OUTPUT_CHARS) return { ok: false, reason: "too_large" };
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(body);
  if (fenced !== null) body = (fenced[1] as string).trim();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!Value.Check(ExtractionOutput, json)) return { ok: false, reason: "schema" };
  return { ok: true, output: json };
}

/**
 * Turns one model stream into its text. The extractor has no tools, so any tool call or result
 * in the stream means the model (or the provider) did something it was never offered: the whole
 * batch is rejected, and the call is not executed. A stream that did not finish with `stop`
 * (cut at the length limit, error, cancel) is rejected too, so half a JSON never parses.
 */
export function extractionText(
  events: Iterable<ModelEvent>,
): { ok: true; text: string } | { ok: false; reason: "tool_call" | "not_finished" } {
  let text = "";
  let finished = false;
  for (const e of events) {
    if (e.type === "tool_call" || e.type === "tool_result")
      return { ok: false, reason: "tool_call" };
    if (e.type === "text_delta") text += e.text;
    if (e.type === "finish") finished = e.reason === "stop";
  }
  return finished ? { ok: true, text } : { ok: false, reason: "not_finished" };
}
