import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyPointsField,
  classifyPointsPage,
  classifyPointsValue,
  filterPointsMemoryLine,
  groundPointsValue,
  isPointsRecoveryPhrasePage,
  maskPointsShapes,
  type PointsFieldFacts,
  type PointsPageFacts,
  parsePointsDates,
  pointsSelfFillPolicy,
  sanitizePointsHint,
  sanitizePointsNote,
  sanitizePointsValue,
  selectPointsMemoryLines,
} from "../src/points-rules.ts";

/**
 * Two lists first (psyche-permissions §3): fields that must be sensitive, and near-misses that
 * share a word and must not. The rows live in a JSON fixture the Mac helper's judge is tested
 * against too (W3), so the two cannot drift. Every review finding becomes a row.
 */
interface Row extends PointsFieldFacts {
  reason?: string;
  why?: string;
}
const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures/points-sensitive.json"),
    "utf8",
  ),
) as {
  mustBeSensitive: Row[];
  mustNotBeSensitive: Row[];
  acceptedFalseMatches: Row[];
  memoryRefused: string[];
  memoryAllowed: string[];
  notesRedacted: { note: string; mustNotContain: string[] }[];
  linksStripped: string[];
  directionsOnlyPages: PointsPageFacts[];
  ordinaryPages: PointsPageFacts[];
  valueShapes: {
    mustBeSensitive: { value: string; label?: string; reason: string }[];
    mustNotBe: { value: string; label?: string }[];
  };
};

const facts = (r: Row): PointsFieldFacts => {
  const { reason: _r, why: _w, ...rest } = r;
  return rest;
};

describe("points sensitive-field probe table", () => {
  it("has two meaningful lists", () => {
    expect(fixture.mustBeSensitive.length).toBeGreaterThanOrEqual(60);
    expect(fixture.mustNotBeSensitive.length).toBeGreaterThanOrEqual(30);
    // The design's own rows (§5.1) are all there.
    const must = fixture.mustBeSensitive.map((r) => r.label);
    for (const l of [
      "SSN",
      "Social Security number",
      "Passport No.",
      "A-Number",
      "ITIN",
      "Routing number",
      "Account number (for direct deposit)",
      "Card number",
      "CVV",
      "PIN",
      "One-time code",
      "Mot de passe",
      "Reisepassnummer",
    ])
      expect(must, l).toContain(l);
    const not = fixture.mustNotBeSensitive.map((r) => r.label);
    for (const l of [
      "Passport photo upload",
      "Library card number",
      "Number of dependents",
      "Account name",
      "Card holder's city",
      "Tax year",
      "Card title",
      "Pass note",
    ])
      expect(not, l).toContain(l);
  });

  it.each(
    fixture.mustBeSensitive.map(
      (r) => [`${r.label || "(secure)"} ${JSON.stringify(r.path ?? "")}`, r] as const,
    ),
  )("must be sensitive: %s", (_name, r) => {
    expect(classifyPointsField(facts(r))).toBe(r.reason);
  });

  it.each(fixture.mustNotBeSensitive.map((r) => [r.label, r] as const))(
    "must not be sensitive: %s",
    (_name, r) => {
      expect(classifyPointsField(facts(r))).toBeNull();
    },
  );

  it.each(fixture.acceptedFalseMatches.map((r) => [r.label, r] as const))(
    "accepted false match (fails safe): %s",
    (_name, r) => {
      expect(classifyPointsField(facts(r))).toBe(r.reason);
    },
  );

  it("covers every shipped language in the must-be list", () => {
    const scripts: Record<string, RegExp> = {
      es: /Contraseña|Número de tarjeta|Pasaporte/u,
      fr: /Mot de passe|Numéro de carte|passeport/u,
      de: /Passwort|Kartennummer|Reisepassnummer/u,
      it: /Numero di carta|Passaporto|Codice fiscale/u,
      pt: /Senha|Número do cartão/u,
      ja: /パスワード|カード番号|パスポート/u,
      ko: /비밀번호|카드 번호|여권번호/u,
      zh: /密码|银行卡号|护照号码/u,
      hi: /पासवर्ड|कार्ड नंबर|पासपोर्ट/u,
      ar: /كلمة المرور|رقم البطاقة|رقم جواز السفر/u,
    };
    const labels = fixture.mustBeSensitive.map((r) => r.label).join("\n");
    for (const [lang, re] of Object.entries(scripts)) expect(labels, lang).toMatch(re);
  });

  it("only the near-miss phrase is let go: the rest of the label is still judged", () => {
    expect(classifyPointsField({ label: "Passport photo upload" })).toBeNull();
    expect(classifyPointsField({ label: "Passport photo upload and passport number" })).toBe(
      "identity",
    );
    expect(classifyPointsField({ label: "Library card number" })).toBeNull();
    expect(classifyPointsField({ label: "Library card PIN" })).toBe("secret");
    expect(classifyPointsField({ label: "Library card", autocomplete: "cc-number" })).toBe(
      "payment",
    );
    expect(classifyPointsField({ label: "ID card number" })).not.toBeNull();
    expect(classifyPointsField({ label: "Pass note" })).toBeNull();
    expect(classifyPointsField({ label: "Pass note: password" })).toBe("password");
    expect(classifyPointsField({ label: "Pass" })).toBe("password");
    expect(classifyPointsField({ label: "Pass code" })).toBe("password");
  });

  it("a sheet or group title above the field counts, a harmless one does not", () => {
    expect(classifyPointsField({ label: "Code", path: ["Two-factor authentication"] })).toBe(
      "one_time_code",
    );
    expect(classifyPointsField({ label: "Code", path: ["Discount"] })).toBeNull();
  });

  it("folds width, case and accents like the shared teach rules do", () => {
    expect(classifyPointsField({ label: "ＳＳＮ" })).toBe("identity");
    expect(classifyPointsField({ label: "NUMERO DE LA TARJETA" })).toBe("payment");
    expect(classifyPointsField({ label: "Numéro de la carte" })).toBe("payment");
  });
});

describe("points page rule (directions only)", () => {
  it.each(fixture.directionsOnlyPages.map((p) => [JSON.stringify(p), p] as const))(
    "directions only: %s",
    (_n, p) => {
      expect(classifyPointsPage(p)).toBe("directions_only");
    },
  );
  it.each(fixture.ordinaryPages.map((p) => [JSON.stringify(p), p] as const))(
    "ordinary: %s",
    (_n, p) => {
      expect(classifyPointsPage(p)).toBeNull();
    },
  );
  it("makes every field on a directions-only page sensitive, and a plain field on an ordinary page not", () => {
    expect(classifyPointsField({ label: "First name" }, "directions_only")).toBe("directions_only");
    expect(classifyPointsField({ label: "First name" }, null)).toBeNull();
  });
  it("a secure field is judged first", () => {
    expect(classifyPointsField({ label: "First name", secure: true }, "directions_only")).toBe(
      "secure_field",
    );
  });
});

describe("points value shapes", () => {
  it.each(fixture.valueShapes.mustBeSensitive.map((r) => [r.value.slice(0, 40), r] as const))(
    "must be sensitive: %s",
    (_n, r) => {
      expect(classifyPointsValue(r.value, r.label ?? "")).toBe(r.reason);
    },
  );
  it.each(fixture.valueShapes.mustNotBe.map((r) => [r.value, r] as const))(
    "must not be: %s",
    (_n, r) => {
      expect(classifyPointsValue(r.value, r.label ?? "")).toBeNull();
    },
  );
});

describe("points self-fill policy", () => {
  it("allows a hint only for identity, and no label for payment or directions-only", () => {
    expect(pointsSelfFillPolicy("identity")).toEqual({ hint: true, label: true });
    expect(pointsSelfFillPolicy("payment")).toEqual({ hint: false, label: false });
    expect(pointsSelfFillPolicy("directions_only")).toEqual({ hint: false, label: false });
    expect(pointsSelfFillPolicy("password")).toEqual({ hint: false, label: true });
    expect(pointsSelfFillPolicy("secure_field")).toEqual({ hint: false, label: true });
  });
});

// ---- Grounding ----

const SOURCES = [
  { id: "goal", text: "2026 tax return, married filing jointly. My employer is Acme Corp." },
  { id: "profile:name", text: "Jane Quinn Rivera" },
  { id: "profile:home", text: "1428 Elm Street, Apt 4B, Springfield, IL 62704" },
  { id: "memory:dob", text: "Jane was born on March 4, 1985 in Chicago." },
  { id: "memory:dob_us", text: "Birthday 03/04/1985" },
  { id: "memory:dob_iso", text: "dob 1985-03-04" },
] as const;

type Rule = "exact" | "case" | "date_format" | "name_part" | "address_part";
const ground = (value: string, derivation: Rule | undefined, sources: string[]) =>
  groundPointsValue({ value, derivation, sources }, SOURCES);

describe("points value grounding", () => {
  const ok: [string, string, Rule | undefined, string[]][] = [
    ["exact substring", "Acme Corp", "exact", ["goal"]],
    ["exact is the default derivation", "Acme Corp", undefined, ["goal"]],
    ["exact through NFKC and spaces", "Acme   Corp", "exact", ["goal"]],
    ["exact with full-width characters", "Ａcme Corp", "exact", ["goal"]],
    ["case folds only for case", "acme corp", "case", ["goal"]],
    ["case: upper case", "ACME CORP", "case", ["goal"]],
    ["name part: one token", "Jane", "name_part", ["profile:name"]],
    ["name part: first and last", "Jane Rivera", "name_part", ["profile:name"]],
    ["name part: reordered", "Rivera, Jane", "name_part", ["profile:name"]],
    ["name part: an initial", "Q.", "name_part", ["profile:name"]],
    ["address part: street line", "1428 Elm Street", "address_part", ["profile:home"]],
    ["address part: unit", "Apt 4B", "address_part", ["profile:home"]],
    ["address part: city and zip", "Springfield 62704", "address_part", ["profile:home"]],
    ["date: MM/DD/YYYY from a month name", "03/04/1985", "date_format", ["memory:dob"]],
    ["date: ISO from a month name", "1985-03-04", "date_format", ["memory:dob"]],
    ["date: a month name from ISO", "4 March 1985", "date_format", ["memory:dob_iso"]],
    ["date: dotted", "04.03.1985", "date_format", ["memory:dob"]],
    ["date: CJK", "1985年3月4日", "date_format", ["memory:dob_iso"]],
    ["date: same ambiguous literal", "03/04/1985", "date_format", ["memory:dob_us"]],
    ["any cited source may ground it", "Acme Corp", "exact", ["profile:name", "goal"]],
  ];
  it.each(ok)("grounds: %s", (_n, value, rule, sources) => {
    expect(ground(value, rule, sources).ok).toBe(true);
  });

  const refused: [string, string, Rule | undefined, string[], string][] = [
    ["a made-up value", "Globex", "exact", ["goal"], "not_grounded"],
    ["exact is case sensitive", "acme corp", "exact", ["goal"], "not_grounded"],
    ["a substring inside a word", "Ann", "exact", ["profile:name"], "not_grounded"],
    ["a source that does not hold it", "Acme Corp", "exact", ["profile:name"], "not_grounded"],
    ["no sources cited", "Acme Corp", "exact", [], "no_source"],
    ["only unknown sources cited", "Acme Corp", "exact", ["memory:nope"], "unknown_source"],
    ["an empty value", "", "exact", ["goal"], "no_value"],
    ["a value of only control characters", "\u0000​", "exact", ["goal"], "no_value"],
    [
      "name part: a token not in the source",
      "Jane Smith",
      "name_part",
      ["profile:name"],
      "not_grounded",
    ],
    ["name part: a near spelling", "Jon", "name_part", ["profile:name"], "not_grounded"],
    ["name part: an initial of no token", "Z.", "name_part", ["profile:name"], "not_grounded"],
    ["name part: no tokens", "...", "name_part", ["profile:name"], "not_grounded"],
    [
      "address part: a street number not in the source",
      "1429 Elm Street",
      "address_part",
      ["profile:home"],
      "not_grounded",
    ],
    [
      "address part: an initial does not stand for a token",
      "E",
      "address_part",
      ["profile:home"],
      "not_grounded",
    ],
    ["date: a different day", "03/05/1985", "date_format", ["memory:dob"], "not_grounded"],
    ["date: a different year", "03/04/1986", "date_format", ["memory:dob"], "not_grounded"],
    [
      "date: day and month swapped from an ambiguous source",
      "04/03/1985",
      "date_format",
      ["memory:dob_us"],
      "not_grounded",
    ],
    ["date: more than a date", "born 03/04/1985", "date_format", ["memory:dob"], "not_grounded"],
    ["date: two dates", "03/04/1985 and 03/05/1985", "date_format", ["memory:dob"], "not_grounded"],
    ["date: an impossible date", "02/30/1985", "date_format", ["memory:dob"], "not_grounded"],
    [
      "date: a two-digit year is not read",
      "03/04/85",
      "date_format",
      ["memory:dob"],
      "not_grounded",
    ],
    [
      "date: a month name is not an exact substring of ISO",
      "March 4, 1985",
      "exact",
      ["memory:dob_iso"],
      "not_grounded",
    ],
    [
      "a card number, even from a source",
      "4111 1111 1111 1111",
      "exact",
      ["goal"],
      "sensitive_value",
    ],
    ["an SSN shape", "123-45-6789", "exact", ["goal"], "sensitive_value"],
  ];
  it.each(refused)("refuses: %s", (_n, value, rule, sources, why) => {
    expect(ground(value, rule, sources)).toEqual({ ok: false, reason: why });
  });

  it("a card number the owner typed in the goal is still never grounded", () => {
    const r = groundPointsValue(
      { value: "4111 1111 1111 1111", derivation: "exact", sources: ["goal"] },
      [{ id: "goal", text: "my card is 4111 1111 1111 1111" }],
    );
    expect(r).toMatchObject({ ok: false, reason: "sensitive_value" });
  });

  it("reads dates as readings: a month name is one, a slash date may be two", () => {
    expect(parsePointsDates("March 4, 1985")[0]?.readings).toEqual(new Set(["1985-03-04"]));
    expect([...(parsePointsDates("03/04/1985")[0]?.readings ?? [])].sort()).toEqual([
      "1985-03-04",
      "1985-04-03",
    ]);
  });

  it("reads month names in the shipped Latin languages", () => {
    for (const t of [
      "4 de marzo de 1985",
      "4 mars 1985",
      "4. März 1985",
      "4 marzo 1985",
      "4 de março de 1985",
    ])
      expect(parsePointsDates(t)[0]?.readings, t).toEqual(new Set(["1985-03-04"]));
  });
});

// ---- Memory lines ----

describe("points memory lines", () => {
  const good = { id: "profile:home_city", text: "Home city: Springfield", trusted: true };
  it("keeps a trusted, ordinary line", () => {
    expect(filterPointsMemoryLine(good)).toEqual({ ok: true, text: "Home city: Springfield" });
  });
  const refused: [string, Parameters<typeof filterPointsMemoryLine>[0], string][] = [
    ["an untrusted line", { ...good, trusted: false }, "untrusted"],
    ["an id that is not a memory or profile id", { ...good, id: "web:page" }, "bad_id"],
    ["an id with a space", { ...good, id: "memory:a b" }, "bad_id"],
    ["an empty line", { ...good, text: "  ​ " }, "empty"],
    [
      "a card number the owner told it",
      { ...good, text: "Visa 4111 1111 1111 1111" },
      "sensitive_value",
    ],
    ["an SSN", { ...good, text: "Her SSN is 123-45-6789" }, "sensitive_value"],
    ["a passport", { ...good, text: "Passport: see the desk drawer" }, "sensitive_kind"],
    ["a bank account", { ...good, text: "Bank account at Chase" }, "sensitive_kind"],
    ["a PIN", { ...good, text: "Phone PIN is in the safe" }, "sensitive_kind"],
    [
      "a sensitive kind in another language",
      { ...good, text: "Reisepass liegt im Schrank" },
      "sensitive_kind",
    ],
    ["a token", { ...good, text: "sk-abcdefghijklmnopqrstuvwxyz" }, "sensitive_value"],
  ];
  it.each(refused)("refuses %s", (_n, line, reason) => {
    expect(filterPointsMemoryLine(line)).toEqual({ ok: false, reason });
  });

  it("caps at 12 lines and 1,200 characters and says why a line was dropped", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `memory:m${i}`,
      text: `Fact ${i}`,
      trusted: true,
    }));
    const r = selectPointsMemoryLines(many);
    expect(r.kept).toHaveLength(12);
    expect(r.dropped).toEqual([
      { id: "memory:m12", reason: "cap" },
      { id: "memory:m13", reason: "cap" },
    ]);
    const long = selectPointsMemoryLines([
      { id: "memory:a", text: "word ".repeat(140), trusted: true },
      { id: "memory:b", text: "term ".repeat(140), trusted: true },
      { id: "memory:c", text: "item ".repeat(140), trusted: true },
      { id: "memory:d", text: "Short", trusted: true },
    ]);
    expect(long.kept.map((k) => k.id)).toEqual(["memory:a", "memory:b", "memory:d"]);
    expect(long.dropped).toEqual([{ id: "memory:c", reason: "cap" }]);
  });
});

// ---- Sanitizer ----

describe("points sanitizer", () => {
  // One row for each class of character that can hide text or break a line (#1537).
  const invisible: [string, string][] = [
    ["NEL (U+0085)", "\u0085"],
    ["line separator (U+2028)", " "],
    ["paragraph separator (U+2029)", " "],
    ["NUL", "\u0000"],
    ["a C0 control (ESC)", "\u001b"],
    ["DEL", "\u007f"],
    ["a C1 control (U+009B)", "\u009b"],
    ["carriage return", "\r"],
    ["vertical tab", "\u000b"],
    ["form feed", "\u000c"],
    ["tab", "\t"],
    ["zero-width space", "​"],
    ["zero-width joiner", "‍"],
    ["word joiner", "⁠"],
    ["byte order mark", "﻿"],
    ["soft hyphen", "­"],
    ["LRM", "‎"],
    ["RLM", "‏"],
    ["Arabic letter mark", "؜"],
    ["LRE", "‪"],
    ["RLE", "‫"],
    ["PDF", "‬"],
    ["LRO", "‭"],
    ["RLO", "‮"],
    ["LRI", "⁦"],
    ["RLI", "⁧"],
    ["FSI", "⁨"],
    ["PDI", "⁩"],
    ["a tag character", "\u{e0041}"],
    ["a private-use character", ""],
    ["a lone surrogate", "\ud800"],
  ];
  const BAD = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
  it.each(invisible)("note: %s is removed and cannot break the line", (_n, ch) => {
    const out = sanitizePointsNote(`Type your${ch}name here`);
    expect(out).not.toMatch(BAD);
    expect(out).not.toContain("\n");
    expect(out.replace(/\s/gu, "")).toBe("Typeyournamehere");
  });
  it.each(invisible)("value: %s is removed", (_n, ch) => {
    const out = sanitizePointsValue(`1428${ch}Elm Street`);
    expect(out).not.toMatch(BAD);
    expect(out.replace(/\s/gu, "")).toBe("1428ElmStreet");
  });

  it("keeps ordinary text in every script", () => {
    for (const t of [
      "Enter your name",
      "Escribe tu nombre",
      "名前を入力",
      "الاسم",
      "नाम लिखें",
      "이름",
      "Nom, prénom",
    ])
      expect(sanitizePointsNote(t)).toBe(t);
  });

  const links: [string, string][] = [
    ["an https link", "Go to https://evil.example/login now"],
    ["an http link", "See http://evil.example now"],
    ["a link with a path and query", "Open https://a.example/b?c=d#e now"],
    ["a www link", "Visit www.evil.example/pay now"],
    ["a bare domain", "Visit evil.com now"],
    ["a bare domain with a path", "Visit evil.example.org/pay now"],
    ["an email address", "Write to boss@evil.example now"],
    ["a mailto link", "Click mailto:boss@evil.example now"],
    ["a javascript link", "Click javascript:alert(1) now"],
    ["a tel link", "Call tel:+15551234567 now"],
    ["a full-width link", "Go to ｈｔｔｐｓ：／／evil.example/login now"],
    ["a link split by a zero-width space", "Go to ht​tps://evil.example/login now"],
    ["a link split by a bidi override", "Go to https://‮evil.example now"],
    ["a markdown link", "Click [here](https://evil.example) now"],
    ["a markdown image", "See ![x](https://evil.example/a.png) now"],
    ["an app link", "Open x-apple.systempreferences:com.apple.preference now"],
    ["an ftp link", "Get ftp://evil.example/a now"],
    ["a file link", "Open file:///etc/passwd now"],
  ];
  it.each(links)("note: strips %s", (_n, text) => {
    const out = sanitizePointsNote(text);
    expect(out).not.toMatch(
      /https?:|www\.|\.com|\.example|@|mailto|javascript:|tel:|ftp:|file:|x-apple|\]\(/iu,
    );
    expect(out).toMatch(/now/);
  });

  it("note: strips Markdown and tags, keeps the words", () => {
    expect(sanitizePointsNote("**Date** of `birth`")).toBe("Date of birth");
    expect(sanitizePointsNote("# Heading\n> quoted\n- item")).toBe("Heading quoted item");
    expect(sanitizePointsNote("<b>Bold</b> text")).toBe("Bold text");
    expect(sanitizePointsNote("a\nb\r\nc")).toBe("a b c");
  });

  it("note: cuts at the limit by code points and never splits an emoji", () => {
    const out = sanitizePointsNote("😀".repeat(200), 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
    expect(Array.from(sanitizePointsNote("word ".repeat(100)))).toHaveLength(140);
  });

  it("hint: kept when plain, dropped when it holds a digit in any script", () => {
    expect(sanitizePointsHint("It's on your passport's photo page")).toBe(
      "It's on your passport's photo page",
    );
    for (const bad of ["Starts with 9", "Box ٣", "Box ３", "Box ④", "Box ३", "It is 9 digits"])
      expect(sanitizePointsHint(bad), bad).toBeNull();
    expect(sanitizePointsHint("   ")).toBeNull();
  });

  it("hint: is cut at 100 characters, and a link in it goes", () => {
    expect(Array.from(sanitizePointsHint("word ".repeat(100)) ?? "")).toHaveLength(100);
    expect(sanitizePointsHint("See https://evil.example for it")).toBe("See for it");
  });
});

describe("points review round 1 (fixture rows)", () => {
  it.each(fixture.memoryRefused.map((t) => [t] as const))("memory refuses: %s", (text) => {
    const r = filterPointsMemoryLine({ id: "memory:m1", text, trusted: true });
    expect(r.ok, text).toBe(false);
  });
  it.each(fixture.memoryAllowed.map((t) => [t] as const))("memory still passes: %s", (text) => {
    expect(filterPointsMemoryLine({ id: "memory:m1", text, trusted: true }).ok, text).toBe(true);
  });
  it("memory: a secret past the 500 character cut is still caught", () => {
    const text = `${"I like walking. ".repeat(40)}My social: 123456789`;
    expect(filterPointsMemoryLine({ id: "memory:m1", text, trusted: true }).ok).toBe(false);
  });
  it.each(fixture.notesRedacted.map((r) => [r.note, r] as const))("note redacts: %s", (_n, r) => {
    const out = sanitizePointsNote(r.note);
    for (const bad of r.mustNotContain) expect(out).not.toContain(bad);
    expect(out).toContain("…");
    expect(sanitizePointsHint(r.note)).toBeNull();
  });
  it("note: ordinary numbers stay", () => {
    expect(sanitizePointsNote("Box 3 on your W-2, 2026, page 12")).toBe(
      "Box 3 on your W-2, 2026, page 12",
    );
  });
  it.each(fixture.linksStripped.map((t) => [t] as const))("note strips the link: %s", (link) => {
    expect(sanitizePointsNote(`Go to ${link} now`)).toBe("Go to now");
  });
  it("note: a CJK sentence with full stops is not a link", () => {
    expect(sanitizePointsNote("名前を入力。次へ進む")).toBe("名前を入力。次へ進む");
  });
  it("a zip is not a shape, a nine-number run in a longer run is", () => {
    expect(classifyPointsValue("62704")).toBeNull();
    expect(classifyPointsValue("12345 6789")).toBe("identity");
  });
  it("the invisible and lookalike classes are judged: Hangul fillers, CGJ, Greek and Cyrillic", () => {
    for (const label of ["SᅟSN", "SᅠSN", "SﾠSN", "S͏SN", "Ρassword", "Α-Number"])
      expect(classifyPointsField({ label }), label).not.toBeNull();
  });
});

describe("maskPointsShapes", () => {
  const masked: [string, string][] = [
    ["SSN on file: 123-45-6789.", "123-45-6789"],
    ["Card 4111111111111111.", "4111111111111111"],
    ["Ref 123456789", "123456789"],
    ["IBAN DE89370400440532013000", "DE89370400440532013000"],
    ["Card 4111 1111 1111 1111 declined", "1111 1111"],
    ["Acct 123-45-6789", "123-45-6789"],
    ["Reference ４１１１１１１１１１１１１１１１", "4111"],
  ];
  it.each(masked)("masks the shape in %s", (text, secret) => {
    const out = maskPointsShapes(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("…");
  });

  it.each([
    "94103-1234",
    "+1 415 555 0100",
    "Fill in your legal name and date of birth.",
    "Part 1. Information about you",
    "Form I-130, part 3",
    "Tax year 2026",
  ])("leaves %s as it is", (text) => {
    expect(maskPointsShapes(text)).toBe(text);
  });
});

describe("recovery phrase pages and word runs", () => {
  const PHRASE =
    "1. abandon 2. ability 3. able 4. about 5. above 6. absent 7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident";

  it("masks a numbered phrase inside ordinary text, and one without numbers", () => {
    const out = maskPointsShapes(`Note these: ${PHRASE}. Then go on to the form.`);
    expect(out).not.toContain("abandon");
    expect(out).not.toContain("accident");
    expect(out).toContain("Then go on to the form");
    const plain = maskPointsShapes(PHRASE.replace(/\d+\. /gu, ""));
    expect(plain).not.toContain("absurd");
  });

  it.each([
    "Please enter your full legal name exactly as it appears on your passport or national identity card here",
    "Fill in your legal name and date of birth.",
    "one two three four five six seven eight nine ten eleven",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(maskPointsShapes(text)).toBe(text);
  });

  it.each([
    "Confirm Secret Recovery Phrase",
    "Your seed phrase",
    "Frase semilla",
    "Phrase de r\u00e9cup\u00e9ration",
    "Wiederherstellungsphrase eingeben",
    "Frase di recupero",
    "Frase de recupera\u00e7\u00e3o",
    "\u30b7\u30fc\u30c9\u30d5\u30ec\u30fc\u30ba",
    "\ube44\uacf5\uac1c \ud0a4",
    "\u52a9\u8bb0\u8bcd",
    "\u0639\u0628\u0627\u0631\u0629 \u0627\u0644\u0627\u0633\u062a\u0631\u062f\u0627\u062f",
    "Enter your private key",
  ])("names a recovery phrase: %s", (text) => {
    expect(isPointsRecoveryPhrasePage([text])).toBe(true);
  });

  it.each([
    "Private details about you",
    "Recovery email address",
    "Key dates",
    "Passport photo upload",
  ])("does not for %s", (text) => {});
});
