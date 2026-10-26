// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ControlledMarkdownEditor } from "../src/react/ControlledMarkdownEditor.tsx";

afterEach(cleanup);

const FILE = "# About the owner\n\n- Name: you.\n";
let setHost: (value: string) => void = () => {};
const changes: string[] = [];

function Host() {
  const [value, setValue] = useState(FILE);
  setHost = setValue;
  return (
    <ControlledMarkdownEditor
      path="USER.md"
      value={value}
      onChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
    />
  );
}

async function view(): Promise<EditorView> {
  const content = await screen.findByLabelText("USER.md editor");
  const v = EditorView.findFromDOM(content);
  if (v === null) throw new Error("no editor view");
  return v;
}

describe("ControlledMarkdownEditor (the kit's editor slot)", () => {
  it("hands every edit to the host, follows the host's value, and leaves Save to the host", async () => {
    render(<Host />);
    const v = await view();
    expect(v.state.doc.toString()).toBe(FILE);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();

    act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: "- Likes tea.\n" } }));
    await waitFor(() => expect(changes.at(-1)).toBe(`${FILE}- Likes tea.\n`));
    // Its own edit is not echoed back as a change from elsewhere.
    expect(screen.queryByText(/changed while you were editing/)).toBeNull();

    // The host discards its draft: the editor follows.
    act(() => setHost(FILE));
    await waitFor(() => expect(v.state.doc.toString()).toBe(FILE));
  });
});
