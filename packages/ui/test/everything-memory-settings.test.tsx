import type { EverythingMemorySettings } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { estimateBackfill, estimateMonthly, formatUsd } from "../src/memory/estimate.ts";
import { MemoryControlsSection } from "../src/screens/settings/DataControlsSection.tsx";
import { EverythingMemorySection } from "../src/screens/settings/EverythingMemorySection.tsx";
import { MemoryAdvancedSection } from "../src/screens/settings/MemoryAdvancedSection.tsx";
import { MemoryPrivacySection } from "../src/screens/settings/MemoryPrivacySection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

let gateway: MockGateway;
const stored = () =>
  gateway.world.settings["memory.everything"] as EverythingMemorySettings | undefined;

function show(edit?: (w: FixtureWorld) => void) {
  return render(
    <StoryWorld {...(edit ? { edit } : {})} onGateway={(g) => (gateway = g)}>
      {/* The Memory page's sections that hold Everything memory: its switch, Sources, Privacy, Advanced. */}
      <MemoryControlsSection />
      <EverythingMemorySection />
      <MemoryPrivacySection />
      <MemoryAdvancedSection />
    </StoryWorld>,
  );
}

const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));

describe("cost estimate", () => {
  it("is free for None and Local, and about the doc's typical day for Cloud", () => {
    expect(estimateMonthly("none", { mail: true })).toEqual({ low: 0, typical: 0, high: 0 });
    expect(estimateMonthly("local", { mail: true })).toEqual({ low: 0, typical: 0, high: 0 });
    const all = { mail: true, messages: true, notes: true, calendar: true };
    const m = estimateMonthly("cloud", all);
    // 99 items a day ≈ $0.11 a day ≈ $3.2 a month, between a light and a heavy month.
    expect(m.typical).toBeGreaterThan(3);
    expect(m.typical).toBeLessThan(4);
    expect(m.low).toBeLessThan(m.typical);
    expect(m.high).toBeGreaterThan(m.typical);
    expect(estimateBackfill("cloud", all, 90)).toBeGreaterThan(9);
    expect(estimateBackfill("cloud", all, 90)).toBeLessThan(11);
    expect(formatUsd(0.456)).toBe("$0.46");
    expect(formatUsd(12.4)).toBe("$12");
  });
});

describe("Settings → Memory → Sources, Privacy and Advanced", () => {
  it("is off by default: the Basics switch and a Set up button show, and nothing is stored", async () => {
    show();
    const sw = await screen.findByRole("switch", { name: "Mail, messages and notes" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("What it reads")).toBeNull();
    expect(screen.queryByText("Model")).toBeNull();
    expect(screen.getByRole("button", { name: "Set up…" })).toBeTruthy();
    expect(stored()).toBeUndefined();
  });

  it("Set up… in Sources runs the same consent", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Set up…" }));
    expect(await screen.findByTestId("everything-consent")).toBeTruthy();
  });

  it("the consent walks four screens and a summary, and Cancel leaves it off", async () => {
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Mail, messages and notes" }));
    const dialog = await screen.findByTestId("everything-consent");
    expect(within(dialog).getByTestId("consent-what").textContent).toMatch(/Sam’s birthday/);
    next();
    // Sources: all off.
    for (const sw of within(dialog).getAllByRole("switch"))
      expect(sw.getAttribute("aria-checked")).toBe("false");
    next();
    expect(within(dialog).getByText("Sensitive topics")).toBeTruthy();
    next();
    expect(within(dialog).getByTestId("everything-cost").textContent).toMatch(/Free/);
    next();
    expect(within(dialog).getByTestId("consent-summary").textContent).toMatch(/Model: None/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("everything-consent")).toBeNull());
    expect(stored()).toBeUndefined();
  });

  it("turning on with Cloud and Mail saves the accepted defaults plus those choices", async () => {
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Mail, messages and notes" }));
    const dialog = await screen.findByTestId("everything-consent");
    next();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Mail" }));
    next();
    next();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Cloud/ }));
    expect(within(dialog).getByTestId("everything-cost").textContent).toMatch(/About \$.* a month/);
    expect(within(dialog).getByTestId("everything-cost").textContent).toMatch(/first 30 days/);
    next();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(stored()?.enabled).toBe(true));
    const s = stored();
    expect(s?.model.default.kind).toBe("cloud");
    expect(s?.sources.mail).toBe(true);
    expect(s?.sources.messages).toBe(false);
    expect(s?.schedule.backfillDays).toBe("30");
    expect(s?.schedule.runOnBattery).toBe(false);
    expect(s?.people.default).toBe("two_way");
    expect(s?.agentAccess).toBe("accepted");
    expect(Object.values(s?.sensitive ?? {}).some(Boolean)).toBe(false);
  });

  it("a local model shows the RAM warning and cannot be turned on until it is confirmed", async () => {
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Mail, messages and notes" }));
    const dialog = await screen.findByTestId("everything-consent");
    next();
    next();
    next();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Local/ }));
    const warning = within(dialog).getByTestId("local-model-warning");
    expect(warning.textContent).toMatch(/About 3 GB of RAM/);
    expect(warning.textContent).toMatch(/Nothing is downloaded or started until you confirm/);
    fireEvent.change(within(dialog).getByLabelText("Local model"), {
      target: { value: "ollama/qwen3:4b" },
    });
    next();
    const finish = within(dialog).getByRole("button", { name: "Turn on" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: /I understand, use ollama\/qwen3:4b/ }),
    );
    next();
    expect(
      (within(dialog).getByRole("button", { name: "Turn on" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(stored()?.model.default).toEqual({ kind: "local", ref: "ollama/qwen3:4b" }),
    );
    expect(gateway.world.settings["memory.everything.localConfirmed"]).toEqual(["ollama/qwen3:4b"]);
  });

  it("when on, shows the controls; government ids and account numbers have no switch", async () => {
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Mail, messages and notes" }));
    const dialog = await screen.findByTestId("everything-consent");
    next();
    expect(within(dialog).getAllByRole("switch")).toHaveLength(7);
    expect(dialog.textContent).toContain("Transcripts");
    expect(dialog.textContent).not.toContain("Browser pages");
    expect(dialog.textContent).not.toContain("Chats with Psyche");
    for (let i = 0; i < 3; i++) next();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await screen.findByText("Sensitive topics");
    expect(
      screen.getAllByRole("switch").map((s) => s.getAttribute("aria-label") ?? s.textContent),
    ).not.toContain("Government IDs");
    expect(document.body.textContent).toMatch(
      /Government IDs and account numbers are never stored/,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Health" }));
    await waitFor(() => expect(stored()?.sensitive.health).toBe(true));
    fireEvent.click(screen.getByRole("switch", { name: "Run on battery" }));
    await waitFor(() => expect(stored()?.schedule.runOnBattery).toBe(true));
  });

  it("per-contact exclusion: add shows a masked hint, forget asks first with the counts, remove works", async () => {
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Mail, messages and notes" }));
    const dialog = await screen.findByTestId("everything-consent");
    for (let i = 0; i < 4; i++) next();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    const input = await screen.findByLabelText("Address, number or domain");
    fireEvent.change(input, { target: { value: "sam@acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    const row = await screen.findByTestId("exclusion-row");
    expect(row.textContent).toMatch(/s•••@acme\.com/);
    expect(row.textContent).not.toMatch(/sam@acme\.com/);
    fireEvent.change(screen.getByLabelText("Address, number or domain"), {
      target: { value: "priya@x.io" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Exclude and forget" }));
    expect((await screen.findByTestId("forget-confirm")).textContent).toMatch(
      /deletes 2 facts and 3 quotes/,
    );
    expect(gateway.world.review?.exclusions).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Exclude and forget" }));
    await waitFor(() => expect(gateway.world.review?.exclusions).toHaveLength(2));
    fireEvent.click(
      within((await screen.findAllByTestId("exclusion-row"))[0] as HTMLElement).getByRole(
        "button",
        { name: "Remove" },
      ),
    );
    await waitFor(() => expect(gateway.world.review?.exclusions).toHaveLength(1));
  });

  it("what people say about others is a separate switch, off by default", async () => {
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Mail, messages and notes" }));
    const dialog = await screen.findByTestId("everything-consent");
    for (let i = 0; i < 4; i++) next();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    const sw = await screen.findByRole("switch", { name: "Also what they say about other people" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(stored()?.people.aboutOthers).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(stored()?.people.aboutOthers).toBe(true));
    expect(stored()?.people.default).toBe("two_way");
  });

  async function turnedOn(edit?: Parameters<typeof show>[0]) {
    show(edit);
    fireEvent.click(await screen.findByRole("switch", { name: "Mail, messages and notes" }));
    const dialog = await screen.findByTestId("everything-consent");
    for (let i = 0; i < 4; i++) next();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    return screen.findByRole("button", { name: "Run now" });
  }

  it("Run now shows the estimate first and then what was read", async () => {
    const run = await turnedOn();
    expect(screen.getByTestId("run-estimate").textContent).toMatch(/Free/);
    fireEvent.click(run);
    expect((await screen.findByTestId("run-result")).textContent).toMatch(
      /Read 12 items: 3 facts proposed, 1 held back\./,
    );
  });

  it("Run now says why it did not run, in plain words", async () => {
    const run = await turnedOn((w) => {
      w.review = {
        items: [],
        quarantine: [],
        runs: [],
        runResult: {
          ran: false,
          reason: "battery",
          itemsRead: 0,
          factsProposed: 0,
          quarantined: 0,
          deferred: 0,
          tokens: 0,
        },
      };
    });
    fireEvent.click(run);
    expect((await screen.findByTestId("run-result")).textContent).toBe(
      "Not now: the Mac is on battery. Plug it in, or allow battery runs.",
    );
  });
});

describe("a model per source (EM11)", () => {
  async function onWithMailAndMessages() {
    show();
    fireEvent.click(await screen.findByRole("switch", { name: "Mail, messages and notes" }));
    const dialog = await screen.findByTestId("everything-consent");
    next();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Mail" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Messages" }));
    next();
    next();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Cloud/ }));
    return dialog;
  }

  it("lists only the sources that are on, defaulting to the choice above", async () => {
    const dialog = await onWithMailAndMessages();
    const rows = within(dialog).getAllByTestId("persource-row");
    expect(rows.map((r) => r.textContent?.match(/Mail|Messages/)?.[0])).toEqual([
      "Mail",
      "Messages",
    ]);
    for (const r of rows)
      expect((within(r).getByRole("combobox") as HTMLSelectElement).value).toBe("default");
  });

  it("Messages on Local needs its own memory warning confirmed before turning on", async () => {
    const dialog = await onWithMailAndMessages();
    const row = within(dialog).getAllByTestId("persource-row")[1] as HTMLElement;
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "local" } });
    fireEvent.change(within(row).getByLabelText("Model for Messages"), {
      target: { value: "ollama/qwen3:4b" },
    });
    expect(within(row).getByTestId("persource-warning").textContent).toMatch(/About 3 GB of RAM/);
    next();
    const finish = within(dialog).getByRole("button", { name: "Turn on" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: /I understand, use ollama\/qwen3:4b/ }),
    );
    next();
    expect(
      (within(dialog).getByRole("button", { name: "Turn on" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect((stored()?.model.perSource as Record<string, unknown> | undefined)?.messages).toEqual({
        kind: "local",
        ref: "ollama/qwen3:4b",
      }),
    );
    expect(stored()?.model.default.kind).toBe("cloud");
    expect(gateway.world.settings["memory.everything.localConfirmed"]).toEqual(["ollama/qwen3:4b"]);
  });

  it("back to Same as above removes the override", async () => {
    const dialog = await onWithMailAndMessages();
    const row = within(dialog).getAllByTestId("persource-row")[0] as HTMLElement;
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "none" } });
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "default" } });
    next();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(stored()?.enabled).toBe(true));
    expect(stored()?.model.perSource).toBeUndefined();
  });
});
