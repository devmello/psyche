import type { Message } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  orbState,
  ScreenAskView,
  type ScreenAskViewProps,
} from "../src/screen-ask/ScreenAskView.tsx";

afterEach(cleanup);

const noop = () => {};
const agent = (id: string, md: string) =>
  ({ id, role: "agent", seq: 1, blocks: [{ type: "text", md }] }) as unknown as Message;

function view(p: Partial<ScreenAskViewProps> = {}) {
  const props: ScreenAskViewProps = {
    text: "",
    onText: noop,
    onSubmit: noop,
    onCancel: noop,
    destination: "new",
    onDestination: noop,
    ...p,
  };
  return render(<ScreenAskView {...props} />);
}

const ready = {
  status: "ready",
  mode: "window",
  thumbnail: "data:image/png;base64,AA==",
  appName: "Safari",
  image: "auto",
} as const;

describe("ScreenAskView (Siri-simple)", () => {
  it("collapsed: one bar with the orb, the input, a removable chip, mic and send", () => {
    const onDrop = vi.fn();
    view({ capture: ready, onDrop, dictation: { phase: "idle", toggle: noop } });
    expect(screen.getByTestId("screen-ask-orb").dataset.state).toBe("idle");
    expect(screen.getByPlaceholderText("Ask about your screen…")).toBeTruthy();
    expect(screen.getByTestId("screen-ask-chip").textContent).toContain("Safari");
    expect(screen.getByRole("button", { name: "Speak your request" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
    // Nothing else competes with the input until ⋯ is opened.
    expect(screen.queryByRole("button", { name: "Select area" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Current chat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Don't send what's on screen" }));
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it("⋯ holds the secondary controls", () => {
    view({ capture: ready });
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    for (const name of [
      "Capture again",
      "Select area",
      "Always send the screenshot",
      "Current chat",
    ])
      expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("the orb shows listening, thinking and answering", () => {
    expect(orbState({ dictation: { phase: "listening", toggle: noop } })).toBe("listening");
    expect(orbState({ capture: { ...ready, status: "capturing" } })).toBe("thinking");
    expect(orbState({ answer: { status: "streaming", messages: [] } })).toBe("thinking");
    expect(orbState({ answer: { status: "streaming", messages: [], streamingText: "Hi" } })).toBe(
      "answering",
    );
    expect(orbState({ answer: { status: "done", messages: [agent("m", "x")] } })).toBe("idle");

    view({ dictation: { phase: "listening", partial: "reply", toggle: noop } });
    expect(screen.getByTestId("screen-ask-orb").dataset.state).toBe("listening");
  });

  it("thinking is the orb, not a status row", () => {
    view({ text: "q", answer: { status: "streaming", messages: [] } });
    expect(screen.getByTestId("screen-ask-orb").dataset.state).toBe("thinking");
    expect(screen.getByText("Thinking…").className).toContain("sr-only");
    expect(screen.queryByTestId("screen-ask-answer")).toBeNull();
  });

  it("answers with the chat's renderer, in a scroll area with a maximum height", () => {
    const onOpen = vi.fn();
    view({
      text: "q",
      onOpen,
      answer: { status: "done", messages: [agent("m_2", "The build can't find **libfoo**.")] },
    });
    const area = screen.getByTestId("screen-ask-answer");
    expect(area.className).toContain("overflow-y-auto");
    expect(area.className).toMatch(/max-h-/);
    expect(area.querySelector("[data-streamdown=strong]")?.textContent).toBe("libfoo");
    fireEvent.click(screen.getByRole("button", { name: "Open in Psyche" }));
    expect(onOpen).toHaveBeenCalledOnce();
    // Sent: the input is the question, with no send or mic.
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
  });

  it("Esc closes from the input, from a button and from outside the panel", () => {
    const onCancel = vi.fn();
    view({ capture: ready, onCancel, dictation: { phase: "idle", toggle: noop } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Ask" }), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("Esc closes after the answer arrived too", () => {
    const onCancel = vi.fn();
    view({ onCancel, answer: { status: "done", messages: [agent("m", "Hi")] } });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("draws an opaque surface that follows light and dark, never glass", () => {
    view({});
    const surface = screen.getByRole("region", { name: "Ask about your screen" });
    expect(surface.className).toContain("bg-surface-overlay");
    // Glass sampled the empty window behind it: translucent tints and backdrop filters are out.
    expect(surface.className).not.toMatch(/backdrop|material-glass|bg-.*\/\d/);
    // Body text uses the AA-gated label tokens, not the metadata-only tertiary one.
    expect(surface.innerHTML).not.toContain("label-tertiary");
  });
});
