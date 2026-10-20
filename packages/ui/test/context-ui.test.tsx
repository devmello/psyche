import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompactionMarker } from "../src/chat/context/CompactionMarker.tsx";
import { ContextMeter } from "../src/chat/context/ContextMeter.tsx";
import { type ContextUsageView, contextTone, formatTokens } from "../src/chat/context/types.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { sampleSettings } from "../src/screens/settings/sample-data.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const usage = (used: number, exact = true): ContextUsageView => ({
  used,
  limit: 200_000,
  compactAt: 160_000,
  exact,
  breakdown: {
    systemPrompt: 6_000,
    tools: 10_000,
    memory: 4_000,
    history: used - 21_000,
    currentMessage: 1_000,
  },
});

describe("context helpers", () => {
  it("formats token counts and tells how close compaction is", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(contextTone({ used: 100_000, compactAt: 160_000 })).toBe("ok");
    expect(contextTone({ used: 140_000, compactAt: 160_000 })).toBe("near");
    expect(contextTone({ used: 160_000, compactAt: 160_000 })).toBe("over");
  });
});

describe("ContextMeter", () => {
  it("names usage in words, opens the breakdown and compacts on request", async () => {
    const onCompact = vi.fn();
    render(
      <StoryWorld>
        <ContextMeter usage={usage(141_000, false)} onCompact={onCompact} />
      </StoryWorld>,
    );
    const trigger = screen.getByRole("button", {
      name: "Context: 141,000 of 200,000 tokens, 71%, estimate, near the compaction threshold",
    });
    await userEvent.click(trigger);
    const table = await screen.findByRole("table", { name: "Where the tokens go" });
    expect(within(table).getByRole("rowheader", { name: "Conversation so far" })).toBeTruthy();
    expect(within(table).getByText("120,000")).toBeTruthy();
    expect(screen.getByText(/An estimate until the provider counts it/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect(onCompact).toHaveBeenCalled();
  });
});

describe("CompactionMarker", () => {
  it("expands to the summary and offers what was replaced", async () => {
    const onShowReplaced = vi.fn();
    render(
      <StoryWorld>
        <CompactionMarker
          compaction={{
            id: "c1",
            tokensBefore: 48_200,
            tokensAfter: 3_100,
            replacedCount: 12,
            summaryMd: "The owner booked the dentist for Tuesday.",
            createdAt: FIXTURE_NOW,
          }}
          onShowReplaced={onShowReplaced}
        />
      </StoryWorld>,
    );
    const toggle = screen.getByRole("button", {
      name: "12 earlier messages were compacted, 48.2k → 3.1k tokens",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("The owner booked the dentist for Tuesday.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show what was replaced" }));
    expect(onShowReplaced).toHaveBeenCalled();
  });
});

describe("Settings → context and compaction", () => {
  it("saves values inside their bounds and explains the rest", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld
        edit={(w) => Object.assign(w.settings, sampleSettings())}
        onGateway={(g) => (gw = g)}
      >
        <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="model" />
      </StoryWorld>,
    );
    const compact = (await screen.findByLabelText("Compact at")) as HTMLInputElement;
    expect(compact.value).toBe("80");
    await userEvent.clear(compact);
    await userEvent.type(compact, "99{Enter}");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Enter a whole number from 50 to 95.",
    );
    const sets = () =>
      (gw as unknown as MockGateway).calls.filter(
        (c) =>
          c.method === "settings.set" && (c.params as { key: string }).key === "context.compactAt",
      );
    expect(sets()).toHaveLength(0);
    await userEvent.clear(compact);
    await userEvent.type(compact, "70{Enter}");
    await waitFor(() => expect(sets()[0]?.params).toMatchObject({ value: 0.7 }));
    const keep = screen.getByLabelText("Recent turns kept verbatim") as HTMLInputElement;
    expect(keep.value).toBe("6");
  });
});
