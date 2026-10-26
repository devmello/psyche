import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/index.ts";
import { CATALOGUES } from "../src/i18n/messages/locales/index.ts";

/**
 * The voice strings in every catalogue (voice-mode-2026 §4.8, §8 V-U U4), checked per locale the
 * way the shipped catalogues were (#634): each message parses as ICU MessageFormat, names exactly
 * English's arguments, uses only its language's CLDR plural categories (with `other`), and never
 * a straight apostrophe (which starts ICU quoting). The spoken phrase lists are non-empty.
 */

const VOICE = Object.keys(en).filter(
  (id) =>
    id.startsWith("voice.") ||
    id.startsWith("settings.key.voice.conversation.") ||
    // Ask about my screen rides on the same checks.
    id.startsWith("screenAsk.") ||
    id.startsWith("settings.screenAsk.") ||
    id.startsWith("settings.key.screenAsk."),
);

interface Shape {
  args: Set<string>;
  plurals: Set<string>;
}

// biome-ignore lint/suspicious/noExplicitAny: the formatjs AST is untyped here
function walk(nodes: any[], shape: Shape): void {
  for (const n of nodes) {
    // 1 argument, 2 number, 3 date, 4 time, 5 select, 6 plural (formatjs TYPE).
    if (n.type >= 1 && n.type <= 6) shape.args.add(n.value);
    if (n.type === 5 || n.type === 6) {
      for (const [key, opt] of Object.entries(n.options) as [string, { value: unknown[] }][]) {
        if (n.type === 6) shape.plurals.add(key);
        walk(opt.value, shape);
      }
    }
    if (n.type === 8) walk(n.children, shape);
  }
}

function shapeOf(message: string, locale: string): Shape {
  const shape: Shape = { args: new Set(), plurals: new Set() };
  walk(new IntlMessageFormat(message, locale).getAst(), shape);
  return shape;
}

describe("voice strings in every catalogue", () => {
  it("has the English set", () => {
    expect(VOICE.length).toBeGreaterThan(100);
  });

  for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
    if (locale === "en") continue;
    describe(locale, () => {
      const categories = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);

      it("translates every voice id", () => {
        const missing = VOICE.filter(
          (id) => (catalogue as Record<string, string>)[id] === undefined,
        );
        expect(missing).toEqual([]);
      });

      it("parses, keeps English's arguments and its language's plural categories", () => {
        const problems: string[] = [];
        for (const id of VOICE) {
          const message = (catalogue as Record<string, string | undefined>)[id];
          if (message === undefined) continue;
          if (message.includes("'")) problems.push(`${id}: straight apostrophe`);
          let mine: Shape;
          try {
            mine = shapeOf(message, locale);
          } catch (e) {
            problems.push(`${id}: ${(e as Error).message}`);
            continue;
          }
          const theirs = shapeOf((en as Record<string, string>)[id] as string, "en");
          const a = [...mine.args].sort().join(",");
          const b = [...theirs.args].sort().join(",");
          if (a !== b) problems.push(`${id}: arguments ${a} ≠ ${b}`);
          for (const p of mine.plurals) {
            if (!p.startsWith("=") && !categories.has(p as Intl.LDMLPluralRule))
              problems.push(`${id}: plural category ${p} isn't ${locale}'s`);
          }
          if (theirs.plurals.size > 0 && !mine.plurals.has("other"))
            problems.push(`${id}: plural without other`);
        }
        expect(problems).toEqual([]);
      });

      it("lists the spoken phrases", () => {
        for (const list of ["approve", "deny", "trailing"]) {
          const phrases = ((catalogue as Record<string, string>)[`voice.phrases.${list}`] ?? "")
            .split("|")
            .map((p) => p.trim())
            .filter((p) => p !== "");
          expect(phrases.length, `${locale} voice.phrases.${list}`).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});
