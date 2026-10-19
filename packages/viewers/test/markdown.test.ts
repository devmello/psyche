import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  DocumentSession,
  documentKind,
  formatBudget,
  joinFrontmatter,
  lineDiffStats,
  MemoryDocumentStore,
  parseFrontmatter,
  splitFrontmatter,
} from "../src/core/markdown.ts";
import { markdownExtensions } from "../src/core/markdown-editor.ts";
import { ROUND_TRIP_MD } from "./fixtures/markdown.ts";

describe("frontmatter", () => {
  it("splits and rejoins byte-for-byte when unchanged", () => {
    const fm = splitFrontmatter(ROUND_TRIP_MD);
    expect(fm.yaml).toContain("creature: pink hippo");
    expect(fm.body.startsWith("\n# Core truths")).toBe(true);
    expect(joinFrontmatter(fm, fm.yaml, fm.body)).toBe(ROUND_TRIP_MD);
    expect(parseFrontmatter(fm.yaml ?? "")).toEqual({ ok: true, data: { name: "Flash", creature: "pink hippo", emoji: "🦛" } });
  });

  it("rewrites only the frontmatter when its YAML changes", () => {
    const fm = splitFrontmatter(ROUND_TRIP_MD);
    const next = joinFrontmatter(fm, "name: Flash\nemoji: 🦄", fm.body);
    expect(next.startsWith("---\nname: Flash\nemoji: 🦄\n---\n")).toBe(true);
    expect(next.endsWith(fm.body)).toBe(true);
  });

  it("reports invalid YAML and non-mappings", () => {
    expect(parseFrontmatter("a: [1, 2").ok).toBe(false);
    expect(parseFrontmatter("- a\n- b").ok).toBe(false);
    expect(splitFrontmatter("no frontmatter\n---\n").yaml).toBeNull();
  });
});

describe("document kinds and budgets", () => {
  it("knows persona budgets and nightly rewrites", () => {
    expect(documentKind("SOUL.md").budget).toBe(20_000);
    expect(documentKind("USER.md").budget).toBe(4_000);
    expect(documentKind("notes/SOUL.md").budget).toBeUndefined();
    expect(documentKind("MEMORY.md").rewrittenNightly).toBe(true);
    expect(documentKind("IDENTITY.md").frontmatter).toBe(true);
    expect(documentKind("note.md", "---\na: 1\n---\nx").frontmatter).toBe(true);
    expect(formatBudget(6200, 20_000)).toBe("6.2k / 20k");
  });

  it("counts changed lines", () => {
    expect(lineDiffStats("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, removed: 1 });
    expect(lineDiffStats("x", "x")).toEqual({ added: 0, removed: 0 });
  });
});

describe("editor round trip (text is canonical)", () => {
  it("an edit changes only the edited range; everything else is byte-identical", () => {
    let state = EditorState.create({ doc: ROUND_TRIP_MD, extensions: markdownExtensions() });
    expect(state.doc.toString()).toBe(ROUND_TRIP_MD);
    const at = ROUND_TRIP_MD.indexOf("second item");
    state = state.update({ changes: { from: at, to: at + "second".length, insert: "2nd" } }).state;
    const out = state.doc.toString();
    expect(out).toBe(ROUND_TRIP_MD.replace("second item", "2nd item"));
    const stats = lineDiffStats(ROUND_TRIP_MD, out);
    expect(stats).toEqual({ added: 1, removed: 1 });
  });

  it("keeps CRLF documents CRLF", () => {
    const crlf = "# T\r\n\r\n- a\r\n- b\r\n";
    const state = EditorState.create({ doc: crlf, extensions: markdownExtensions() });
    expect(state.sliceDoc(0, state.doc.length)).toBe("# T\n\n- a\n- b\n");
    expect(state.doc.toString().split(state.lineBreak).join("\r\n")).toBe(crlf);
  });
});

describe("DocumentSession", () => {
  const manual = () => {
    const timers: (() => void)[] = [];
    return {
      opts: { setTimer: (fn: () => void) => timers.push(fn), clearTimer: () => void timers.splice(0) },
      flush: async () => {
        const fns = timers.splice(0);
        for (const fn of fns) fn();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  };

  it("autosaves after edits with compare-and-swap", async () => {
    const store = new MemoryDocumentStore("# Soul\n");
    const t = manual();
    const s = new DocumentSession(store, t.opts);
    await s.load();
    s.edit("# Soul\n- I say what I do not know.\n");
    expect(s.state.status).toBe("dirty");
    await t.flush();
    expect(s.state.status).toBe("clean");
    expect(store.content).toBe("# Soul\n- I say what I do not know.\n");
    expect(s.state.etag).toBe("v2");
  });

  it("detects an agent edit to the same file as a conflict and never overwrites it", async () => {
    const store = new MemoryDocumentStore("a\n");
    const s = new DocumentSession(store, { autosaveMs: false });
    await s.load();
    s.edit("a\nmine\n");
    store.externalWrite("a\nagent\n");
    await s.save();
    expect(s.state.status).toBe("conflict");
    expect(s.state.conflict?.content).toBe("a\nagent\n");
    expect(store.content).toBe("a\nagent\n");
    await s.resolve({ merged: "a\nagent\nmine\n" });
    expect(s.state.status).toBe("clean");
    expect(store.content).toBe("a\nagent\nmine\n");
  });

  it("follows remote changes while clean and conflicts while dirty", async () => {
    const store = new MemoryDocumentStore("x");
    const s = new DocumentSession(store, { autosaveMs: false });
    await s.load();
    s.remoteChanged(store.externalWrite("y"));
    expect(s.state).toMatchObject({ status: "clean", content: "y", etag: "v2" });
    s.edit("mine");
    s.remoteChanged(store.externalWrite("theirs"));
    expect(s.state.status).toBe("conflict");
    await s.resolve("theirs");
    expect(s.state).toMatchObject({ status: "clean", content: "theirs" });
  });

  it("discards back to the last save and keeps edits made during a save", async () => {
    const store = new MemoryDocumentStore("base");
    const s = new DocumentSession(store, { autosaveMs: false });
    await s.load();
    s.edit("one");
    const saving = s.save();
    s.edit("two");
    await saving;
    expect(s.state).toMatchObject({ status: "dirty", saved: "one", content: "two" });
    s.discard();
    expect(s.state).toMatchObject({ status: "clean", content: "one" });
  });
});

describe("rich mode", () => {
  it("only decorates: hides marks off the cursor line and never changes the text", async () => {
    const { EditorView } = await import("@codemirror/view");
    const doc = "# Title\n\nSome **bold** text\n";
    let state = EditorState.create({ doc, extensions: markdownExtensions({ rich: true }), selection: { anchor: doc.length } });
    const hidden = () => {
      const out: string[] = [];
      for (const src of state.facet(EditorView.decorations)) {
        const set = typeof src === "function" ? undefined : src;
        set?.between(0, state.doc.length, (from, to, d) => {
          if (d.spec.class === undefined && to > from) out.push(state.sliceDoc(from, to));
        });
      }
      return out;
    };
    expect(hidden()).toEqual(["# ", "**", "**"]);
    state = state.update({ selection: { anchor: 3 } }).state;
    expect(hidden()).toEqual(["**", "**"]);
    expect(state.doc.toString()).toBe(doc);
  });
});
