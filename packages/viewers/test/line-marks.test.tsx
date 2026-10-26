// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDocumentStore } from "../src/core/markdown.ts";
import { MarkdownEditor } from "../src/react/MarkdownEditor.tsx";

afterEach(cleanup);

const DOC = "# About the owner\n\n- Name: you.\n- Jane: two lines, answer first.\n";
const MARK = {
  id: "ls_jane",
  text: "- Jane: two lines, answer first.",
  label: "Learned from you on 25 October. Show details",
};

async function view(): Promise<EditorView> {
  const content = await screen.findByLabelText("USER.md editor");
  const v = EditorView.findFromDOM(content);
  if (v === null) throw new Error("no editor view");
  return v;
}

describe("Line marks in the Markdown editor (teaching loop §5.2)", () => {
  it("marks the line with that text and calls back with the mark's id", async () => {
    const onMarkActivate = vi.fn();
    render(
      <MarkdownEditor
        path="USER.md"
        store={new MemoryDocumentStore(DOC)}
        marks={[MARK]}
        onMarkActivate={onMarkActivate}
      />,
    );
    await view();
    const dot = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.psy-md-mark[data-mark-id="ls_jane"]');
      if (el === null) throw new Error("no mark");
      return el;
    });
    expect(dot.title).toBe(MARK.label);
    // A pointer-only cue: the gutter is aria-hidden, so nothing in it takes focus.
    expect(dot.closest("[aria-hidden='true']")).not.toBeNull();
    expect(dot.tabIndex).toBe(-1);
    fireEvent.click(dot);
    expect(onMarkActivate).toHaveBeenCalledWith("ls_jane");
  });

  it("drops the mark when the line is changed, and has no gutter without marks", async () => {
    const { rerender } = render(
      <MarkdownEditor path="USER.md" store={new MemoryDocumentStore(DOC)} marks={[MARK]} />,
    );
    const v = await view();
    await waitFor(() => expect(document.querySelector(".psy-md-mark")).not.toBeNull());
    const at = v.state.doc.toString().indexOf("two lines");
    act(() => v.dispatch({ changes: { from: at, to: at + 3, insert: "three" } }));
    expect(document.querySelector(".psy-md-mark")).toBeNull();
    rerender(<MarkdownEditor path="USER.md" store={new MemoryDocumentStore(DOC)} />);
    expect(document.querySelector(".psy-md-marks")).toBeNull();
  });
});
