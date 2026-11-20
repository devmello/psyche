import { fixtureSecret } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  checkOutbound,
  fillOutboundText,
  OUTBOUND_TAIL_CHARS,
  OUTBOUND_TEXT,
  OUTBOUND_WITHHELD_NOTICE,
  outboundTail,
  outboundText,
} from "../src/index.ts";

// Assembled at runtime so the repo secret scans never match a tracked line.
const j = (...parts: string[]) => parts.join("");
const CARD = fixtureSecret("link-virtual-card").replace(/\D/g, "");
const spaced = CARD.replace(/(\d{4})(?=\d)/g, "$1 ");
const OTP = "Your verification code is 482913";
const PASSPORT = `passport number: ${j("X123", "4567")}`;

describe("checkOutbound", () => {
  it("allows ordinary text for both audiences", () => {
    for (const audience of ["owner", "other"] as const) {
      expect(checkOutbound("Order 1234567890 ships 2026-11-18 for $12.50", audience).action).toBe(
        "allow",
      );
    }
  });

  it("other: holds on every kind, one-time codes included, and reports kinds only", () => {
    for (const text of [OTP, PASSPORT, `card ${spaced}`]) {
      const v = checkOutbound(text, "other");
      expect(v.action).toBe("hold");
      expect(JSON.stringify(v)).not.toContain("482913");
      expect(JSON.stringify(v)).not.toContain(CARD);
    }
  });

  it("owner: a one-time code is allowed; a card, a passport and a key are cut out", () => {
    expect(checkOutbound(OTP, "owner")).toEqual({ action: "allow" });
    const v = checkOutbound(`${PASSPORT}; card ${spaced}`, "owner");
    expect(v).toMatchObject({ action: "redact", kinds: expect.arrayContaining(["passport"]) });
    if (v.action === "redact") {
      expect(v.text).toBe(
        `passport number: ${OUTBOUND_WITHHELD_NOTICE}; card ${OUTBOUND_WITHHELD_NOTICE}`,
      );
    }
  });

  it("owner: only the matched spans change; marks, ZWJ emoji and fractions survive", () => {
    const original = `‏שלום ½ 👨‍👩‍👧 x² ${spaced} end`;
    const v = checkOutbound(original, "owner");
    expect(v).toMatchObject({ action: "redact" });
    if (v.action === "redact") {
      expect(v.text).toBe(`‏שלום ½ 👨‍👩‍👧 x² ${OUTBOUND_WITHHELD_NOTICE} end`);
    }
  });

  it("owner: digits in other scripts are cut out at their own position", () => {
    for (const zero of [0x660, 0x6f0, 0x966]) {
      const digits = [...CARD].map((d) => String.fromCodePoint(zero + Number(d))).join("");
      const v = checkOutbound(`pay ${digits} now`, "owner");
      expect(v).toMatchObject({ action: "redact", text: `pay ${OUTBOUND_WITHHELD_NOTICE} now` });
    }
  });

  it("owner: a match only the rendering reveals replaces the whole message", () => {
    const joined = CARD.replace(/(\d{4})/g, "**$1**");
    const v = checkOutbound(joined, "owner", (t) => t.replaceAll("**", ""));
    expect(v).toMatchObject({ action: "redact" });
    if (v.action === "redact") expect(v.text).not.toContain(CARD.slice(0, 4));
  });

  it("a number split across two messages is read as one, for the part in the new message", () => {
    const first = `my card is ${CARD.slice(0, 8)}`;
    const second = CARD.slice(8);
    expect(checkOutbound(second, "other").action).toBe("allow");
    expect(checkOutbound(second, "other", (t) => t, { tail: outboundTail(first) }).action).toBe(
      "hold",
    );
    const v = checkOutbound(`${second} thanks`, "owner", (t) => t, { tail: outboundTail(first) });
    expect(v).toMatchObject({ action: "redact", text: `${OUTBOUND_WITHHELD_NOTICE} thanks` });
  });

  it("the tail keeps the last characters only", () => {
    expect(outboundTail("x".repeat(500))).toHaveLength(OUTBOUND_TAIL_CHARS);
    expect(outboundTail("short")).toBe("short");
  });

  it("a value inside the earlier message alone does not hold the next one", () => {
    // The tail is what was already sent; only hits that reach into the new message count, in the
    // plain reading and in the rendered one (review round 2, item 2).
    const tail = `${CARD} see you`;
    expect(checkOutbound("ok thanks", "other", (t) => t, { tail }).action).toBe("allow");
    expect(checkOutbound("ok thanks", "other", (t) => t.toUpperCase(), { tail }).action).toBe(
      "allow",
    );
  });

  it("the tail reaches back over a long trailing chain of digits and keeps the card word", () => {
    const sent = `${"words ".repeat(50)}card ${"1 ".repeat(40)}`;
    const tail = outboundTail(sent);
    expect(tail).toContain("card ");
    expect(tail.endsWith("1 ".repeat(40))).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(240);
    expect(outboundTail(`${"words ".repeat(50)}the end.`)).toHaveLength(OUTBOUND_TAIL_CHARS);
  });

  it("owner: keycap digits are cut out with their marks, leaving nothing behind", () => {
    const keycaps = [...CARD].map((d) => `${d}\ufe0f\u20e3`).join("");
    const v = checkOutbound(`pay ${keycaps} now`, "owner");
    expect(v).toMatchObject({ action: "redact", text: `pay ${OUTBOUND_WITHHELD_NOTICE} now` });
  });

  it("owner: the notice is the one given, in the owner's language", () => {
    const notice = OUTBOUND_TEXT.de?.notice ?? "";
    const v = checkOutbound(`card ${spaced}`, "owner", (t) => t, { notice });
    expect(v).toMatchObject({ action: "redact", text: `card ${notice}` });
  });
});

describe("outbound text in every shipped language", () => {
  const LANGS = ["en", "ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh"];

  it("has every string in all 11 catalogues, with the placeholders intact", () => {
    expect(Object.keys(OUTBOUND_TEXT).sort()).toEqual([...LANGS].sort());
    for (const lang of LANGS) {
      const t = OUTBOUND_TEXT[lang];
      expect(t?.notice).toMatch(/Psyche/);
      expect(t?.heldTitle).not.toBe("");
      expect(t?.heldBody).toContain("{channel}");
      expect(t?.threadNote).toContain("{channel}");
      expect(t?.threadNote).toContain("{kinds}");
    }
  });

  it("picks by language, falls back to the Mac's language for 'system', and to English", () => {
    expect(outboundText("de").notice).toBe(OUTBOUND_TEXT.de?.notice);
    expect(outboundText("pt-BR").notice).toBe(OUTBOUND_TEXT.pt?.notice);
    expect(outboundText("system", "ja-JP").notice).toBe(OUTBOUND_TEXT.ja?.notice);
    expect(outboundText(undefined, undefined).notice).toBe(OUTBOUND_WITHHELD_NOTICE);
    expect(outboundText("xx").notice).toBe(OUTBOUND_WITHHELD_NOTICE);
    expect(
      fillOutboundText("{channel}: {kinds}", { channel: "imessage", kinds: ["passport"] }),
    ).toBe("imessage: passport");
  });
});

describe("a number split across two messages (review round 3)", () => {
  const g = (d: string, sep: string) => d.match(/.{1,4}/g)?.join(sep) ?? d;
  const PAIRS: [string, string, string][] = [
    ["ungrouped halves", `my card is ${CARD.slice(0, 8)}`, CARD.slice(8)],
    ["space-grouped halves", `my card is ${g(CARD.slice(0, 8), " ")}`, g(CARD.slice(8), " ")],
    ["dash-grouped halves", `my card is ${g(CARD.slice(0, 8), "-")}`, g(CARD.slice(8), "-")],
    ["three groups, then one", `card: ${g(CARD.slice(0, 12), " ")}`, CARD.slice(12)],
    ["split inside a group", `Visa ${g(CARD.slice(0, 13), " ")}`, CARD.slice(13)],
  ];
  it.each(PAIRS)("%s", (_name, first, second) => {
    expect(checkOutbound(second, "other").action).toBe("allow");
    expect(checkOutbound(second, "other", (t) => t, { tail: outboundTail(first) }).action).toBe(
      "hold",
    );
  });

  it("two ordinary messages in a row are not joined into anything", () => {
    for (const [first, second] of [
      ["see you at 10", "30 minutes later"],
      ["room 4111", "floor 2"],
      ["thanks!", "1 more thing"],
    ] as const) {
      expect(checkOutbound(second, "other", (t) => t, { tail: outboundTail(first) }).action).toBe(
        "allow",
      );
    }
  });
});
