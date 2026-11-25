import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MODE_LABEL } from "../src/agent/AgentHeader.tsx";
import { fullOptions, modeOptions } from "../src/chat/command-args.ts";
import { parseCommand } from "../src/chat/commands.ts";
import { FullAccessBanner } from "../src/chat/FullAccessBanner.tsx";
import { applyModeChoice, SWITCH_MODES } from "../src/chat/mode-switch.ts";

/** Full access (owner, 2026-11-25): the `/full` command, the picker and the indicator. */

describe("/full", () => {
  it.each([
    ["/full", ""],
    ["/full on", "on"],
    ["/full OFF", "off"],
  ])("%s parses", (input, arg) => {
    expect(parseCommand(input)).toEqual({ type: "command", name: "full", arg });
  });

  it("refuses anything but on or off", () => {
    expect(parseCommand("/full please")).toMatchObject({ type: "error" });
  });

  it("offers on and off, and /mode lists Full access", () => {
    expect(fullOptions().map((o) => o.value)).toEqual(["on", "off"]);
    expect(modeOptions().map((o) => o.value)).toContain("full");
    expect(parseCommand("/mode full")).toEqual({ type: "command", name: "mode", arg: "full" });
  });

  it("is in the mode picker and labelled", () => {
    expect(SWITCH_MODES).toContain("full");
    expect(MODE_LABEL.full).toBe("Full access");
  });

  it("never becomes the default for new chats, even from the main chat", async () => {
    const call = vi.fn(async () => ({}));
    expect(await applyModeChoice(call, { id: "t1", kind: "main" }, "full")).toBe("skipped");
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("threads.update", { threadId: "t1", permissionMode: "full" });
    // Control: another mode from the main chat still saves the default.
    expect(await applyModeChoice(call, { id: "t1", kind: "main" }, "balanced")).toBe("saved");
    expect(call).toHaveBeenLastCalledWith("settings.set", {
      key: "permissions.mode",
      value: "balanced",
    });
  });
});

describe("Full access indicator", () => {
  it("shows while the chat is in Full access and turns it off in one tap", async () => {
    const off = vi.fn(async () => {});
    render(<FullAccessBanner mode="full" onTurnOff={off} />);
    expect(screen.getByRole("status", { name: "Full access" })).toBeTruthy();
    expect(screen.getByText(/except sends and payments/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(off).toHaveBeenCalledTimes(1));
  });

  it.each(["balanced", "auto", "manual", "plan", undefined])("is hidden in %s", (mode) => {
    const { container } = render(<FullAccessBanner mode={mode} onTurnOff={async () => {}} />);
    expect(container.textContent).toBe("");
  });
});
