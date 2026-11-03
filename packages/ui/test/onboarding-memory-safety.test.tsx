import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HABIT_DEFAULTS, type HabitChoices } from "../src/screens/onboarding/habits.ts";
import { MemoryStep } from "../src/screens/onboarding/MemoryStep.tsx";
import {
  MEMORY_CHOICE_DEFAULTS,
  memorySettings,
  readMemoryChoices,
} from "../src/screens/onboarding/memory-choices.ts";
import {
  OnboardingFlow,
  type OnboardingFlowProps,
} from "../src/screens/onboarding/OnboardingFlow.tsx";
import { SafetyStep } from "../src/screens/onboarding/SafetyStep.tsx";
import type {
  MemoryChoices,
  TouchIdSetupPort,
  TouchIdStatus,
} from "../src/screens/onboarding/types.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** The Memory and Safety steps (docs/design/onboarding-2026.md §4). */

describe("the memory choices as Gateway settings", () => {
  it("starts from the owner's defaults: work off, people off", () => {
    expect(readMemoryChoices({})).toEqual(MEMORY_CHOICE_DEFAULTS);
    expect(memorySettings({}, MEMORY_CHOICE_DEFAULTS)).toEqual({});
  });

  it("turning work on writes enabled and consentedAt into memory.work, keeping the rest", () => {
    const stored = { "memory.work": { trackedLists: { l1: "p1" }, askWhereStopped: true } };
    const out = memorySettings(stored, {
      ...MEMORY_CHOICE_DEFAULTS,
      work: true,
      workConsentedAt: "2026-11-03T09:00:00.000Z",
    });
    expect(out).toEqual({
      "memory.work": {
        trackedLists: { l1: "p1" },
        askWhereStopped: true,
        enabled: true,
        consentedAt: "2026-11-03T09:00:00.000Z",
      },
    });
  });

  it("writes only what changed on a re-run, and keeps an earlier consent", () => {
    const stored = {
      "memory.work": { enabled: true, consentedAt: "2026-11-01T10:00:00.000Z" },
      "memory.surfaces": { birthdays: false },
    };
    const before = readMemoryChoices(stored);
    expect(before).toMatchObject({ work: true, workConsentedAt: "2026-11-01T10:00:00.000Z" });
    // Nothing touched: nothing written.
    expect(memorySettings(stored, before)).toEqual({});
    // People turned on: only memory.surfaces changes, and `birthdays` stays as it was.
    expect(memorySettings(stored, { ...before, people: true })).toEqual({
      "memory.surfaces": { birthdays: false, tiers: { people: { brief: true } } },
    });
    // Reminders turned on: memory.work keeps its consent.
    expect(memorySettings(stored, { ...before, remind: true })).toEqual({
      "memory.work": {
        enabled: true,
        consentedAt: "2026-11-01T10:00:00.000Z",
        remind: { enabled: true },
      },
    });
  });

  it("turning work off keeps the consent on record", () => {
    const stored = { "memory.work": { enabled: true, consentedAt: "2026-11-01T10:00:00.000Z" } };
    const out = memorySettings(stored, { ...readMemoryChoices(stored), work: false });
    expect(out["memory.work"]).toMatchObject({
      enabled: false,
      consentedAt: "2026-11-01T10:00:00.000Z",
    });
  });
});

function Harness({
  habits: h = HABIT_DEFAULTS,
  memory: m = MEMORY_CHOICE_DEFAULTS,
  onState,
}: {
  habits?: HabitChoices;
  memory?: MemoryChoices;
  onState?: (s: { habits: HabitChoices; memory: MemoryChoices }) => void;
}) {
  const [habits, setHabits] = useState(h);
  const [memory, setMemory] = useState(m);
  onState?.({ habits, memory });
  return (
    <StoryWorld>
      <MemoryStep
        persona="Wren"
        habits={habits}
        onHabitsChange={setHabits}
        memory={memory}
        onMemoryChange={setMemory}
        now={() => new Date("2026-11-03T09:00:00.000Z")}
      />
    </StoryWorld>
  );
}
const sw = (name: string) => screen.getByRole("switch", { name });
const checked = (name: string) => sw(name).getAttribute("aria-checked");

describe("Memory and daily habits", () => {
  it("has work and people off, and says what work covers with a general mix", () => {
    render(<Harness />);
    expect(checked("Track my work")).toBe("false");
    expect(checked("Include people in my brief")).toBe("false");
    const text = screen.getByTestId("onboarding-work").textContent ?? "";
    for (const word of ["bills", "rent", "taxes", "renewals", "work deadlines", "homework"])
      expect(text).toContain(word);
    // No people warning until they are on.
    expect(screen.queryByText(/anyone who sees your screen/)).toBeNull();
  });

  it("asks for consent before work tracking, and leaves it off when declined", async () => {
    render(<Harness />);
    await userEvent.click(sw("Track my work"));
    const card = await screen.findByTestId("work-consent");
    expect(within(card).getByText("What it reads")).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Not now" }));
    expect(checked("Track my work")).toBe("false");
    expect(screen.queryByTestId("work-consent")).toBeNull();
  });

  it("records the consent time when confirmed, then shows the reminder switch", async () => {
    const states: { memory: MemoryChoices }[] = [];
    render(<Harness onState={(s) => states.push(s)} />);
    expect(screen.queryByRole("switch", { name: "Remind me what is due tomorrow" })).toBeNull();
    await userEvent.click(sw("Track my work"));
    await userEvent.click(
      within(await screen.findByTestId("work-consent")).getByRole("button", { name: "Turn on" }),
    );
    expect(checked("Track my work")).toBe("true");
    expect(states.at(-1)?.memory).toMatchObject({
      work: true,
      workConsentedAt: "2026-11-03T09:00:00.000Z",
    });
    expect(checked("Remind me what is due tomorrow")).toBe("false");
  });

  it("does not show the card again once it has been confirmed", async () => {
    render(
      <Harness
        memory={{ ...MEMORY_CHOICE_DEFAULTS, workConsentedAt: "2026-11-01T10:00:00.000Z" }}
      />,
    );
    await userEvent.click(sw("Track my work"));
    expect(screen.queryByTestId("work-consent")).toBeNull();
    expect(checked("Track my work")).toBe("true");
  });

  it("says reminders ride on the wrap-up when it is off, and turns it on in place", async () => {
    render(
      <Harness
        habits={{ brief: true, wrapup: false, followups: true }}
        memory={{
          work: true,
          workConsentedAt: "2026-11-01T10:00:00.000Z",
          remind: true,
          people: false,
        }}
      />,
    );
    const needs = screen.getByTestId("memory-needs");
    expect(needs.textContent).toContain("The evening wrap-up is off, so nothing will be sent");
    await userEvent.click(within(needs).getByRole("button", { name: "Turn on wrap-up" }));
    expect(checked("Evening wrap-up")).toBe("true");
    expect(screen.queryByTestId("memory-needs")).toBeNull();
  });

  it("warns who can see the brief when people are included, and needs the brief on", async () => {
    render(<Harness habits={{ brief: false, wrapup: false, followups: false }} />);
    await userEvent.click(sw("Include people in my brief"));
    expect(screen.getByRole("status").textContent).toContain("anyone who sees your screen");
    await userEvent.click(screen.getByRole("button", { name: "Turn on brief" }));
    expect(checked("Daily brief")).toBe("true");
  });

  it("offers importing from another assistant only when the host can do it", () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByText("Bring memory from ChatGPT or Claude")).toBeNull();
    unmount();
    render(
      <StoryWorld>
        <MemoryStep
          persona="Wren"
          habits={HABIT_DEFAULTS}
          onHabitsChange={() => {}}
          memory={MEMORY_CHOICE_DEFAULTS}
          onMemoryChange={() => {}}
          onPreviewImport={async () => ({ items: [], skipped: 0 })}
          onCommitImport={async () => 0}
        />
      </StoryWorld>,
    );
    expect(screen.getByText("Bring memory from ChatGPT or Claude")).toBeTruthy();
  });
});

describe("Skip for now on the Memory step leaves its settings alone", () => {
  const run = (props: Partial<OnboardingFlowProps> = {}) => {
    const onComplete = vi.fn();
    render(
      <StoryWorld>
        <OnboardingFlow onComplete={onComplete} defaultStep="memory" {...props} />
      </StoryWorld>,
    );
    return onComplete;
  };

  it("reports habits and memory after Next, and neither after Skip", async () => {
    const next = run();
    await userEvent.click(screen.getByRole("switch", { name: "Evening wrap-up" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // Safety → Done
    await userEvent.click(screen.getByRole("button", { name: "Open the main chat" }));
    const skipped = next.mock.calls[0]?.[0];
    expect(skipped).not.toHaveProperty("habits");
    expect(skipped).not.toHaveProperty("memory");
  });

  it("Back then Next after a skip applies the choices again", async () => {
    const next = run();
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("switch", { name: "Evening wrap-up" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Open the main chat" }));
    expect(next.mock.calls[0]?.[0]).toMatchObject({
      habits: { brief: true, wrapup: true, followups: true },
      memory: MEMORY_CHOICE_DEFAULTS,
    });
  });
});

const KEY_ID = "0123456789abcdef".repeat(4);

function port(initial: TouchIdStatus) {
  let status = initial;
  const impl = {
    status: vi.fn(async () => status),
    register: vi.fn(async () => {
      status = { ...status, registered: true };
    }),
    allowDevFileKey: vi.fn(async (on: boolean) => {
      status = { ...status, allowDevFileKey: on };
    }),
  };
  return impl satisfies TouchIdSetupPort;
}

function safety(
  p: TouchIdSetupPort | undefined,
  extra: { helperKind?: "starting" | "paired" } = {},
) {
  render(
    <StoryWorld>
      <SafetyStep
        persona="Wren"
        touchId={p}
        {...(extra.helperKind ? { helper: { kind: extra.helperKind } } : {})}
      />
    </StoryWorld>,
  );
}

describe("Safety: Touch ID", () => {
  it("registers the helper's key in one click and then says it is set up", async () => {
    const p = port({
      identity: { deviceId: "d1", keyId: KEY_ID, kind: "keychain" },
      registered: false,
      allowDevFileKey: false,
    });
    safety(p, { helperKind: "paired" });
    expect(await screen.findByTestId("touch-id-key-id")).toBeTruthy();
    expect(screen.getByTestId("touch-id-key-id").textContent).toContain("0123 4567 89ab cdef");
    const button = screen.getByRole("button", { name: "Register this key" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    // A keychain key needs no development switch.
    expect(screen.queryByRole("switch")).toBeNull();
    await userEvent.click(button);
    expect(p.register).toHaveBeenCalledOnce();
    expect(await screen.findByText("Set up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Register this key" })).toBeNull();
  });

  it("needs the development switch first on a build without a provisioning profile", async () => {
    const p = port({
      identity: { deviceId: "d1", keyId: KEY_ID, kind: "enclave_file" },
      registered: false,
      allowDevFileKey: false,
    });
    safety(p, { helperKind: "paired" });
    const register = await screen.findByRole("button", { name: "Register this key" });
    expect((register as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Secure Enclave file/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("switch", { name: "Allow a development Touch ID key" }));
    expect(p.allowDevFileKey).toHaveBeenCalledWith(true);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Register this key" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await userEvent.click(screen.getByRole("button", { name: "Register this key" }));
    expect(p.register).toHaveBeenCalledOnce();
  });

  it("says when registering failed and offers it again", async () => {
    const p = port({
      identity: { deviceId: "d1", keyId: KEY_ID, kind: "keychain" },
      registered: false,
      allowDevFileKey: false,
    });
    p.register.mockRejectedValueOnce(new Error("the helper is not paired"));
    safety(p, { helperKind: "paired" });
    await userEvent.click(await screen.findByRole("button", { name: "Register this key" }));
    expect((await screen.findByRole("alert")).textContent).toContain("the helper is not paired");
    expect(screen.getByRole("button", { name: "Register this key" })).toBeTruthy();
  });

  it("waits for a helper that is still starting, and checks again on request", async () => {
    const p = port({ identity: { deviceId: "d1" }, registered: false, allowDevFileKey: false });
    safety(p, { helperKind: "starting" });
    expect(await screen.findByText(/still starting/)).toBeTruthy();
    expect(screen.getByTestId("mac-helper-status")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(p.status).toHaveBeenCalledTimes(2);
  });

  it("shows no Touch ID row when the build bundles no helper or the host has no port", async () => {
    const none = port({ identity: null, registered: false, allowDevFileKey: false });
    safety(none);
    await waitFor(() => expect(none.status).toHaveBeenCalled());
    expect(screen.queryByText("Touch ID for approvals")).toBeNull();
    expect(screen.queryByRole("button", { name: "Register this key" })).toBeNull();
  });

  it("shows no Touch ID row on the web", () => {
    safety(undefined);
    expect(screen.queryByText("Touch ID for approvals")).toBeNull();
  });
});

describe("Safety: what runs on its own", () => {
  it("does not ask for files, apps or the screen, and says where that happens", () => {
    safety(undefined);
    expect(screen.getByTestId("onboarding-safety").textContent).toContain("asks in chat");
    expect(
      screen.getByText(/ones that only read, like ls or cat, run without a card/),
    ).toBeTruthy();
  });
});
