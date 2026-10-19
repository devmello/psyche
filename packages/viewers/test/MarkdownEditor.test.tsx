// @vitest-environment jsdom
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDocumentStore } from "../src/core/markdown.ts";
import { MarkdownEditor } from "../src/react/MarkdownEditor.tsx";
import { ROUND_TRIP_MD } from "./fixtures/markdown.ts";

afterEach(cleanup);

async function editorView(label: string): Promise<EditorView> {
  const content = await screen.findByLabelText(label);
  const view = EditorView.findFromDOM(content);
  if (view === null) throw new Error("no editor view");
  return view;
}

function replace(view: EditorView, find: string, insert: string) {
  const at = view.state.doc.toString().indexOf(find);
  act(() => view.dispatch({ changes: { from: at, to: at + find.length, insert } }));
}

describe("MarkdownEditor", () => {
  it("round-trips Markdown: an edit in Rich mode saves exactly that edit", async () => {
    const store = new MemoryDocumentStore(ROUND_TRIP_MD);
    const onSaved = vi.fn();
    render(
      <MarkdownEditor path="notes/plan.md" store={store} autosaveMs={false} onSaved={onSaved} />,
    );
    const view = await editorView("notes/plan.md editor");
    expect(view.state.doc.toString()).toBe(ROUND_TRIP_MD);
    replace(view, "second item", "2nd item");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByText("Save"));
    await screen.findByText("Saved");
    expect(store.content).toBe(ROUND_TRIP_MD.replace("second item", "2nd item"));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ content: store.content, etag: "v2" }),
    );
  });

  it("switching modes never rewrites the document", async () => {
    const store = new MemoryDocumentStore(ROUND_TRIP_MD);
    render(<MarkdownEditor path="n.md" store={store} autosaveMs={false} />);
    await editorView("n.md editor");
    fireEvent.click(screen.getByText("Source"));
    fireEvent.click(screen.getByText("Diff"));
    expect(screen.getByText("+0 −0")).toBeTruthy();
    fireEvent.click(screen.getByText("Rich"));
    const view = await editorView("n.md editor");
    expect(view.state.doc.toString()).toBe(ROUND_TRIP_MD);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("supports undo and Discard", async () => {
    const store = new MemoryDocumentStore("# Soul\n");
    render(<MarkdownEditor path="SOUL.md" store={store} />);
    const view = await editorView("SOUL.md editor");
    replace(view, "Soul", "Core truths");
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("# Soul\n");
    replace(view, "Soul", "X");
    fireEvent.click(screen.getByText("Discard"));
    await waitFor(() => expect(view.state.doc.toString()).toBe("# Soul\n"));
  });

  it("persona files use explicit Save and show a budget meter", async () => {
    const store = new MemoryDocumentStore("a".repeat(6200));
    render(<MarkdownEditor path="SOUL.md" store={store} />);
    const view = await editorView("SOUL.md editor");
    expect(screen.getByText("6.2k / 20k")).toBeTruthy();
    replace(view, "aaaa", "bbbb");
    await new Promise((r) => setTimeout(r, 1700));
    expect(store.content.startsWith("aaaa")).toBe(true);
    expect((screen.getByLabelText("Prompt budget") as HTMLMeterElement).getAttribute("max")).toBe(
      "20000",
    );
    cleanup();
    render(<MarkdownEditor path="USER.md" store={new MemoryDocumentStore("b".repeat(4100))} />);
    expect(await screen.findByText(/Over budget/)).toBeTruthy();
    cleanup();
    render(<MarkdownEditor path="MEMORY.md" store={new MemoryDocumentStore("x")} />);
    expect(await screen.findByText(/Dreaming rewrites MEMORY.md/)).toBeTruthy();
  });

  it("autosaves non-persona notes", async () => {
    const store = new MemoryDocumentStore("note");
    render(<MarkdownEditor path="notes/a.md" store={store} autosaveMs={10} />);
    const view = await editorView("notes/a.md editor");
    replace(view, "note", "note!");
    await waitFor(() => expect(store.content).toBe("note!"));
  });

  it("turns an agent edit during editing into a conflict and resolves it", async () => {
    const store = new MemoryDocumentStore("a\n");
    const { rerender } = render(<MarkdownEditor path="n.md" store={store} autosaveMs={false} />);
    const view = await editorView("n.md editor");
    replace(view, "a", "mine");
    const remote = store.externalWrite("agent\n");
    rerender(<MarkdownEditor path="n.md" store={store} autosaveMs={false} remote={remote} />);
    expect(await screen.findByText(/changed while you were editing/)).toBeTruthy();
    expect(store.content).toBe("agent\n");
    fireEvent.click(screen.getByText("Keep mine"));
    await waitFor(() => expect(store.content).toBe("mine\n"));
  });

  it("opens in Diff against the agent's proposed edit", async () => {
    const store = new MemoryDocumentStore("one\ntwo\n");
    render(<MarkdownEditor path="n.md" store={store} proposed={{ content: "one\n2\nthree\n" }} />);
    expect(await screen.findByLabelText("n.md diff")).toBeTruthy();
    expect(screen.getByText("+2 −1")).toBeTruthy();
    expect(screen.getByText(/agent's proposed edit/)).toBeTruthy();
  });

  it("edits IDENTITY.md frontmatter without touching the body", async () => {
    const doc = "---\nname: Flash\nemoji: 🦛\n---\n# Identity\n";
    const store = new MemoryDocumentStore(doc);
    render(<MarkdownEditor path="IDENTITY.md" store={store} />);
    const yaml = (await screen.findByLabelText("Frontmatter YAML")) as HTMLTextAreaElement;
    expect(yaml.value).toBe("name: Flash\nemoji: 🦛");
    fireEvent.change(yaml, { target: { value: "name: Flash\nemoji: 🦄" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(store.content).toBe("---\nname: Flash\nemoji: 🦄\n---\n# Identity\n"),
    );
    fireEvent.change(yaml, { target: { value: "name: [oops" } });
    expect(screen.getByText(/not valid YAML/)).toBeTruthy();
  });
});
