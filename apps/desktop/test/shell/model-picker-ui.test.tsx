// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../src/shell/components/Overlays.tsx";
import { ShellProvider } from "../../src/shell/context.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

const LISTED = {
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      models: [
        { ref: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
        { ref: "anthropic/claude-opus-5-5" },
      ],
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      models: [
        { ref: "lmstudio/embed", capabilities: { embeddings: true } },
        { ref: "lmstudio/qwen/qwen3.8-27b", label: "Qwen 3.8" },
      ],
    },
  ],
};

function setup(listed: unknown, current: string | null = "anthropic/claude-opus-5-5") {
  const store = {
    getState: () => ({ approvals: [] }),
    subscribe: () => () => {},
    toast: vi.fn(),
    call: vi.fn(async () => listed),
    tap: () => () => {},
    refresh: vi.fn(async () => {}),
  };
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <ShellProvider platform={{} as ShellPlatform} store={store as never} mac>
      <ModelPicker current={current} onPick={onPick} onClose={onClose} />
    </ShellProvider>,
  );
  return { onPick, onClose };
}

describe("model picker", () => {
  it("lists the configured models by name, without embedding models, current one checked", async () => {
    setup(LISTED);
    const opts = await screen.findAllByTestId("model-option");
    expect(opts.map((o) => o.textContent)).toEqual([
      "Claude Sonnet 5.5",
      "✓ anthropic/claude-opus-5-5",
      "Qwen 3.8",
    ]);
    expect(opts[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("picks the same provider/model string the free field produced", async () => {
    const { onPick, onClose } = setup(LISTED);
    const opts = await screen.findAllByTestId("model-option");
    fireEvent.click(opts[2] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("lmstudio/qwen/qwen3.8-27b");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps a free field under 'Other model…'", async () => {
    const { onPick } = setup(LISTED);
    await screen.findAllByTestId("model-option");
    await act(async () => fireEvent.click(screen.getByTestId("model-other")));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "openrouter/some/model" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("openrouter/some/model");
  });

  it("shows the field straight away when no models are listed", async () => {
    setup({ providers: [] }, null);
    expect(await screen.findByTestId("model-picker-empty")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});
