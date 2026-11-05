import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { TEACH_BINDING, teachCaptureScript } from "../src/teach/capture-script.ts";

/**
 * The page script runs in the page's isolated world, so it is tested here against a small fake
 * DOM: elements with the handful of properties it reads. `reads` records which properties of an
 * element the script touched, so a sensitive field can be shown to have its `value` never read.
 */

type Attrs = Record<string, string>;

class El {
  nodeType = 1;
  parentElement: El | null = null;
  previousElementSibling: El | null = null;
  labels: El[] = [];
  options: { selected: boolean; label: string; text: string }[] = [];
  multiple = false;
  isContentEditable = false;
  textSecurity: string | undefined;
  reads: string[] = [];
  #value = "";
  readonly tagName: string;
  readonly attrs: Attrs;
  textContent: string;
  constructor(tagName: string, attrs: Attrs = {}, textContent = "") {
    this.tagName = tagName;
    this.attrs = attrs;
    this.textContent = textContent;
  }
  get id() {
    return this.attrs.id ?? "";
  }
  get type() {
    return this.attrs.type ?? (this.tagName === "INPUT" ? "text" : "");
  }
  get name() {
    return this.attrs.name ?? "";
  }
  get value() {
    this.reads.push("value");
    return this.#value;
  }
  set value(v: string) {
    this.#value = v;
  }
  getAttribute(n: string) {
    return n in this.attrs ? (this.attrs[n] ?? null) : null;
  }
  closest(sel: string): El | null {
    for (let n: El | null = this; n !== null; n = n.parentElement) if (matches(n, sel)) return n;
    return null;
  }
}

/** Just enough selector matching for the script's INTERACTIVE list and `label`. */
function matches(el: El, sel: string): boolean {
  return sel.split(",").some((one) => {
    const m = /^([a-z]*)(?:\[([a-z-]+)(?:=([a-z]+))?\])?$/.exec(one.trim());
    if (m === null) return false;
    const [, tag, attr, val] = m;
    if (tag && el.tagName.toLowerCase() !== tag) return false;
    if (attr === undefined) return true;
    const got = el.getAttribute(attr);
    return val === undefined ? got !== null : got === val;
  });
}

type Handler = (e: Record<string, unknown>) => void;

function page(opts: { top?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const sent: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const doc = {
    body: new El("BODY"),
    getElementById: () => null,
    // The listeners belong on window, not here: see "registers on window" below.
    addEventListener: () => {
      throw new Error("registered on document");
    },
  };
  const win: Record<string, unknown> = {
    addEventListener: (t: string, h: Handler) => handlers.set(t, h),
    removeEventListener: (t: string) => handlers.delete(t),
    getComputedStyle: (el: El) => ({
      getPropertyValue: (n: string) =>
        n === "-webkit-text-security" ? (el.textSecurity ?? "none") : "",
    }),
    [TEACH_BINDING]: (s: string) => {
      raw.push(s);
      sent.push(JSON.parse(s));
    },
  };
  win.window = win;
  win.top = opts.top === false ? {} : win;
  runInNewContext(teachCaptureScript(), {
    window: win,
    document: doc,
    Date,
    JSON,
    WeakMap,
    RegExp,
    String,
  });
  const fire = (type: string, e: Record<string, unknown>) =>
    handlers.get(type)?.({ isTrusted: true, ...e });
  return { win, doc, handlers, sent, raw, fire };
}

const input = (attrs: Attrs, value = "") => {
  const el = new El("INPUT", attrs);
  el.value = value;
  el.reads.length = 0;
  return el;
};

describe("teach page script", () => {
  it("does nothing outside the top frame", () => {
    const p = page({ top: false });
    expect(p.handlers.size).toBe(0);
  });

  it("listens in the capture phase and stops on request", () => {
    const p = page();
    expect([...p.handlers.keys()].sort()).toEqual(["change", "click", "focusin", "keydown"]);
    (p.win.__psycheTeachStop as () => void)();
    expect(p.handlers.size).toBe(0);
  });

  it("registers on window in the capture phase, so it runs before the page's own listeners", () => {
    // `document.addEventListener` throws in this fake; getting here means it was never used.
    const p = page();
    expect(p.handlers.size).toBe(4);
  });

  it("a field that was a password field stays one when the page flips it to text", () => {
    const p = page();
    const f = input({ type: "password", name: "x" }, "hunter2");
    p.fire("focusin", { target: f });
    f.attrs.type = "text";
    f.reads.length = 0;
    p.fire("change", { target: f });
    expect(f.reads).toEqual([]);
    expect(p.sent[0]).toMatchObject({ k: "type", sensitive: true });
    expect(p.raw.join("")).not.toContain("hunter2");
  });

  it("a field drawn as dots (-webkit-text-security) is a password", () => {
    const p = page();
    const f = input({ type: "text", name: "code" }, "123456");
    f.textSecurity = "disc";
    p.fire("change", { target: f });
    expect(f.reads).toEqual([]);
    expect(p.sent[0]).toMatchObject({ sensitive: true, reason: "password" });
  });

  it.each([
    ["contrase\u00f1a"],
    ["Passwort"],
    ["Mot de passe"],
    ["pw"],
    ["pass"],
    ["CVV2"],
    ["CVC2"],
    ["Recovery code"],
    ["Backup codes"],
    ["Seed phrase"],
    ["\u5bc6\u7801"],
  ])("a field labelled %s is sensitive", (label) => {
    const p = page();
    const f = input({ type: "text", "aria-label": label }, "SECRET-123");
    p.fire("change", { target: f });
    expect(f.reads).toEqual([]);
    expect(p.sent[0]).toMatchObject({ sensitive: true });
  });

  it("sends the input mode with the field's facts", () => {
    const p = page();
    p.fire("change", { target: input({ type: "text", name: "q", inputmode: "numeric" }, "5") });
    expect((p.sent[0] as { f: { inputmode: string } }).f.inputmode).toBe("numeric");
  });

  it("reports a click as role, name and selector", () => {
    const p = page();
    const b = new El("BUTTON", { id: "export" }, "  Export \n all ");
    p.fire("click", { target: b });
    expect(p.sent).toEqual([
      expect.objectContaining({
        k: "click",
        role: "button",
        name: "Export all",
        selector: "#export",
      }),
    ]);
  });

  it("finds the interactive element around the click and falls back to a path selector", () => {
    const p = page();
    const a = new El("A", { href: "/x" }, "Reports");
    const span = new El("SPAN", {}, "Reports");
    span.parentElement = a;
    p.fire("click", { target: span });
    const msg = p.sent[0] as { role: string; name: string; selector: string };
    expect(msg).toMatchObject({ role: "link", name: "Reports" });
    expect(msg.selector).toBe("a:nth-of-type(1)");
  });

  it("ignores events a page script made up (isTrusted false)", () => {
    const p = page();
    const handler = p.handlers.get("click");
    handler?.({ isTrusted: false, target: new El("BUTTON", {}, "Pay") });
    p.handlers.get("change")?.({ isTrusted: false, target: input({ name: "q" }, "x") });
    p.handlers.get("keydown")?.({ isTrusted: false, key: "Enter", target: input({ name: "q" }) });
    expect(p.sent).toEqual([]);
  });

  it("does not report the focus click on a text field, only what was typed", () => {
    const p = page();
    const f = input({ name: "from", type: "text", id: "from" }, "2026-11-01");
    p.fire("click", { target: f });
    expect(p.sent).toEqual([]);
    p.fire("change", { target: f });
    expect(p.sent).toEqual([
      expect.objectContaining({
        k: "type",
        role: "textbox",
        value: "2026-11-01",
        sensitive: false,
      }),
    ]);
  });

  it.each([
    ["password", { type: "password", name: "pw" }],
    ["card by autocomplete", { type: "text", autocomplete: "cc-number" }],
    ["card by name", { type: "text", name: "card_number" }],
    ["one-time code", { type: "text", autocomplete: "one-time-code" }],
    ["identity by label", { type: "text", "aria-label": "Social Security number" }],
  ])("never reads the value of a sensitive field: %s", (_n, attrs) => {
    const p = page();
    const f = input(attrs as Attrs, "TOP-SECRET-VALUE");
    p.fire("change", { target: f });
    expect(f.reads).toEqual([]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toMatchObject({ k: "type", sensitive: true });
    expect(p.sent[0]).not.toHaveProperty("value");
    expect(p.raw.join("")).not.toContain("TOP-SECRET-VALUE");
  });

  it("does not read the value of a sensitive field when Enter commits it", () => {
    const p = page();
    const f = input({ type: "password", name: "pw" }, "hunter2");
    p.fire("keydown", { key: "Enter", target: f });
    expect(f.reads).toEqual([]);
    expect(p.raw.join("")).not.toContain("hunter2");
    expect(p.sent.map((s) => s.k)).toEqual(["type", "press"]);
  });

  it("commits a typed value before Enter, in the order the owner did it", () => {
    const p = page();
    const f = input({ type: "search", name: "q" }, "invoices");
    p.fire("keydown", { key: "Enter", target: f });
    expect(p.sent.map((s) => s.k)).toEqual(["type", "press"]);
    // Already reported through `change`: Enter adds only the press.
    const g = input({ type: "search", name: "r" }, "x");
    p.fire("change", { target: g });
    p.fire("keydown", { key: "Enter", target: g });
    expect(p.sent.map((s) => s.k)).toEqual(["type", "press", "type", "press"]);
  });

  it("reports a select by the label of the chosen option, and never a sensitive one", () => {
    const p = page();
    const s = new El("SELECT", { name: "range" });
    s.options = [
      { selected: false, label: "Today", text: "Today" },
      { selected: true, label: "Last week", text: "Last week" },
    ];
    p.fire("change", { target: s });
    expect(p.sent[0]).toMatchObject({ k: "select", role: "combobox", value: "Last week" });
    const m = new El("SELECT", { name: "cc-exp-month", autocomplete: "cc-exp-month" });
    m.options = [{ selected: true, label: "07", text: "07" }];
    p.fire("change", { target: m });
    expect(p.sent[1]).toMatchObject({ k: "select", sensitive: true });
    expect(p.sent[1]).not.toHaveProperty("value");
  });

  it("skips file inputs and rich-text editors", () => {
    const p = page();
    p.fire("change", { target: input({ type: "file", name: "f" }, "C:\\fakepath\\tax.pdf") });
    const ce = new El("DIV", { role: "textbox" });
    ce.isContentEditable = true;
    p.fire("click", { target: ce });
    expect(p.sent).toEqual([]);
  });

  it("reads no cookies or storage: it has no access to them", () => {
    expect(teachCaptureScript()).not.toMatch(/cookie|localStorage|sessionStorage|indexedDB/i);
  });
});
