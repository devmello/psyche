import { PsycheError } from "@psyche/protocol";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * The settings registry: what `settings.set` accepts (QA 2026-11-25, bug 5).
 *
 * - **Typed keys** have a TypeBox schema (and an optional extra check). A value that fails is
 *   refused with `invalid_params` and `details.reason: "setting_invalid"`.
 * - **Namespaces** are the roots of the keys the app reads and writes. Under a namespace any
 *   subkey is accepted unless a typed rule or a feature validator says otherwise: features and
 *   plugins add keys at run time (`specialists.model.<role>`, `mail.accounts.<id>`...). A key
 *   whose first segment is no namespace (`no.such.key`), or that is a bare namespace holding a
 *   value (`appearance = 42`), is refused with `details.reason: "setting_unknown"`.
 * - **Feature validators** (`registerSettingValidator`) own one prefix and check or normalise the
 *   value themselves. Nothing calls it yet: `nightShift.*` (#1681) and `promises.*` (#1680) are
 *   open namespaces until those PRs register their validators, so their rules are not copied here.
 *
 * Both reasons have a catalogue sentence (`errors.reason.setting_unknown`,
 * `errors.reason.setting_invalid`), so every client words them in the owner's language. The
 * English message names the key and what was expected.
 */

export interface SettingRule {
  schema: TSchema;
  /** A short description of what is accepted, for the English message. */
  expected: string;
  /** Extra check after the schema; return a reason to refuse. */
  check?: (value: unknown) => string | undefined;
  /** `null` clears a key back to its default; allowed unless a rule says no. */
  allowNull?: boolean;
}

export type SettingValidator = (key: string, value: unknown) => unknown;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAMED_COLORS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  ),
);
const COLOR_FUNCTION =
  /^(?:oklch|oklab|lch|lab|hsla?|hwb|rgba?|color)\(\s*[0-9a-z.+\-%/,\s]{1,100}\)$/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A CSS color the Appearance picker can send: hex, a color function (`oklch(0.6 0.19 255)` is what
 * six of the eight presets are) or a named color. A server copy of the UI's `isValidSeed`
 * (packages/ui/src/theme/generate.ts), which parses with colorjs.io; this one is syntactic, with
 * a length cap, so a value the picker offers is never rolled back.
 */
export function isCssColor(value: string): boolean {
  if (value.length > 120) return false;
  return (
    HEX_COLOR.test(value) || COLOR_FUNCTION.test(value) || NAMED_COLORS.has(value.toLowerCase())
  );
}
const MESSAGE_LANGUAGES = [
  "ar",
  "de",
  "en",
  "es",
  "fr",
  "hi",
  "it",
  "ja",
  "ko",
  "pt",
  "zh",
] as const;

/** A BCP 47 tag whose language, script and region the runtime knows (`xx-NOPE` is not one). */
export function isKnownLocaleTag(tag: string): boolean {
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(tag.replace(/_/g, "-"))[0] ?? "";
  } catch {
    return false;
  }
  if (canonical === "") return false;
  const [language = "", ...rest] = canonical.split("-");
  try {
    const names = (type: "language" | "script" | "region") =>
      new Intl.DisplayNames(["en"], { type, fallback: "none" });
    if (names("language").of(language) === undefined) return false;
    for (const part of rest) {
      if (part.length === 4 && names("script").of(part) === undefined) return false;
      if ((part.length === 2 || /^\d{3}$/.test(part)) && names("region").of(part) === undefined) {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

const bool = (expected = "true or false"): SettingRule => ({
  schema: Type.Boolean(),
  expected,
});
const literals = (...values: string[]): SettingRule => ({
  schema: Type.Union(values.map((v) => Type.Literal(v))),
  expected: values.map((v) => `"${v}"`).join(", "),
});
const clock = (): SettingRule => ({
  schema: Type.String({ pattern: HHMM.source }),
  expected: "a time as HH:MM",
});
const locale = (): SettingRule => ({
  schema: Type.String({ minLength: 1, maxLength: 35 }),
  expected: '"system" or a valid language tag such as "en-GB"',
  check: (v) =>
    v === "system" || (typeof v === "string" && isKnownLocaleTag(v))
      ? undefined
      : "not a known language tag",
});

const EXACT: Record<string, SettingRule> = {
  "appearance.theme": literals("auto", "system", "light", "dark"),
  "appearance.accentSeed": {
    schema: Type.String({ minLength: 1, maxLength: 120 }),
    expected: 'a CSS color such as "#2c5aa0" or "oklch(0.6 0.19 255)"',
    check: (v) => (typeof v === "string" && isCssColor(v.trim()) ? undefined : "not a color"),
  },
  "appearance.gray": { schema: Type.String({ minLength: 1, maxLength: 40 }), expected: "a name" },
  "appearance.contrast": literals("standard", "high"),
  "appearance.reduceMotion": {
    schema: Type.Union([Type.Literal("system"), Type.Boolean()]),
    expected: '"system", true or false',
  },
  "appearance.zoom": {
    schema: Type.Number({ minimum: 67, maximum: 200 }),
    expected: "a percentage from 67 to 200",
  },
  "appearance.showInDock": bool(),
  "appearance.openAtLogin": bool(),
  "ui.language": {
    schema: Type.String({ minLength: 2, maxLength: 35 }),
    expected: '"system" or one of the available languages',
    check: (v) => {
      if (v === "system") return undefined;
      const lang = typeof v === "string" ? v.toLowerCase().replace(/_/g, "-").split("-")[0] : "";
      return (MESSAGE_LANGUAGES as readonly (string | undefined)[]).includes(lang) &&
        isKnownLocaleTag(v as string)
        ? undefined
        : "not an available language";
    },
  },
  "ui.locale": locale(),
  locale: locale(),
  "ui.direction": literals("auto", "ltr", "rtl"),
  "notifications.quietHours.enabled": bool(),
  "notifications.quietHours.start": clock(),
  "notifications.quietHours.end": clock(),
  "points.enabled": bool(),
  "agent.showReasoning": bool(),
  "specialists.maxConcurrent": {
    schema: Type.Integer({ minimum: 1, maximum: 16 }),
    expected: "a whole number from 1 to 16",
  },
};

/**
 * The first segment of every key the app uses. Under these, subkeys are open. `nightShift` and
 * `promises` are open too, until their features register validators (see {@link registerSettingValidator}).
 */
const NAMESPACES = [
  "agent",
  "appearance",
  "approvals",
  "browser",
  "capabilities",
  // `channels` is gone: chat channels were removed (2026-11-25), so `channels.*` is refused.
  "chat",
  "cleanupPeriodDays",
  "commands",
  "computerUse",
  "context",
  "daily",
  "data",
  "devices",
  "editor",
  "exec",
  "feed",
  "gateway",
  "general",
  "harness",
  "identityLinks",
  "locale",
  "mail",
  "mcp",
  "meetings",
  "memory",
  "models",
  "nightShift",
  "notifications",
  "nudges",
  "permissions",
  "persona",
  "plugins",
  "points",
  "promises",
  "quickEntry",
  "scheduled",
  "screenAsk",
  "search",
  "shortcuts",
  "specialists",
  "speech",
  "teaching",
  "threads",
  "tools",
  "ui",
  "updates",
  "usage",
  "vault",
  "vm",
  "voice",
  "widgets",
  "workflows",
] as const;

/** Namespaces that hold exactly one key (`locale`, `cleanupPeriodDays`) or whose root may hold a value. */
const LEAF_ROOTS = new Set<string>(["locale", "cleanupPeriodDays", "identityLinks"]);

export class SettingsRegistry {
  readonly #exact = new Map<string, SettingRule>(Object.entries(EXACT));
  readonly #namespaces = new Set<string>(NAMESPACES);
  readonly #validators: { prefix: string; run: SettingValidator }[] = [];

  /** Adds or replaces the typed rule of one key (a feature module's own settings). */
  registerKey(key: string, rule: SettingRule): void {
    this.#exact.set(key, rule);
  }

  /** Opens a namespace: any subkey of `root` is a known setting. */
  registerNamespace(root: string): void {
    this.#namespaces.add(root);
  }

  /**
   * A feature validator for every key that is `prefix` or starts with `prefix.`. It returns the
   * value to store (it may normalise it) and throws `PsycheError` to refuse.
   */
  registerSettingValidator(prefix: string, run: SettingValidator): void {
    this.#namespaces.add(prefix.split(".")[0] ?? prefix);
    this.#validators.push({ prefix, run });
  }

  isKnown(key: string): boolean {
    if (this.#exact.has(key)) return true;
    const root = key.split(".")[0] ?? key;
    if (!this.#namespaces.has(root)) return false;
    // A bare namespace with children (`appearance`) holds no value.
    return key !== root || LEAF_ROOTS.has(root);
  }

  /** Throws `invalid_params` for an unknown key or a bad value; returns the value to store. */
  validate(key: string, value: unknown): unknown {
    if (!this.isKnown(key)) {
      throw new PsycheError("invalid_params", `${key} is not a setting Psyche knows.`, {
        details: { reason: "setting_unknown", key },
      });
    }
    let out = value;
    for (const v of this.#validators) {
      if (key === v.prefix || key.startsWith(`${v.prefix}.`)) out = v.run(key, out);
    }
    const rule = this.#exact.get(key);
    if (rule === undefined) return out;
    // `null` clears the key back to its default, as the typed settings do.
    if (out === null && rule.allowNull !== false) return out;
    const reason = !Value.Check(rule.schema, out) ? "wrong type or range" : rule.check?.(out);
    if (reason !== undefined) {
      throw new PsycheError("invalid_params", `${key} must be ${rule.expected}.`, {
        details: { reason: "setting_invalid", key, expected: rule.expected },
      });
    }
    return out;
  }
}

/** The Gateway's registry. Feature modules extend it at composition time. */
export const settingsRegistry = new SettingsRegistry();
export const registerSettingValidator = (prefix: string, run: SettingValidator): void =>
  settingsRegistry.registerSettingValidator(prefix, run);
