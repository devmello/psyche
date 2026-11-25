import { StringEnum } from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * The closed output form of the promise lane (design 3.3). The model fills this form and nothing
 * else: every object is `additionalProperties: false`, so an unknown field (an entity id, an
 * address, a tool name) rejects the whole reply. Every id in it is an opaque handle for this one
 * call (`s1` for a snippet, `p1` for an open promise); code maps them back, so the model cannot
 * name a promise it was not shown.
 */

export const SnippetHandle = Type.String({ pattern: "^s[0-9]{1,3}$" });
export const PromiseHandle = Type.String({ pattern: "^p[0-9]{1,3}$" });

export const PromiseLaneDue = Type.Object(
  {
    text: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
    date: Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()]),
    time: Type.Union([Type.String({ pattern: "^\\d{2}:\\d{2}$" }), Type.Null()]),
    kind: StringEnum(["explicit", "inferred", "none"]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export type PromiseLaneDue = Static<typeof PromiseLaneDue>;

export const PromiseLaneUpdate = Type.Object(
  {
    type: Type.Union([
      StringEnum(["done", "renegotiate_proposed", "renegotiate_agreed", "release"]),
      Type.Null(),
    ]),
    new_due: Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type PromiseLaneUpdate = Static<typeof PromiseLaneUpdate>;

export const PromiseLaneItem = Type.Object(
  {
    snippet: SnippetHandle,
    kind: StringEnum(["new", "same_as", "update"]),
    same_as: Type.Union([PromiseHandle, Type.Null()]),
    promiser: StringEnum(["owner", "counterpart"]),
    promisee: StringEnum(["owner", "counterpart"]),
    what: Type.String({ maxLength: 400 }),
    action: StringEnum(["send", "reply", "meet", "do"]),
    quote: Type.String({ maxLength: 700 }),
    due: PromiseLaneDue,
    update: PromiseLaneUpdate,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export type PromiseLaneItem = Static<typeof PromiseLaneItem>;

export const MAX_LANE_OUTPUT_ITEMS = 40;

export const PromiseLaneOutput = Type.Object(
  { items: Type.Array(PromiseLaneItem, { maxItems: MAX_LANE_OUTPUT_ITEMS }) },
  { additionalProperties: false },
);
export type PromiseLaneOutput = Static<typeof PromiseLaneOutput>;

/**
 * The reply as a checked value, or undefined when it is not exactly this form. A reply with prose
 * around the JSON is read from its outermost braces; any extra key anywhere rejects it.
 */
export function parseLaneOutput(reply: string): PromiseLaneOutput | undefined {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (json === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  return Value.Check(PromiseLaneOutput, value) ? value : undefined;
}
