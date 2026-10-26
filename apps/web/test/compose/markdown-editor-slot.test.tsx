// @vitest-environment happy-dom

import type { Lesson } from "@psyche/protocol";
import { GatewayProvider, MemoryFileEditor, UiSlotsProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdownEditor } from "../../src/compose/viewers.tsx";

afterEach(cleanup);

const LINE = "- Jane: two lines, answer first.";
const NOW = "2026-10-25T12:00:00.000Z";
const lesson: Lesson = {
  id: "ls_jane",
  kind: "style",
  origin: "stated",
  statement: "Replies to Jane are short.",
  scope: { global: true },
  destination: { type: "file", path: "USER.md", section: "Preferences", lineId: "l1" },
  previous: null,
  value: LINE,
  sources: [],
  confidence: 0.9,
  status: "active",
  refinedCount: 0,
  supersedes: null,
  lastAppliedAt: null,
  createdAt: NOW,
  confirmedAt: null,
  forgottenAt: null,
};

describe("The composed app's editor slot", () => {
  it("shows a persona file in the viewers' editor, with margin marks and only the kit's Save", async () => {
    const gateway = new MockGateway(
      { memoryFiles: { "USER.md": `# About the owner\n\n${LINE}\n` }, lessons: [lesson] },
      { now: () => NOW },
    );
    render(
      <GatewayProvider client={gateway}>
        <UiSlotsProvider value={{ renderEditor: renderMarkdownEditor }}>
          <MemoryFileEditor path="USER.md" budget={4000} />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    const content = await screen.findByLabelText("USER.md editor");
    await waitFor(() =>
      expect(document.querySelector('.psy-md-mark[data-mark-id="ls_jane"]')).not.toBeNull(),
    );
    // The editor's own Save, Discard and budget are hidden: the kit's are the only ones.
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Discard" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
    expect(content.textContent).toContain(LINE);
  });
});
