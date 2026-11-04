import { type AppleLlmStatus, EVERYTHING_MEMORY_DEFAULTS } from "@psyche/protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  type EverythingValues,
  localReady,
  PerSourceModels,
} from "../src/memory/EverythingFields.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** EM11 with Apple's on-device model: the per-source choice in memory settings (fakes only). */

const status = (over: Partial<AppleLlmStatus> = {}): AppleLlmStatus => ({
  ref: "apple/on-device",
  helperConnected: true,
  available: true,
  contextTokens: 4096,
  ...over,
});

const base = (): EverythingValues => {
  const v = structuredClone(EVERYTHING_MEMORY_DEFAULTS) as EverythingValues;
  return {
    ...v,
    enabled: true,
    sources: { ...v.sources, mail: true, messages: true },
    model: { default: { kind: "cloud", ref: "fake/haiku" } },
  };
};

let latest: EverythingValues = base();

function Harness({
  appleStatus,
  initial = base(),
}: {
  appleStatus: AppleLlmStatus | null;
  initial?: EverythingValues;
}) {
  const [value, setValue] = useState(initial);
  latest = value;
  return (
    <StoryWorld>
      <PerSourceModels
        value={value}
        onChange={setValue}
        localConfirmed={[]}
        onConfirmLocal={() => undefined}
        appleStatus={appleStatus}
      />
    </StoryWorld>
  );
}

const row = (name: RegExp) =>
  screen.getAllByTestId("persource-row").find((r) => name.test(r.textContent ?? "")) as HTMLElement;

describe("Apple's on-device model per source", () => {
  it("is offered, labelled Experimental, when Apple's model is available", () => {
    render(<Harness appleStatus={status()} />);
    const select = within(row(/Messages/)).getByRole("combobox") as HTMLSelectElement;
    const option = within(select).getByRole("option", { name: /Apple on-device model/ });
    expect(option.textContent).toMatch(/experimental/);
  });

  it.each([
    ["no Mac helper", status({ helperConnected: false, available: false })],
    [
      "Apple Intelligence off",
      status({ available: false, reason: "apple_intelligence_not_enabled" }),
    ],
    ["no status yet", null],
  ])("is hidden when unavailable: %s", (_name, s) => {
    render(<Harness appleStatus={s} />);
    const select = within(row(/Messages/)).getByRole("combobox") as HTMLSelectElement;
    expect(within(select).queryByRole("option", { name: /Apple on-device model/ })).toBeNull();
  });

  it("choosing it for one source stores {local, apple/on-device} for that source only", () => {
    render(<Harness appleStatus={status()} />);
    fireEvent.change(within(row(/Messages/)).getByRole("combobox"), { target: { value: "apple" } });
    expect(latest.model.perSource).toEqual({
      messages: { kind: "local", ref: "apple/on-device" },
    });
    expect(latest.model.default.kind).toBe("cloud");
    const note = screen.getByTestId("persource-apple").textContent ?? "";
    expect(note).toMatch(/stays on this Mac/);
    expect(note).toMatch(/never falls back to a cloud model/);
    expect(note).toMatch(/Experimental/);
    // No RAM warning, no model name to type: the system owns this model.
    expect(screen.queryByTestId("persource-warning")).toBeNull();
    expect(screen.queryByLabelText("Model for Messages")).toBeNull();
    expect((within(row(/Mail/)).getByRole("combobox") as HTMLSelectElement).value).toBe("default");
  });

  it("a source already set to it stays visible, with the reason, when it stops being available", () => {
    const initial = base();
    initial.model = {
      ...initial.model,
      perSource: { messages: { kind: "local", ref: "apple/on-device" } },
    };
    render(
      <Harness
        appleStatus={status({ available: false, reason: "unsupported_os" })}
        initial={initial}
      />,
    );
    const select = within(row(/Messages/)).getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("apple");
    expect(screen.getByTestId("persource-apple-reason").textContent).toMatch(
      /needs macOS 26 or later.*skipped/,
    );
  });

  it("needs no RAM confirmation to turn on, unlike another local model", () => {
    const v = base();
    v.model = { ...v.model, perSource: { messages: { kind: "local", ref: "apple/on-device" } } };
    expect(localReady(v, [])).toBe(true);
    v.model = { ...v.model, perSource: { messages: { kind: "local", ref: "ollama/qwen3:4b" } } };
    expect(localReady(v, [])).toBe(false);
  });
});
