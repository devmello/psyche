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

/**
 * Work attributes the model may propose from the owner's own notes (docs/design/
 * memory-everything-2026.md §3.1, §3.4). Never `status` or `deadline`: code and the owner decide
 * those. `target` is the opaque handle of an open work item (`w1`) or null for a new one, which
 * can only ever become a suggestion.
 */
export const OwnerWorkAttribute = StringEnum(["progress", "stopped_at", "next_step"]);
export type OwnerWorkAttribute = Static<typeof OwnerWorkAttribute>;

export const WorkHandle = Type.String({ pattern: "^w[0-9]{1,4}$" });

export const ExtractionWork = Type.Object(
  {
    item: Handle,
    target: Type.Union([WorkHandle, Type.Null()]),
    title: Type.Optional(Type.String({ maxLength: 300 })),
    attribute: OwnerWorkAttribute,
    value: Type.String({ maxLength: 2000 }),
    quote: Type.String({ maxLength: 2000 }),
    start: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    end: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export type ExtractionWork = Static<typeof ExtractionWork>;

/** Hard caps on the whole object; a model returning more is hostile or broken. */
export const MAX_OUTPUT_FACTS = 200;
export const MAX_OUTPUT_EDGES = 50;
export const MAX_OUTPUT_FLAGS = 50;
export const MAX_OUTPUT_WORK = 50;
export const MAX_OUTPUT_CHARS = 200_000;

export const ExtractionOutput = Type.Object(
  {
    facts: Type.Array(ExtractionFact, { maxItems: MAX_OUTPUT_FACTS }),
    edges: Type.Array(ExtractionEdge, { maxItems: MAX_OUTPUT_EDGES }),
    flags: Type.Array(ExtractionFlag, { maxItems: MAX_OUTPUT_FLAGS }),
    /** Only for owner-authored items, and only when the prompt listed work items. */
    work: Type.Optional(Type.Array(ExtractionWork, { maxItems: MAX_OUTPUT_WORK })),
  },
  { additionalProperties: false },
);
export type ExtractionOutput = Static<typeof ExtractionOutput>;

// --- the work lane (docs/design/memory-everything-2026.md §7.2) ------------------------------------

export const WorkKind = StringEnum(["new", "deadline_change", "submitted", "graded", "other"]);
export type WorkKind = Static<typeof WorkKind>;

/**
 * One assignment a work sender's mail mentions. There is no person handle, no attribute enum and
 * no free text beyond `title`: the lane cannot say anything about a person. Lengths are generous
 * (the validator enforces 120 and 60) so one long title drops one claim, not the batch.
 */
export const WorkLaneAssignment = Type.Object(
  {
    title: Type.String({ maxLength: 300 }),
    parent_hint: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    due: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    kind: WorkKind,
    quote: Type.String({ maxLength: 2000 }),
    start: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    end: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  },
  { additionalProperties: false },
);
export type WorkLaneAssignment = Static<typeof WorkLaneAssignment>;

/** A flood is quarantined by the validator (`too_many_claims`), so the schema lets it through. */
export const MAX_WORK_LANE_ASSIGNMENTS = 300;
export const MAX_WORK_LANE_ITEMS = 50;

export const WorkLaneItem = Type.Object(
  {
    item: Handle,
    assignments: Type.Array(WorkLaneAssignment, { maxItems: MAX_WORK_LANE_ASSIGNMENTS }),
    flags: Type.Object({ instruction_like: Type.Boolean() }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export type WorkLaneItem = Static<typeof WorkLaneItem>;

export const WorkLaneOutput = Type.Object(
  { items: Type.Array(WorkLaneItem, { maxItems: MAX_WORK_LANE_ITEMS }) },
  { additionalProperties: false },
);
export type WorkLaneOutput = Static<typeof WorkLaneOutput>;

export type ParseFailure = "too_large" | "not_json" | "schema" | "tool_call" | "not_finished";

export type ParseResult =
  | { ok: true; output: ExtractionOutput }
  | { ok: false; reason: ParseFailure };

export type WorkLaneParseResult =
  | { ok: true; output: WorkLaneOutput }
  | { ok: false; reason: ParseFailure };

function jsonOf(text: string): { ok: true; json: unknown } | { ok: false; reason: ParseFailure } {
  if (text.length > MAX_OUTPUT_CHARS) return { ok: false, reason: "too_large" };
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(body);
  if (fenced !== null) body = (fenced[1] as string).trim();
  try {
    return { ok: true, json: JSON.parse(body) };
  } catch {
    return { ok: false, reason: "not_json" };
  }
}

/** Strict parse of the model's text. A single wrapping code fence is tolerated; nothing else. */
export function parseExtraction(text: string): ParseResult {
  const parsed = jsonOf(text);
  if (!parsed.ok) return parsed;
  if (!Value.Check(ExtractionOutput, parsed.json)) return { ok: false, reason: "schema" };
  return { ok: true, output: parsed.json };
}

/** The same strict parse for the work lane's closed form. */
export function parseWorkLane(text: string): WorkLaneParseResult {
  const parsed = jsonOf(text);
  if (!parsed.ok) return parsed;
  if (!Value.Check(WorkLaneOutput, parsed.json)) return { ok: false, reason: "schema" };
  return { ok: true, output: parsed.json };
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
