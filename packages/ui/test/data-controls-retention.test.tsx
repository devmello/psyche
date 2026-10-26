import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataControlsPanel } from "../src/screens/settings/DataControlsSection.tsx";

/** Run trace §4.3: thinking and replay retention (Off · 1 · 7 · 30, replays also 90; default 7). */

const checked = (el: HTMLElement) =>
  (el as HTMLInputElement).checked === true || el.getAttribute("aria-checked") === "true";

function renderPanel(values: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  render(
    <DataControlsPanel
      values={values}
      onChange={onChange}
      persona="Wren"
      memoryPaused={false}
      archivedThreads={0}
    />,
  );
  return { onChange };
}

describe("Data controls: retention rows", () => {
  it("defaults both to 7 days and offers Off and 1 day", () => {
    renderPanel();
    const thinking = screen.getByRole("radiogroup", { name: "Keep thinking for" });
    expect(checked(within(thinking).getByRole("radio", { name: "7 days" }))).toBe(true);
    expect(within(thinking).getByRole("radio", { name: "Off" })).toBeTruthy();
    expect(within(thinking).getByRole("radio", { name: "1 day" })).toBeTruthy();
    expect(within(thinking).queryByRole("radio", { name: "90 days" })).toBeNull();
    const replays = screen.getByRole("radiogroup", { name: "Keep task replays for" });
    expect(checked(within(replays).getByRole("radio", { name: "7 days" }))).toBe(true);
    expect(within(replays).getByRole("radio", { name: "Off" })).toBeTruthy();
    expect(within(replays).getByRole("radio", { name: "90 days" })).toBeTruthy();
  });

  it("writes the number of days, 0 for Off", async () => {
    const { onChange } = renderPanel({ "data.reasoningRetentionDays": 30 });
    const thinking = screen.getByRole("radiogroup", { name: "Keep thinking for" });
    expect(checked(within(thinking).getByRole("radio", { name: "30 days" }))).toBe(true);
    await userEvent.click(within(thinking).getByRole("radio", { name: "Off" }));
    expect(onChange).toHaveBeenCalledWith("data.reasoningRetentionDays", 0);
    const replays = screen.getByRole("radiogroup", { name: "Keep task replays for" });
    await userEvent.click(within(replays).getByRole("radio", { name: "1 day" }));
    expect(onChange).toHaveBeenCalledWith("data.replayRetentionDays", 1);
  });
});
