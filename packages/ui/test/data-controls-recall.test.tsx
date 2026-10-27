import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataControlsPanel } from "../src/screens/settings/DataControlsSection.tsx";

/** Settings → Data controls → Memory: "How memory is recalled" (Markdown only · plus embeddings). */

const checked = (el: HTMLElement) =>
  (el as HTMLInputElement).checked === true || el.getAttribute("aria-checked") === "true";

function renderPanel(
  values: Record<string, unknown> = {},
  recall?: React.ComponentProps<typeof DataControlsPanel>["recall"],
) {
  const onChange = vi.fn();
  render(
    <DataControlsPanel
      values={values}
      onChange={onChange}
      persona="Wren"
      memoryPaused={false}
      archivedThreads={0}
      {...(recall === undefined ? {} : { recall })}
    />,
  );
  return { onChange };
}

describe("Data controls: memory recall mode", () => {
  it("defaults to Markdown only and shows no status line", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "How memory is recalled" });
    expect(checked(within(group).getByRole("radio", { name: /^Markdown only/ }))).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("writes memory.recall.mode when the owner picks embeddings", async () => {
    const { onChange } = renderPanel();
    const group = screen.getByRole("radiogroup", { name: "How memory is recalled" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Markdown plus embeddings/ }));
    expect(onChange).toHaveBeenCalledWith("memory.recall.mode", "embeddings");
  });

  it("says when the model is missing and recall falls back to words", () => {
    renderPanel(
      { "memory.recall.mode": "embeddings" },
      { mode: "embeddings", state: "text_only", fallback: "model_missing" },
    );
    expect(screen.getByRole("status").textContent).toMatch(/not downloaded yet.*words only/);
  });

  it("shows how much is indexed once semantic recall is running", () => {
    renderPanel(
      { "memory.recall.mode": "embeddings" },
      { mode: "embeddings", state: "semantic", vectors: 12, chunks: 20 },
    );
    expect(screen.getByRole("status").textContent).toContain("12 of 20");
  });
});
