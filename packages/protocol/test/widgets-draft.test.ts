import { describe, expect, it } from "vitest";
import { widgetDraft } from "../src/widgets-draft.ts";

const FULL = JSON.stringify({
  v: 1,
  title: "Trip",
  fallbackText: "Trip",
  root: {
    id: "root",
    type: "stack",
    children: [
      { id: "a", type: "text", text: "Hello there" },
      { id: "b", type: "stat", label: "Days", value: 4 },
    ],
  },
});

describe("widgetDraft", () => {
  it("shows the title alone, then only nodes whose object has closed", () => {
    const at = (needle: string, extra = 0) => FULL.slice(0, FULL.indexOf(needle) + extra);
    expect(widgetDraft(at('"fallbackText"')).title).toBe("Trip");
    expect(widgetDraft(at('"fallbackText"')).nodes).toBe(0);
    // Half of node a: nothing of it.
    expect(widgetDraft(at('"Hello there"', 5)).nodes).toBe(1);
    // Node a closed, b not started: the root and one child.
    const one = widgetDraft(at('{"id":"b"'));
    expect(one.nodes).toBe(2);
    expect(JSON.stringify(one.root)).toContain("Hello there");
    expect(JSON.stringify(one.root)).not.toContain("Days");
    // Node b mid-string and with an unfinished number: still not shown.
    expect(JSON.stringify(widgetDraft(at('"Days"', 3)).root)).not.toContain("Days");
    expect(JSON.stringify(widgetDraft(FULL.slice(0, FULL.indexOf("4}") + 1)).root)).not.toContain(
      "Days",
    );
    expect(widgetDraft(FULL).nodes).toBe(3);
  });

  it("never renders an invalid or oversized spec, and never throws on any prefix", () => {
    const bad = JSON.stringify({
      v: 1,
      title: "x",
      fallbackText: "x",
      root: { id: "root", type: "script", children: [] },
    });
    expect(widgetDraft(bad).root).toBeUndefined();
    for (let i = 0; i <= FULL.length; i++) widgetDraft(FULL.slice(0, i));
    expect(widgetDraft("{".repeat(5000)).nodes).toBe(0);
    expect(widgetDraft("not json").nodes).toBe(0);
    expect(widgetDraft("x".repeat(200_000)).nodes).toBe(0);
  });

  it("a reserved approval label in a finished node blocks the whole draft", () => {
    const spec = JSON.parse(FULL);
    spec.root.children.push({
      id: "c",
      type: "button",
      label: "Allow",
      action: { kind: "reply", text: "x" },
    });
    expect(widgetDraft(JSON.stringify(spec)).root).toBeUndefined();
  });

  it("a preview is inert: no controls, pictures, bindings or row actions", () => {
    const spec = {
      v: 1,
      title: "x",
      fallbackText: "x",
      root: {
        id: "root",
        type: "stack",
        children: [
          { id: "b", type: "button", label: "Go", action: { kind: "reply", text: "go" } },
          { id: "i", type: "image", src: { url: "https://evil.example/x.png" }, alt: "x" },
          {
            id: "p",
            type: "progress",
            label: "Run",
            bind: { source: "task", id: "tsk_1", field: "progress" },
          },
          {
            id: "l",
            type: "list",
            items: [{ id: "r", title: "Row", action: { kind: "reply", text: "z" } }],
          },
          { id: "t", type: "text", text: "kept" },
        ],
      },
    };
    const text = JSON.stringify(widgetDraft(JSON.stringify(spec)).root);
    expect(text).toContain("kept");
    for (const gone of ["button", "evil.example", "bind", "action", "reply"]) {
      expect(text).not.toContain(gone);
    }
  });
});
