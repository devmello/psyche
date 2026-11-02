import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  applyWidgetOps,
  Block,
  collectWidgetBinds,
  Events,
  foldLabel,
  isReservedLabel,
  Methods,
  validateWidgetPatch,
  validateWidgetSpec,
  Widget,
  WidgetSpec,
} from "../src/index.ts";

const good = () => ({
  v: 1,
  title: "Inbox cleanup",
  fallbackText: "Inbox cleanup: 3 of 5 steps done (60%).",
  root: {
    id: "root",
    type: "stack",
    children: [
      { id: "p", type: "progress", label: "Cleanup", value: 3, max: 5 },
      {
        id: "steps",
        type: "checklist",
        items: [
          { id: "s1", label: "Archive newsletters", state: "done" },
          { id: "s2", label: "Draft replies", state: "active" },
        ],
      },
      {
        id: "go",
        type: "button",
        label: "Draft the replies now",
        action: { kind: "reply", text: "Draft the replies now" },
      },
    ],
  },
});

const issues = (spec: unknown) => {
  const r = validateWidgetSpec(spec);
  return r.ok ? [] : r.issues;
};

describe("widget protocol", () => {
  it("accepts the §4.1 example and the wire shape", () => {
    expect(validateWidgetSpec(good())).toEqual({ ok: true });
    expect(Value.Check(WidgetSpec, good())).toBe(true);
    expect(Value.Check(Block, { type: "ui", widgetId: "w1" })).toBe(true);
  });

  it("registers widgets.get and widget.updated", () => {
    expect(Methods["widgets.get"].scope).toBe("operator.read");
    expect(Object.keys(Events)).toContain("widget.updated");
  });

  it("round-trips the entity shape", () => {
    const w = {
      id: "w1",
      threadId: "t",
      messageId: "m",
      rev: 1,
      spec: good(),
      taint: [{ sourceKind: "web" }],
      owner: { kind: "run", runId: "r" },
      state: "live",
      pinned: false,
      createdAt: "2026-11-02T10:00:00Z",
      updatedAt: "2026-11-02T10:00:00Z",
    };
    expect(Value.Check(Widget, w)).toBe(true);
  });

  it("rejects unknown props, unknown types and duplicate ids with paths", () => {
    const a = good();
    (a.root.children[0] as Record<string, unknown>).onclick = "x()";
    expect(issues(a).some((i) => i.path.startsWith("root.children[0]"))).toBe(true);
    const b = good();
    (b.root.children[1] as Record<string, unknown>).type = "iframe";
    expect(issues(b)[0]?.message).toMatch(/Unknown node type/);
    const c = good();
    (c.root.children[2] as Record<string, unknown>).id = "p";
    expect(issues(c).some((i) => /Duplicate node id/.test(i.message))).toBe(true);
  });

  it("requires labels and alt text (a11y)", () => {
    const a = good();
    delete (a.root.children[0] as Record<string, unknown>).label;
    expect(issues(a).length).toBeGreaterThan(0);
    const img = { ...good(), root: { id: "i", type: "image", src: { fileId: "f1" } } };
    expect(issues(img).length).toBeGreaterThan(0);
  });

  it("enforces limits: nodes, depth, string, spec bytes, rows, series, buttons", () => {
    const many = {
      ...good(),
      root: {
        id: "root",
        type: "stack",
        children: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, type: "text", text: "x" })),
      },
    };
    expect(issues(many)).toEqual([]); // 61 nodes OK
    const tooMany = {
      ...good(),
      root: {
        id: "r",
        type: "stack",
        children: Array.from({ length: 4 }, (_, k) => ({
          id: `s${k}`,
          type: "stack",
          children: Array.from({ length: 55 }, (_, i) => ({
            id: `t${k}_${i}`,
            type: "text",
            text: "x",
          })),
        })),
      },
    };
    expect(issues(tooMany).some((i) => /nodes/.test(i.message))).toBe(true);
    let deep: Record<string, unknown> = { id: "leaf", type: "text", text: "x" };
    for (let i = 0; i < 9; i++) deep = { id: `d${i}`, type: "stack", children: [deep] };
    expect(issues({ ...good(), root: deep }).some((i) => /deeper/.test(i.message))).toBe(true);
    const long = { ...good(), root: { id: "t", type: "text", text: "x".repeat(501) } };
    expect(issues(long).length).toBeGreaterThan(0);
    const big = { ...good(), root: { id: "m", type: "markdown", md: "x".repeat(8000) } };
    expect(issues(big)).toEqual([]);
    const huge = {
      ...good(),
      root: {
        id: "t",
        type: "table",
        label: "T",
        columns: [{ key: "a", label: "A" }],
        rows: Array.from({ length: 500 }, () => ({ a: "x".repeat(100) })),
      },
    };
    expect(issues(huge).some((i) => /bytes/.test(i.message))).toBe(true);
    const rows = {
      ...good(),
      root: {
        id: "t",
        type: "table",
        label: "T",
        columns: [{ key: "a", label: "A" }],
        rows: Array.from({ length: 501 }, () => ({ a: 1 })),
      },
    };
    expect(issues(rows).length).toBeGreaterThan(0);
    const series = {
      ...good(),
      root: {
        id: "c",
        type: "chart",
        label: "C",
        kind: "bar",
        series: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, points: [{ x: 1, y: 1 }] })),
      },
    };
    expect(issues(series).length).toBeGreaterThan(0);
    const btn = {
      ...good(),
      root: {
        id: "r",
        type: "stack",
        children: Array.from({ length: 7 }, (_, i) => ({
          id: `b${i}`,
          type: "button",
          label: `Go ${i}`,
          action: { kind: "reply", text: "x" },
        })),
      },
    };
    expect(issues(btn).some((i) => /buttons/.test(i.message))).toBe(true);
  });

  it("rejects approval-looking labels, including lookalikes", () => {
    for (const label of [
      "Allow",
      "Always allow once",
      "Approve",
      "Deny",
      "Grant access",
      "Authorize",
      "Confirm payment",
      "ALLOW",
      "Аllow",
      "Αpprove",
      "4llow",
      "A l l o w",
      "Al​low",
      "Ａｌｌｏｗ",
    ]) {
      expect(isReservedLabel(label), label).toBe(true);
      const s = {
        ...good(),
        root: { id: "b", type: "button", label, action: { kind: "reply", text: "ok" } },
      };
      expect(
        issues(s).some((i) => /approval/.test(i.message)),
        label,
      ).toBe(true);
    }
    for (const label of ["Continue", "Draft the replies now", "Send reply", "Open in Maps"]) {
      expect(isReservedLabel(label), label).toBe(false);
    }
    expect(foldLabel("Аllоw")).toBe("allow");
  });

  it("rejects reserved words in form submit and choices options", () => {
    const f = {
      ...good(),
      root: {
        id: "f",
        type: "form",
        label: "F",
        fields: [{ id: "a", label: "A", type: "text" }],
        submit: { label: "Approve", as: "reply" },
      },
    };
    expect(issues(f).some((i) => i.path === "root.submit.label")).toBe(true);
    const c = {
      ...good(),
      root: {
        id: "c",
        type: "choices",
        label: "C",
        mode: "single",
        options: [{ id: "a", label: "Deny" }],
      },
    };
    expect(issues(c).length).toBeGreaterThan(0);
  });

  it("rejects unsafe links and raw html-ish fields", () => {
    const l = {
      ...good(),
      root: { id: "l", type: "link", label: "x", url: "javascript:alert(1)" },
    };
    expect(issues(l).some((i) => /links are allowed/.test(i.message))).toBe(true);
    const h = { ...good(), root: { id: "t", type: "text", text: "hi", html: "<script>" } };
    expect(issues(h).length).toBeGreaterThan(0);
    const style = { ...good(), root: { id: "t", type: "text", text: "hi", style: "color:red" } };
    expect(issues(style).length).toBeGreaterThan(0);
  });

  it("progress needs a value, indeterminate or a bind", () => {
    const p = { ...good(), root: { id: "p", type: "progress", label: "x" } };
    expect(issues(p).length).toBeGreaterThan(0);
    const q = { ...good(), root: { id: "p", type: "progress", label: "x", indeterminate: true } };
    expect(issues(q)).toEqual([]);
  });

  it("validates patches by node id", () => {
    expect(
      validateWidgetPatch({
        widgetId: "w",
        baseRev: 2,
        ops: [{ op: "set", id: "p", props: { value: 4 } }],
      }),
    ).toEqual({ ok: true });
    expect(
      validateWidgetPatch({ widgetId: "w", ops: [{ op: "set", path: "/root/0", props: {} }] }).ok,
    ).toBe(false);
    expect(validateWidgetPatch({ widgetId: "w", ops: [] }).ok).toBe(false);
  });
});

describe("applyWidgetOps", () => {
  const spec = () => good() as unknown as import("../src/index.ts").WidgetSpec;
  it("sets props by node id, appends to items, removes and replaces", () => {
    const r = applyWidgetOps(spec(), [
      { op: "set", id: "p", props: { value: 4 } },
      {
        op: "append",
        id: "steps",
        field: "items",
        items: [{ id: "s3", label: "Unsubscribe", state: "todo" }],
      },
      { op: "set", id: "s2", props: { state: "done" } },
      { op: "meta", title: "Cleanup 2" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kids = (r.spec.root as { children: Array<Record<string, unknown>> }).children;
    expect(kids[0]?.value).toBe(4);
    expect((kids[1]?.items as unknown[] | undefined)?.length).toBe(3);
    expect(r.spec.title).toBe("Cleanup 2");
    const r2 = applyWidgetOps(r.spec, [
      { op: "remove", id: "go" },
      { op: "replace", id: "p", node: { id: "p", type: "status", label: "Done", tone: "success" } },
    ]);
    expect(r2.ok).toBe(true);
  });
  it("rejects unknown ids, type changes, root removal and results that break validation", () => {
    expect(applyWidgetOps(spec(), [{ op: "set", id: "zzz", props: {} }]).ok).toBe(false);
    expect(applyWidgetOps(spec(), [{ op: "set", id: "p", props: { type: "text" } }]).ok).toBe(
      false,
    );
    expect(applyWidgetOps(spec(), [{ op: "remove", id: "root" }]).ok).toBe(false);
    expect(applyWidgetOps(spec(), [{ op: "set", id: "go", props: { label: "Allow" } }]).ok).toBe(
      false,
    );
    expect(applyWidgetOps(spec(), [{ op: "set", id: "p", props: { onclick: "x" } }]).ok).toBe(
      false,
    );
  });
});

describe("widget bindings", () => {
  const withBind = (node: Record<string, unknown>) => ({ ...good(), root: node });
  it("accepts allowed source/field/node combinations", () => {
    expect(
      issues(
        withBind({
          id: "p",
          type: "progress",
          label: "Run",
          bind: { source: "task", id: "t1", field: "progress" },
        }),
      ),
    ).toEqual([]);
    expect(
      issues(
        withBind({
          id: "c",
          type: "checklist",
          items: [],
          bind: { source: "task", id: "t1", field: "steps" },
        }),
      ),
    ).toEqual([]);
    expect(
      issues(
        withBind({
          id: "s",
          type: "status",
          label: "…",
          tone: "neutral",
          bind: { source: "automation", id: "a1", field: "status" },
        }),
      ),
    ).toEqual([]);
  });
  it("rejects unknown fields and wrong node types with a message the model can act on", () => {
    const a = issues(
      withBind({
        id: "p",
        type: "progress",
        label: "x",
        value: 1,
        bind: { source: "task", id: "t1", field: "secret" },
      }),
    );
    expect(a[0]?.message).toMatch(/not a bindable field of task\. Allowed: status, progress/);
    const b = issues(
      withBind({
        id: "t",
        type: "table",
        label: "x",
        columns: [{ key: "a", label: "A" }],
        rows: [],
        bind: { source: "task", id: "t1", field: "progress" },
      }),
    );
    expect(b[0]?.message).toMatch(/can only bind to a progress node/);
    expect(
      issues(
        withBind({
          id: "p",
          type: "progress",
          label: "x",
          value: 1,
          bind: { source: "email", id: "t1", field: "progress" },
        }),
      ).length,
    ).toBeGreaterThan(0);
  });
  it("collects binds from nested nodes and tabs", () => {
    const spec = withBind({
      id: "r",
      type: "tabs",
      tabs: [
        {
          id: "t",
          label: "T",
          children: [
            {
              id: "p",
              type: "progress",
              label: "x",
              bind: { source: "task", id: "t1", field: "progress" },
            },
          ],
        },
      ],
    });
    expect(collectWidgetBinds(spec.root)).toEqual([
      { nodeId: "p", bind: { source: "task", id: "t1", field: "progress" } },
    ]);
  });
});
