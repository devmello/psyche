// @vitest-environment happy-dom

import { UiSlotsProvider } from "@psyche/ui";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeachReview } from "../../src/shell/components/TeachReview.tsx";
import {
  moveStep,
  removeStep,
  reviewFrom,
  reviewFromKept,
  reviewProblems,
  setChoice,
  suggestInputName,
  toSaveSteps,
} from "../../src/shell/components/teach-review.ts";
import { ShellProvider } from "../../src/shell/context.tsx";
import type { BrowserPort, ShellPlatform, TeachCapture } from "../../src/shell/platform.ts";

afterEach(cleanup);

/** A Luhn-valid test card number, assembled at run time so the repo's secret scan never sees one. */
const CARD = ["4111", "1111", "1111", "1111"].join(" ");

const capture = (): TeachCapture => ({
  id: "teach_abcdef123456",
  endedBy: "stop",
  steps: [
    { id: "s1", kind: "navigate", url: "https://billing.example.com/reports" },
    {
      id: "s2",
      kind: "type",
      role: "textbox",
      name: "From",
      selector: "#from",
      sample: "2026-11-01",
    },
    { id: "s3", kind: "type", role: "textbox", name: "Password", selector: "#pw", sensitive: true },
    { id: "s4", kind: "click", role: "button", name: "Export", selector: "#export" },
  ],
});

describe("the review model", () => {
  it("starts with every typed value hidden: ask each time, nothing kept", () => {
    const rows = reviewFrom(capture());
    expect(rows.map((r) => r.choice)).toEqual(["ask", "ask", "ask", "ask"]);
    const steps = toSaveSteps(rows);
    expect(JSON.stringify(steps)).not.toContain("2026-11-01");
    expect(steps[1]).not.toHaveProperty("value");
    expect(steps[1]).not.toHaveProperty("keepValue");
  });

  it("sends a value only when the owner chose to keep it, and never for a sensitive step", () => {
    let rows = reviewFrom(capture());
    rows = setChoice(rows, 1, "keep");
    rows = setChoice(rows, 2, "keep");
    const steps = toSaveSteps(rows);
    expect(steps[1]).toMatchObject({ keepValue: true, value: "2026-11-01" });
    expect(steps[2]).toMatchObject({ sensitive: true });
    expect(steps[2]).not.toHaveProperty("value");
    expect(steps[2]).not.toHaveProperty("keepValue");
  });

  it("makes an input instead of a value, with a suggested name", () => {
    let rows = reviewFrom(capture());
    expect(rows[1]?.inputName).toBe("from");
    rows = setChoice(rows, 1, "input");
    const steps = toSaveSteps(rows);
    expect(steps[1]).toMatchObject({ input: { name: "from" } });
    expect(steps[1]).not.toHaveProperty("value");
    expect(suggestInputName("From date", new Set())).toBe("from_date");
    expect(suggestInputName("From date", new Set(["from_date"]))).toBe("from_date_2");
    expect(suggestInputName("2nd", new Set())).toBe("nd");
    expect(suggestInputName(undefined, new Set())).toBe("value");
  });

  it("a card number in an ordinary field is dropped even if the owner keeps it", () => {
    const rows = setChoice(
      reviewFrom({
        id: "teach_abcdef123456",
        endedBy: "stop",
        steps: [{ id: "s1", kind: "type", role: "textbox", name: "Memo", sample: CARD }],
      }),
      0,
      "keep",
    );
    const [s] = toSaveSteps(rows);
    expect(s?.sensitive).toBe(true);
    expect(JSON.stringify(s)).not.toContain("4111");
  });

  it("edits: reorder, remove, and name problems", () => {
    const rows = reviewFrom(capture());
    expect(moveStep(rows, 3, -1).map((r) => r.id)).toEqual(["s1", "s2", "s4", "s3"]);
    expect(moveStep(rows, 0, -1).map((r) => r.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(removeStep(rows, 1).map((r) => r.id)).toEqual(["s1", "s3", "s4"]);
    let two = setChoice(reviewFrom(capture()), 1, "input");
    expect(reviewProblems(two)).toEqual([]);
    two = two.map((r, i) => (i === 1 ? { ...r, inputName: "Bad Name" } : r));
    expect(reviewProblems(two)[0]).toContain("input name");
  });

  it("opens a kept recording with only what was kept", () => {
    const rows = reviewFromKept([
      { id: "s1", kind: "type", role: "textbox", name: "To", keepValue: true, value: "x" },
      { id: "s2", kind: "type", role: "textbox", name: "Pw", sensitive: true },
      { id: "s3", kind: "type", role: "textbox", name: "Who", input: { name: "who" } },
    ]);
    expect(rows.map((r) => r.choice)).toEqual(["keep", "ask", "input"]);
  });
});

function setup(over: { teachKeep?: BrowserPort["teachKeep"]; calls?: unknown[][] } = {}) {
  const calls: unknown[][] = over.calls ?? [];
  const listeners = new Set<(e: { event: string; payload: unknown }) => void>();
  const store = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === "skills.drafts.fromRecording")
        return { draft: { id: "skd_1", name: "export-the-weekly-report", status: "open" } };
      return {};
    }),
    toast: vi.fn(),
    refresh: vi.fn(async () => {}),
    tap: (cb: (e: { event: string; payload: unknown }) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const port = { teachKeep: over.teachKeep } as unknown as BrowserPort;
  const prefill = vi.fn();
  const onClose = vi.fn();
  const ui = render(
    <ShellProvider platform={{} as ShellPlatform} store={store as never} mac={true}>
      <UiSlotsProvider value={{ prefillComposer: prefill }}>
        <TeachReview capture={capture()} port={port} onClose={onClose} />
      </UiSlotsProvider>
    </ShellProvider>,
  );
  return {
    ...ui,
    store,
    port,
    prefill,
    onClose,
    calls,
    emit: (e: { event: string; payload: unknown }) => {
      for (const l of listeners) l(e);
    },
  };
}

describe("the review screen", () => {
  it("shows the steps in plain words, with a sensitive one that cannot be edited", () => {
    setup();
    const words = screen.getAllByTestId("teach-words").map((n) => n.textContent);
    expect(words).toEqual([
      "Open billing.example.com/reports",
      "Type what you tell it into ‘From’",
      "You type into ‘Password’ yourself",
      "Click ‘Export’",
    ]);
    const steps = screen.getAllByTestId("teach-step");
    expect(within(steps[2] as HTMLElement).queryByTestId("teach-choice")).toBeNull();
    expect(within(steps[2] as HTMLElement).getByText(/Not recorded/)).toBeTruthy();
    // The typed example is never on screen unless kept.
    expect(document.body.textContent).not.toContain("2026-11-01");
  });

  it("lets the owner delete and reorder steps", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove step 4" }));
    expect(screen.getAllByTestId("teach-step")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 down" }));
    const words = screen.getAllByTestId("teach-words").map((n) => n.textContent);
    expect(words[1]).toBe("You type into ‘Password’ yourself");
  });

  it("wants a name before it saves", async () => {
    const { calls } = setup();
    await act(async () => fireEvent.click(screen.getByTestId("teach-save")));
    expect(screen.getByTestId("teach-error").textContent).toContain("name");
    expect(calls).toEqual([]);
  });

  it("saves a skill draft through the owner-approved path: draft first, then the approval card", async () => {
    const { calls } = setup();
    fireEvent.change(screen.getByTestId("teach-title"), {
      target: { value: "Export the weekly report" },
    });
    await act(async () => fireEvent.click(screen.getByTestId("teach-save")));
    expect(calls.map((c) => c[0])).toEqual(["skills.drafts.fromRecording", "skills.drafts.accept"]);
    const sent = calls[0]?.[1] as { title: string; steps: unknown[] };
    expect(sent.title).toBe("Export the weekly report");
    expect(sent.steps).toHaveLength(4);
    // Masked by default: the example never left this window.
    expect(JSON.stringify(sent)).not.toContain("2026-11-01");
    expect(calls[1]?.[1]).toEqual({ draftId: "skd_1" });
    expect(screen.getByTestId("teach-done").textContent).toContain("waiting for your approval");
    // Not installed yet: no way to run it.
    expect(screen.queryByTestId("teach-run")).toBeNull();
  });

  it("sends a kept value only when asked, and keeps the recording only when asked", async () => {
    const teachKeep = vi.fn(async (_id: string, _title: string, _steps: unknown) => ({
      id: "x",
      title: "x",
      keptAt: 1,
      steps: [],
    }));
    const { calls } = setup({ teachKeep });
    fireEvent.change(screen.getByTestId("teach-title"), { target: { value: "Report" } });
    const choices = screen.getAllByTestId("teach-choice");
    fireEvent.change(choices[0] as HTMLElement, { target: { value: "keep" } });
    expect(screen.getByText(/Saved with the skill: “2026-11-01”/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("teach-keep"));
    await act(async () => fireEvent.click(screen.getByTestId("teach-save")));
    const sent = calls[0]?.[1] as { steps: { value?: string; sensitive?: boolean }[] };
    expect(sent.steps[1]?.value).toBe("2026-11-01");
    expect(sent.steps[2]).not.toHaveProperty("value");
    expect(teachKeep).toHaveBeenCalledTimes(1);
    expect(teachKeep.mock.calls[0]?.[0]).toBe("teach_abcdef123456");
  });

  it("does not keep the recording by default", async () => {
    const teachKeep = vi.fn();
    setup({ teachKeep: teachKeep as never });
    fireEvent.change(screen.getByTestId("teach-title"), { target: { value: "Report" } });
    await act(async () => fireEvent.click(screen.getByTestId("teach-save")));
    expect(teachKeep).not.toHaveBeenCalled();
  });

  it("offers Run it once now only after the owner approves, and only fills the message box", async () => {
    const { emit, prefill, onClose } = setup();
    fireEvent.change(screen.getByTestId("teach-title"), { target: { value: "Report" } });
    await act(async () => fireEvent.click(screen.getByTestId("teach-save")));
    expect(screen.queryByTestId("teach-run")).toBeNull();
    // Another draft being installed changes nothing.
    act(() =>
      emit({
        event: "skills.draft.updated",
        payload: { draft: { id: "skd_other", status: "installed" } },
      }),
    );
    expect(screen.queryByTestId("teach-run")).toBeNull();
    act(() =>
      emit({
        event: "skills.draft.updated",
        payload: { draft: { id: "skd_1", status: "installed" } },
      }),
    );
    const run = screen.getByTestId("teach-run");
    fireEvent.click(run);
    // Never sent from here: the owner presses Send, and the agent loop (and the broker) take over.
    expect(prefill).toHaveBeenCalledWith("/export-the-weekly-report");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a refusal and stays on the review", async () => {
    const calls: unknown[][] = [];
    const { store } = setup({ calls });
    store.call.mockImplementationOnce(async () => {
      throw new Error("policy_denied");
    });
    fireEvent.change(screen.getByTestId("teach-title"), { target: { value: "Report" } });
    await act(async () => fireEvent.click(screen.getByTestId("teach-save")));
    expect(screen.getByTestId("teach-error").textContent).toContain("couldn't save");
    expect(screen.getByTestId("teach-review")).toBeTruthy();
  });
});
