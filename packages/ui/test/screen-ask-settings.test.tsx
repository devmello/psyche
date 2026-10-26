import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoicePanel } from "../src/screens/settings/VoiceSection.tsx";

const base = { values: {}, needsApproval: new Set<string>() };
const system = { helper: "online" as const, accessibility: "granted" as const, watching: true };

/** Settings → Voice & dictation → Ask about screen (docs/design/screen-ask-2026.md §6). */
describe("Voice & dictation: Ask about screen", () => {
  it("is desktop only", () => {
    render(<VoicePanel {...base} onChange={vi.fn()} />);
    expect(screen.queryByText("Ask about screen")).toBeNull();
  });

  it("turns it off, picks where asks go and always sends the screenshot", async () => {
    const onChange = vi.fn();
    render(<VoicePanel {...base} onChange={onChange} system={system} />);
    expect(screen.getByText("Ask about screen")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Current chat" }));
    expect(onChange).toHaveBeenCalledWith("screenAsk.destination", "current");
    await userEvent.click(screen.getByRole("switch", { name: /Always include the screenshot/ }));
    expect(onChange).toHaveBeenCalledWith("screenAsk.alwaysImage", true);
    await userEvent.click(screen.getByRole("switch", { name: /Ask about my screen/ }));
    expect(onChange).toHaveBeenCalledWith("screenAsk.enabled", false);
  });

  it("hides the details while off", () => {
    render(
      <VoicePanel
        {...base}
        values={{ "screenAsk.enabled": false }}
        onChange={vi.fn()}
        system={system}
      />,
    );
    expect(screen.queryByRole("switch", { name: /Always include the screenshot/ })).toBeNull();
  });
});
