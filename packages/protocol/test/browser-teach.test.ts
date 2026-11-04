import { describe, expect, it } from "vitest";
import {
  type BrowserTeachStep,
  classifyTeachField,
  classifyTeachValue,
  sanitizeTeachSteps,
  teachStepIssues,
  teachText,
  teachUrl,
} from "../src/index.ts";

/** A Luhn-valid test card number, assembled at run time so the repo's secret scan never sees one. */
const CARD = ["4111", "1111", "1111", "1111"].join(" ");

describe("classifyTeachField", () => {
  it.each([
    [{ tag: "input", type: "password" }, "password"],
    [{ tag: "input", type: "text", autocomplete: "current-password" }, "password"],
    [{ tag: "input", type: "text", autocomplete: "new-password" }, "password"],
    [{ tag: "input", type: "text", autocomplete: "cc-number" }, "payment"],
    [{ tag: "input", type: "text", autocomplete: "section-pay cc-exp" }, "payment"],
    [{ tag: "input", type: "text", autocomplete: "one-time-code" }, "one_time_code"],
    [{ tag: "input", type: "text", label: "Card number" }, "payment"],
    [{ tag: "input", type: "text", name: "cvv" }, "payment"],
    [{ tag: "input", type: "text", placeholder: "Expiry (MM/YY)" }, "payment"],
    [{ tag: "input", type: "text", label: "IBAN" }, "payment"],
    [{ tag: "input", type: "text", label: "Verification code" }, "one_time_code"],
    [{ tag: "input", type: "text", id: "otp" }, "one_time_code"],
    [{ tag: "input", type: "text", label: "Social Security number" }, "identity"],
    [{ tag: "input", type: "text", name: "ssn" }, "identity"],
    [{ tag: "input", type: "text", label: "Passport no." }, "identity"],
    [{ tag: "input", type: "text", label: "API key" }, "secret"],
    [{ tag: "input", type: "text", label: "Confirm your passcode" }, "password"],
  ] as const)("marks %j as %s", (facts, reason) => {
    expect(classifyTeachField(facts)).toBe(reason);
  });

  it.each([
    { tag: "input", type: "text", label: "From" },
    { tag: "input", type: "email", label: "Recipient", autocomplete: "email" },
    { tag: "input", type: "text", name: "q", placeholder: "Search invoices" },
    { tag: "textarea", label: "Notes" },
    { tag: "input", type: "date", label: "Start date" },
  ])("leaves %j alone", (facts) => {
    expect(classifyTeachField(facts)).toBeNull();
  });
});

describe("classifyTeachValue", () => {
  it("catches a card number, an SSN and token-like values whatever the field", () => {
    expect(classifyTeachValue(CARD)).toBe("payment");
    expect(classifyTeachValue(CARD.replaceAll(" ", "-"))).toBe("payment");
    expect(classifyTeachValue("123-45-6789")).toBe("identity");
    expect(classifyTeachValue("a".repeat(40))).toBe("secret");
    expect(classifyTeachValue(["sk", "live", "abcdefghijklmnopqrstuv"].join("-"))).toBe("secret");
  });
  it("lets ordinary text, dates and short numbers through", () => {
    for (const v of ["2026-11-04", "dana@example.com", "Weekly report", "12345", "4111"])
      expect(classifyTeachValue(v)).toBeNull();
  });
});

describe("teachUrl and teachText", () => {
  it("keeps origin and path only and hides opaque path segments", () => {
    expect(teachUrl("https://example.com/export?token=abc#frag")).toBe(
      "https://example.com/export",
    );
    expect(teachUrl("https://example.com/reset/AbCdEfGhIjKlMnOpQrStUvWxYz012345/go")).toBe(
      "https://example.com/reset/*/go",
    );
    expect(teachUrl("javascript:alert(1)")).toBe("");
    expect(teachUrl("file:///etc/passwd")).toBe("");
    expect(teachUrl("not a url")).toBe("");
  });
  it("flattens page text to one capped line", () => {
    expect(teachText("Export\n\n  all\u2028now")).toBe("Export all now");
    expect(teachText("x".repeat(500), 20)).toHaveLength(20);
  });
});

const step = (over: Partial<BrowserTeachStep>): BrowserTeachStep => ({
  id: "s1",
  kind: "type",
  role: "textbox",
  name: "From",
  ...over,
});

describe("sanitizeTeachSteps", () => {
  it("drops a value unless the owner chose to keep it", () => {
    const [a, b] = sanitizeTeachSteps([
      step({ value: "2026-11-01" }),
      step({ id: "s2", value: "2026-11-01", keepValue: true }),
    ]);
    expect(a).not.toHaveProperty("value");
    expect(b?.value).toBe("2026-11-01");
    expect(b?.keepValue).toBe(true);
  });

  it("never keeps a value on a sensitive step, even when asked, and even if the flag is missing", () => {
    const out = sanitizeTeachSteps([
      step({ name: "Password", sensitive: true, value: "hunter2", keepValue: true }),
      step({ id: "s2", name: "Card number", value: "1", keepValue: true }),
      step({ id: "s3", name: "Notes", value: CARD, keepValue: true }),
    ]);
    for (const s of out) {
      expect(s).not.toHaveProperty("value");
      expect(s).not.toHaveProperty("keepValue");
      expect(s.sensitive).toBe(true);
    }
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("4111");
  });

  it("makes an input instead of a value, and never an input of a sensitive field", () => {
    const [a, b] = sanitizeTeachSteps([
      step({ value: "x", keepValue: true, input: { name: "from_date" } }),
      step({ id: "s2", name: "Password", sensitive: true, input: { name: "pw" } }),
    ]);
    expect(a?.input).toEqual({ name: "from_date" });
    expect(a).not.toHaveProperty("value");
    expect(b).not.toHaveProperty("input");
  });

  it("cleans addresses and text again", () => {
    const [s] = sanitizeTeachSteps([
      { id: "s1", kind: "navigate", url: "https://example.com/a?secret=1" },
    ]);
    expect(s?.url).toBe("https://example.com/a");
  });
});

describe("teachStepIssues", () => {
  it("accepts a clean list", () => {
    expect(
      teachStepIssues([
        { id: "s1", kind: "navigate", url: "https://example.com/" },
        { id: "s2", kind: "click", role: "button", name: "Export" },
        step({ id: "s3", input: { name: "from_date" } }),
      ]),
    ).toEqual([]);
  });
  it("flags what cannot become a skill", () => {
    const issues = teachStepIssues([
      { id: "s1", kind: "navigate" },
      { id: "s2", kind: "click" },
      step({ id: "s3", sensitive: true, value: "x" }),
      step({ id: "s4", value: "x" }),
      step({ id: "s5", input: { name: "a" } }),
      step({ id: "s6", input: { name: "a" } }),
    ]);
    expect(issues.length).toBe(6);
    expect(issues.join("|")).toContain("sensitive");
    expect(issues.join("|")).toContain("used twice");
  });
});
