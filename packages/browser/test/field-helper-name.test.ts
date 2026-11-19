import { afterEach, describe, expect, it } from "vitest";
import { FIELD_HELPER } from "../src/cdp/page.ts";

/**
 * #1321: `FIELD_HELPER` reads a control's name as the page shows it now. Hidden parts (the
 * `hidden` attribute, `aria-hidden`, `display:none`, `visibility:hidden`) are not part of it, so a
 * page cannot show "Done" while the name says "Transfer", or the reverse.
 */

interface FakeNode {
  nodeType: number;
  textContent?: string;
  tagName?: string;
  hidden?: boolean;
  attrs?: Record<string, string>;
  style?: { display?: string; visibility?: string };
  childNodes?: FakeNode[];
  getAttribute?: (k: string) => string | null;
}

const text = (t: string): FakeNode => ({ nodeType: 3, textContent: t });
const el = (
  children: FakeNode[],
  more: Partial<FakeNode> = {},
  tag = "BUTTON",
): FakeNode & { getAttribute: (k: string) => string | null } => {
  const attrs = more.attrs ?? {};
  return {
    nodeType: 1,
    tagName: tag,
    childNodes: children,
    ...more,
    getAttribute: (k: string) => attrs[k] ?? null,
  };
};

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => {
  delete g.getComputedStyle;
  delete g.document;
});

function nameOf(root: FakeNode): string | undefined {
  g.getComputedStyle = (n: FakeNode) => ({
    display: n.style?.display ?? "inline",
    visibility: n.style?.visibility ?? "visible",
  });
  g.document = { activeElement: null, getElementById: () => null };
  const fn = new Function(`return (${FIELD_HELPER.replace(/^\/\*[^*]*\*\/\s*/, "")})`)() as (
    this: FakeNode,
  ) => { name?: string };
  return fn.call(root).name;
}

describe("FIELD_HELPER live name", () => {
  it("reads the visible text of a button", () => {
    expect(nameOf(el([text("Transfer "), el([text("money")], {}, "SPAN")]))).toBe("Transfer money");
  });

  it.each([
    ["hidden attribute", { hidden: true }],
    ["aria-hidden", { attrs: { "aria-hidden": "true" } }],
    ["display:none", { style: { display: "none" } }],
    ["visibility:hidden", { style: { visibility: "hidden" } }],
  ])("skips a %s part", (_n, hide) => {
    const b = el([text("Done"), el([text(" Transfer")], hide as Partial<FakeNode>, "SPAN")]);
    expect(nameOf(b)).toBe("Done");
  });

  it("an aria-label wins over the text, as the AX name does", () => {
    expect(nameOf(el([text("→")], { attrs: { "aria-label": "Buy" } }))).toBe("Buy");
  });

  it("never reads a text field's value", () => {
    const input = el([], { attrs: { type: "text" } }, "INPUT") as FakeNode & { value?: string };
    input.value = "Transfer $500";
    expect(nameOf(input)).toBeUndefined();
  });
});
