import { describe, expect, it } from "vitest";
import { CANVAS_PANE_ID, openArtifactAction } from "../../src/shell/ShellApp.tsx";
import { run } from "./helpers.ts";

describe("canvas pane (chat-experience-2026 §4.2)", () => {
  it("is one pane whose artifact is swapped in place, not a tab per artifact", () => {
    const s = run([openArtifactAction("art_1", "Plan"), openArtifactAction("art_2", "Budget")]);
    const canvases = s.panes.filter((p) => p.pane === "artifact");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({
      paneId: CANVAS_PANE_ID,
      artifactId: "art_2",
      title: "Budget",
    });
    expect(s.focusedPaneId).toBe(CANVAS_PANE_ID);
  });
});
