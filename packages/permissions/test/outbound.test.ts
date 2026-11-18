import { fixtureSecret } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  checkOutbound,
  OUTBOUND_TAIL_CHARS,
  OUTBOUND_WITHHELD_NOTICE,
  outboundTail,
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
});
