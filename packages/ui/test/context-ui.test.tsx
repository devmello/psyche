import type { ContextUsage, Message } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompactionMarker } from "../src/chat/context/CompactionMarker.tsx";
import { ContextMeter } from "../src/chat/context/ContextMeter.tsx";
import { parseLimitDrafts, ThreadContextMeter } from "../src/chat/context/connected.tsx";
import { type ContextUsageView, contextTone, formatTokens } from "../src/chat/context/types.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { sampleSettings } from "../src/screens/settings/sample-data.ts";
import { ThreadList } from "../src/shell/ThreadList.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const usage = (used: number, exact = true): ContextUsageView => ({
  used,
  limit: 200_000,
  compactAt: 160_000,
  exact,
  breakdown: {
    system: 6_000,
    tools: 10_000,
    context: 4_000,
    history: used - 21_000,
    current: 1_000,
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
            trigger: "auto",
            tokensBefore: 48_200,
            tokensAfter: 3_100,
            replacedTurns: 12,
            summary: {
              facts: ["The owner booked the dentist for Tuesday."],
              decisions: [],
              openTasks: ["Confirm the insurance form."],
              pinnedInstructions: [],
            },
            createdAt: FIXTURE_NOW,
          }}
          onShowReplaced={onShowReplaced}
        />
      </StoryWorld>,
    );
    const toggle = screen.getByRole("button", {
      name: "12 earlier turns were compacted, 48.2k → 3.1k tokens",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("The owner booked the dentist for Tuesday.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Open tasks" }).textContent).toBe(
      "Confirm the insurance form.",
    );
    // Empty sections are left out.
    expect(screen.queryByRole("list", { name: "Decisions" })).toBeNull();
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
      "Enter a whole number from 20 to 95.",
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
    expect(keep.value).toBe("4");
  });
});

const protocolUsage = (threadId: string, promptTokens: number): ContextUsage => ({
  threadId,
  runId: "run_ctx",
  model: "anthropic/claude-sonnet-5-5",
  at: FIXTURE_NOW,
  promptTokens,
  estimated: false,
  breakdown: {
    system: 6_000,
    tools: 10_000,
    context: 4_000,
    history: promptTokens - 21_000,
    current: 1_000,
  },
  peakTokens: promptTokens,
  limits: {
    maxTokens: 200_000,
    compactAt: 0.8,
    keepRecentTurns: 4,
    contextWindow: 200_000,
    maxTokensFrom: "model",
  },
  compactions: 0,
});

describe("Connected context UI", () => {
  it("reads the meter from threads.contextUsage, follows thread.context.updated and compacts", async () => {
    let gw: MockGateway | null = null;
    const threadId = IDS.threads.dentist;
    render(
      <StoryWorld
        edit={(w) => {
          w.contextUsage = { [threadId]: protocolUsage(threadId, 50_000) };
        }}
        onGateway={(g) => (gw = g)}
      >
        <ThreadContextMeter threadId={threadId} />
      </StoryWorld>,
    );
    expect(
      await screen.findByRole("button", { name: "Context: 50,000 of 200,000 tokens, 25%" }),
    ).toBeTruthy();
    const g = gw as unknown as MockGateway;
    act(() => g.reportContextUsage(protocolUsage(threadId, 150_000)));
    const trigger = await screen.findByRole("button", {
      name: "Context: 150,000 of 200,000 tokens, 75%, near the compaction threshold",
    });
    await userEvent.click(trigger);
    expect(await screen.findByText(/The limit is the model's context window/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Compact now" }));
    await waitFor(() => expect(g.calls.some((c) => c.method === "threads.compact")).toBe(true));
    // The dentist thread has a run going: the Gateway refuses with conflict.
    expect(await screen.findByText(/Can't compact while the agent is working/)).toBeTruthy();
  });

  it("sets this chat's own limits from the thread menu and refuses values over the window", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld onGateway={(g) => (gw = g)}>
        <ThreadList activeThreadId={null} onOpen={() => {}} now={STORY_NOW} />
      </StoryWorld>,
    );
    await screen.findAllByTestId("thread-row");
    const main = document.querySelector<HTMLElement>('li[data-thread-kind="main"]');
    if (!main) throw new Error("no main chat row");
    await userEvent.click(within(main).getByRole("button", { name: /More for/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Context limits…" }));
    const dialog = await screen.findByRole("dialog", { name: "Context limits for this chat" });
    const limit = within(dialog).getByLabelText("Context limit") as HTMLInputElement;
    await waitFor(() => expect(limit.placeholder).toBe("200000"));
    await userEvent.type(limit, "300000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      within(dialog).getByText(/Enter a whole number from 1,000 to 200,000 \(the model's window\)/),
    ).toBeTruthy();
    const g = gw as unknown as MockGateway;
    expect(g.calls.some((c) => c.method === "threads.setContextLimits")).toBe(false);
    await userEvent.clear(limit);
    await userEvent.type(limit, "64000");
    await userEvent.type(within(dialog).getByLabelText("Compact at"), "70");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(g.calls.find((c) => c.method === "threads.setContextLimits")?.params).toEqual({
        threadId: IDS.threads.main,
        limits: { maxTokens: 64_000, compactAt: 0.7 },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a compaction message as a marker with the turns it replaced", async () => {
    const threadId = IDS.threads.dentist;
    render(
      <StoryWorld
        edit={(w) => {
          const turns = w.messages
            .filter((m) => m.threadId === threadId && m.role !== "system")
            .sort((a, b) => a.seq - b.seq);
          const first = turns[0] as Message;
          const second = turns[1] as Message;
          const last = Math.max(
            ...w.messages.filter((m) => m.threadId === threadId).map((m) => m.seq),
          );
          w.messages.push({
            ...first,
            id: "msg_compaction",
            seq: last + 1,
            role: "system",
            provenance: "system",
            runId: null,
            blocks: [
              {
                type: "compaction",
                compactionId: "cmp_1",
                trigger: "auto",
                summary: {
                  facts: ["The owner needs a dentist."],
                  decisions: [],
                  openTasks: [],
                  pinnedInstructions: [],
                },
                replaced: { turns: 1, fromMessageId: first.id, toMessageId: second.id },
                tokensBefore: 9_000,
                tokensAfter: 700,
              },
            ],
          });
        }}
      >
        <ChatThread threadId={threadId} now={STORY_NOW} />
      </StoryWorld>,
    );
    const toggle = await screen.findByRole("button", {
      name: "An earlier turn was compacted, 9k → 700 tokens",
    });
    await userEvent.click(toggle);
    expect(screen.getByText("The owner needs a dentist.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show what was replaced" }));
    const replaced = await screen.findByRole("list", { name: "Replaced turns" });
    expect(within(replaced).getAllByRole("listitem")).toHaveLength(2);
    expect(within(replaced).getByText("You:", { exact: false })).toBeTruthy();
  });
});

describe("parseLimitDrafts", () => {
  it("leaves blank fields to Settings and checks the rest against the bounds", () => {
    expect(
      parseLimitDrafts({ maxTokens: "", compactAt: "", keepRecentTurns: "" }, 200_000),
    ).toEqual({ limits: {}, errors: {} });
    const r = parseLimitDrafts(
      { maxTokens: "500", compactAt: "96", keepRecentTurns: "3" },
      200_000,
    );
    expect(r.limits).toEqual({ keepRecentTurns: 3 });
    expect(Object.keys(r.errors).sort()).toEqual(["compactAt", "maxTokens"]);
  });
});
