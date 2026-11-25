import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  Block,
  Events,
  isEventName,
  Methods,
  POINTS_CAPABILITIES,
  POINTS_CAPABILITY_EFFECTS,
  PointsCardAction,
  PointsCardStrings,
  PointsOfferBlock,
  PointsShowParams,
  validateEventPayload,
  validateParams,
} from "../src/index.ts";
import * as pointsSchemas from "../src/schemas/points.ts";

/**
 * Psyche points, W0 (docs/design/psyche-points-2026.md §4.3.3, §8): the wire carries no action.
 * The schemas have no field that names a key, a click, a value to set, an AX action or a point to
 * act on; `points.show` draws by `fieldId` or a box and nothing else.
 */

/** Property names that would mean "do something in the other app". */
const ACTION_NAMES =
  /^(click|clicks|doubleclick|rightclick|press|presses|key|keys|keycode|keystroke|keystrokes|chord|hotkey|shortcut|type_text|typetext|input|keyboard|mouse|cursor|pointer|scroll|scrollby|drag|drop|swipe|tap|setvalue|set_value|setattribute|performaction|axaction|axpress|axperform|activate|focus_field|raise|launch|openurl|open_url|script|command|exec|eval|run|post|inject|coordinate|coordinates|point|points|position|offset|dx|dy)$/i;
/** Names that may appear only inside a rectangle that says where a field is. */
const RECT_ONLY = new Set(["x", "y"]);

type Schema = {
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  allOf?: Schema[];
  $id?: string;
};

function walk(
  schema: Schema,
  visit: (name: string, owner: string | undefined) => void,
  owner?: string,
): void {
  const here = schema.$id ?? owner;
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    visit(name, here);
    walk(child, visit, here);
  }
  if (schema.items) walk(schema.items, visit, here);
  for (const s of [...(schema.anyOf ?? []), ...(schema.allOf ?? [])]) walk(s, visit, here);
}

function namesOf(schema: Schema): { name: string; owner: string | undefined }[] {
  const out: { name: string; owner: string | undefined }[] = [];
  walk(schema, (name, owner) => out.push({ name, owner }));
  return out;
}

const POINTS_SCHEMAS = Object.entries(pointsSchemas)
  .filter(([, v]) => typeof v === "object" && v !== null && "$id" in (v as object))
  .map(([k, v]) => [k, v as Schema] as const);

const POINTS_METHOD_NAMES = Object.keys(Methods).filter((n) => n.startsWith("points."));

describe("points protocol: no action on the wire", () => {
  it("walks every points schema, so the checks below mean something", () => {
    expect(POINTS_SCHEMAS.length).toBeGreaterThan(30);
    expect(POINTS_METHOD_NAMES.sort()).toEqual([
      "points.ask",
      "points.start",
      "points.status",
      "points.stop",
      "points.windows",
    ]);
  });

  it("positive control: the walker finds action-shaped names when they are there", () => {
    const bad = Type.Object({
      ok: Type.String(),
      click: Type.Object({ x: Type.Number(), y: Type.Number() }),
      nested: Type.Array(Type.Object({ setValue: Type.String() })),
    }) as unknown as Schema;
    const hits = namesOf(bad).filter((n) => ACTION_NAMES.test(n.name));
    expect(hits.map((h) => h.name).sort()).toEqual(["click", "setValue"]);
  });

  it.each(POINTS_SCHEMAS)("%s has no action-shaped property", (_name, schema) => {
    for (const { name, owner } of namesOf(schema)) {
      expect(ACTION_NAMES.test(name), `${owner}.${name}`).toBe(false);
    }
  });

  it.each(POINTS_METHOD_NAMES)("%s params and result have no action-shaped property", (name) => {
    const spec = Methods[name as keyof typeof Methods] as unknown as {
      params: Schema;
      result: Schema;
    };
    for (const schema of [spec.params, spec.result])
      for (const { name: n, owner } of namesOf(schema))
        expect(ACTION_NAMES.test(n), `${name} ${owner}.${n}`).toBe(false);
  });

  it("allows x and y only inside a rectangle (where a field is, never where to act)", () => {
    for (const [, schema] of POINTS_SCHEMAS) {
      for (const { name, owner } of namesOf(schema)) {
        if (RECT_ONLY.has(name)) expect(owner, `${name} in ${owner}`).toBe("PointsRect");
      }
    }
  });

  it("the card's buttons are the owner's own clicks, and nothing else", () => {
    expect([...PointsCardAction.enum].sort()).toEqual(
      [
        "ask",
        "back",
        "follow_window",
        "look",
        "next",
        "skip",
        "stop",
        "stuck_blocked",
        "stuck_missing",
        "stuck_unclear",
        "wrong",
      ].sort(),
    );
  });

  it("points.show can only draw: a field or a box, text, and a step count", () => {
    expect(Object.keys((PointsShowParams as unknown as Schema).properties ?? {}).sort()).toEqual([
      "kind",
      "note",
      "sessionId",
      "sources",
      "step",
      "target",
      "value",
      "warning",
    ]);
    const kinds = (pointsSchemas.PointsShowKind as unknown as { enum: string[] }).enum;
    for (const k of kinds) expect(k).not.toMatch(/click|press|type|set|key/i);
  });

  it("the helper capabilities are none or read, and are not Gateway methods", () => {
    expect([...POINTS_CAPABILITIES].sort()).toEqual([
      "points.end",
      "points.look",
      "points.session",
      "points.show",
      "points.windows",
    ]);
    for (const c of POINTS_CAPABILITIES)
      expect(["none", "read"], c).toContain(POINTS_CAPABILITY_EFFECTS[c]);
    // `points.windows` exists on both sides with different shapes (the owner's choices, and the
    // helper's pids); the other four are helper-only.
    expect(Object.keys(Methods)).not.toContain("points.session");
    expect(Object.keys(Methods)).not.toContain("points.show");
    expect(Object.keys(Methods)).not.toContain("points.look");
    expect(Object.keys(Methods)).not.toContain("points.end");
  });
});

describe("points protocol: scopes and registry", () => {
  it.each(POINTS_METHOD_NAMES)("%s is operator.admin (Host desktop shell only)", (name) => {
    expect((Methods[name as keyof typeof Methods] as { scope: string }).scope).toBe(
      "operator.admin",
    );
  });

  it("only points.start is side-effecting, and only points.ask calls a model", () => {
    const side = POINTS_METHOD_NAMES.filter(
      (n) => (Methods[n as keyof typeof Methods] as { sideEffecting: boolean }).sideEffecting,
    );
    expect(side).toEqual(["points.start"]);
    const models = POINTS_METHOD_NAMES.filter(
      (n) => (Methods[n as keyof typeof Methods] as { callsModel: boolean }).callsModel,
    );
    expect(models).toEqual(["points.ask"]);
    expect((Methods["points.start"] as { description: string }).description).toMatch(
      /Side-effecting/,
    );
  });

  it("registers the two events", () => {
    expect(isEventName("points.updated")).toBe(true);
    expect(isEventName("points.ask_requested")).toBe(true);
    expect(Object.keys(Events).filter((e) => e.startsWith("points."))).toEqual([
      "points.updated",
      "points.ask_requested",
    ]);
  });
});

const STRINGS = Object.fromEntries(
  Object.keys((PointsCardStrings as unknown as Schema).properties ?? {}).map((k) => [k, k]),
);

describe("points protocol: shapes", () => {
  it("accepts a start with the full set of card strings and refuses one without", () => {
    const ok = {
      window: "w1",
      goal: "2026 tax return",
      entry: "palette",
      locale: "en",
      strings: STRINGS,
    };
    expect(validateParams("points.start", ok)).toMatchObject({ window: "w1" });
    const { back: _b, ...missing } = STRINGS;
    expect(() => validateParams("points.start", { ...ok, strings: missing })).toThrow();
    expect(() =>
      validateParams("points.start", { ...ok, strings: { ...STRINGS, extra: "x" } }),
    ).toThrow();
    expect(() => validateParams("points.start", { ...ok, goal: "x".repeat(501) })).toThrow();
    expect(() =>
      validateParams("points.start", { ...ok, strings: { ...STRINGS, back: "x".repeat(81) } }),
    ).toThrow();
    expect(() => validateParams("points.start", { ...ok, entry: "mobile" })).toThrow();
  });

  it("bounds the ask text", () => {
    expect(validateParams("points.ask", { sessionId: "s1", text: "why" })).toMatchObject({
      text: "why",
    });
    expect(() => validateParams("points.ask", { sessionId: "s1", text: "" })).toThrow();
    expect(() =>
      validateParams("points.ask", { sessionId: "s1", text: "x".repeat(1001) }),
    ).toThrow();
  });

  it("validates event payloads and refuses extra keys", () => {
    const upd = { sessionId: "s1", state: "pointing", page: 1, step: 2, of: 5, vision: false };
    expect(validateEventPayload("points.updated", upd)).toMatchObject({ state: "pointing" });
    expect(() => validateEventPayload("points.updated", { ...upd, label: "SSN" })).toThrow();
    expect(() => validateEventPayload("points.updated", { ...upd, state: "clicking" })).toThrow();
    expect(validateEventPayload("points.ask_requested", { sessionId: "s1" })).toEqual({
      sessionId: "s1",
    });
  });

  it("a field id is a helper handle, and a plan step can only name one", () => {
    expect(pointsSchemas.POINTS_FIELD_ID_PATTERN).toBe("^f[0-9]{1,6}$");
    expect(new RegExp(pointsSchemas.POINTS_FIELD_ID_PATTERN).test("f12")).toBe(true);
    expect(new RegExp(pointsSchemas.POINTS_FIELD_ID_PATTERN).test("12,40")).toBe(false);
    expect(new RegExp(pointsSchemas.POINTS_FIELD_ID_PATTERN).test("f1; click")).toBe(false);
  });

  it("a start says where the goal came from, and the offer part takes no other key", () => {
    const ok = {
      window: "w1",
      goal: "x",
      goalSource: "offer",
      entry: "chat",
      locale: "en",
      strings: STRINGS,
    };
    expect(validateParams("points.start", ok)).toMatchObject({ goalSource: "offer" });
    expect(() => validateParams("points.start", { ...ok, goalSource: "model" })).toThrow();
    expect(
      (PointsOfferBlock as unknown as { additionalProperties?: boolean }).additionalProperties,
    ).toBe(false);
  });

  it("the offer part carries a goal and starts nothing", () => {
    expect(Object.keys((PointsOfferBlock as unknown as Schema).properties ?? {}).sort()).toEqual([
      "goal",
      "type",
    ]);
    const variants = (Block as unknown as { anyOf: Schema[] }).anyOf;
    expect(
      variants.some(
        (v) =>
          v.properties?.type && (v.properties.type as { const?: string }).const === "points_offer",
      ),
    ).toBe(true);
  });
});
