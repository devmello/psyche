import type { Message } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { MemoryFileEditor, SoulMemoryPanel } from "../src/agent/SoulMemoryPanel.tsx";
import { UpcomingPanel } from "../src/agent/UpcomingPanel.tsx";
import { MessageView } from "../src/chat/MessageView.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS, LEARNING_IDS } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";
import { LessonMark } from "../src/teaching/LessonMark.tsx";
import { LearnedLine, TaughtLine } from "../src/teaching/TaughtLine.tsx";

const L = LEARNING_IDS.lessons;

function setup(ui: ReactElement) {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const utils = render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        {ui}
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway, store, ...utils };
}

function agentMessage(fields: Partial<Message> = {}): Message {
  const world = createFixtureWorld();
  const m = world.messages.find((x) => x.id === IDS.messages.mainAgent);
  if (m === undefined) throw new Error("fixture message missing");
  return { ...m, ...fields };
}

const callsOf = (gateway: MockGateway, method: string) =>
  gateway.calls.filter((c) => c.method === method);

describe("Feedback on agent messages (teaching loop §5.1)", () => {
  it("Helpful records feedback and never makes a lesson", async () => {
    const { gateway } = setup(<MessageView message={agentMessage()} />);
    const before = gateway.world.lessons.length;
    await userEvent.click(screen.getByRole("button", { name: "Helpful" }));
    await waitFor(() => expect(callsOf(gateway, "feedback.give")).toHaveLength(1));
    expect(callsOf(gateway, "feedback.give")[0]?.params).toMatchObject({ kind: "helpful" });
    expect(screen.getByRole("button", { name: "Helpful" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(gateway.world.lessons).toHaveLength(before);
  });

  it("Not like this teaches a lesson, then Undo forgets it", async () => {
    const { gateway } = setup(<MessageView message={agentMessage()} />);
    await userEvent.click(screen.getByRole("button", { name: "Not like this" }));
    const form = await screen.findByRole("form", { name: "Teach Psyche" });
    await userEvent.click(within(form).getByRole("button", { name: "Too long" }));
    await userEvent.type(
      within(form).getByRole("textbox", { name: "What should I do instead?" }),
      "Two lines at most.",
    );
    await userEvent.click(within(form).getByRole("button", { name: "Always" }));
    await userEvent.click(within(form).getByRole("button", { name: "Teach" }));
    expect(await screen.findByText("Two lines at most.")).toBeTruthy();
    expect(screen.getByText("Psyche will remember:")).toBeTruthy();
    expect(callsOf(gateway, "feedback.give")[0]?.params).toMatchObject({
      kind: "correction",
      reason: "too_long",
      scope: "always",
      text: "Two lines at most.",
    });
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undone. Psyche won't use it.")).toBeTruthy();
    expect(callsOf(gateway, "memory.lessons.forget")).toHaveLength(1);
  });

  it("Just this time redoes the answer with the instruction and makes no lesson", async () => {
    const { gateway } = setup(<MessageView message={agentMessage()} />);
    await userEvent.click(screen.getByRole("button", { name: "Not like this" }));
    const form = await screen.findByRole("form", { name: "Teach Psyche" });
    await userEvent.type(within(form).getByRole("textbox"), "Use the Lisbon dates.");
    await userEvent.click(within(form).getByRole("button", { name: "Just this time" }));
    await userEvent.click(within(form).getByRole("button", { name: "Teach" }));
    await waitFor(() => expect(callsOf(gateway, "chat.send")).toHaveLength(1));
    expect(callsOf(gateway, "chat.send")[0]?.params).toMatchObject({
      redo: { messageId: IDS.messages.mainAgent, instruction: "Use the Lisbon dates." },
    });
    expect(await screen.findByText("Thanks. Psyche noted it.")).toBeTruthy();
  });

  it("Used n lessons lists them and redoes without them", async () => {
    const message = agentMessage({
      lessonsApplied: [
        { lessonId: L.answerFirst, statement: "Keep replies short.", kind: "style" },
        { lessonId: L.janeShort, statement: "Replies to Jane are short.", kind: "style" },
      ],
    });
    const { gateway } = setup(<MessageView message={message} />);
    await userEvent.click(screen.getByRole("button", { name: "Used 2 lessons" }));
    expect(await screen.findByText("Replies to Jane are short.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Redo without lessons" }));
    await waitFor(() => expect(callsOf(gateway, "chat.send")).toHaveLength(1));
    expect(callsOf(gateway, "chat.send")[0]?.params).toMatchObject({
      redo: { messageId: message.id, withoutLessons: true },
    });
  });
});

describe("The taught and learned blocks", () => {
  it("a taught note changes its lesson's line", async () => {
    const { gateway } = setup(
      <TaughtLine
        feedbackId={LEARNING_IDS.feedback.janeTone}
        lessonId={L.janeShort}
        statement="Replies to Jane are short and start with the answer."
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    const box = await screen.findByRole("textbox", { name: "What Psyche will remember" });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toContain("Jane Ortiz"));
    await userEvent.clear(box);
    await userEvent.type(box, "- Jane: two lines.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(gateway.world.lessons.find((l) => l.id === L.janeShort)?.value).toBe(
        "- Jane: two lines.",
      ),
    );
  });

  it("a note without a lesson thanks the owner, and Undo deletes the feedback", async () => {
    const { gateway } = setup(
      <TaughtLine feedbackId={LEARNING_IDS.feedback.helpful} lessonId={null} statement={null} />,
    );
    expect(screen.getByText("Thanks. Psyche noted it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(callsOf(gateway, "feedback.delete")).toHaveLength(1));
  });

  it("a learned fact has Undo (#509)", async () => {
    const { gateway } = setup(
      <LearnedLine
        items={[
          {
            factId: "lf_maya001",
            text: "Has a sister named Maya.",
            kind: "person",
            date: "2026-10-25",
            threadId: IDS.threads.main,
          },
        ]}
      />,
    );
    expect(screen.getByText("Has a sister named Maya.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: 'Undo "Has a sister named Maya."' }));
    expect(await screen.findByText("Removed. Psyche won't keep it.")).toBeTruthy();
    expect(callsOf(gateway, "memory.forgetLearned")).toHaveLength(1);
  });
});

describe("Marks (teaching loop §5.2)", () => {
  it("the mark opens the lesson with its sources and change, and Keep confirms it", async () => {
    const world = createFixtureWorld();
    const lesson = world.lessons.find((l) => l.id === L.answerFirst);
    if (lesson === undefined) throw new Error("fixture lesson missing");
    const { gateway } = setup(<LessonMark lesson={lesson} />);
    const mark = screen.getByRole("button", { name: /Learned from you on .*refined 2 times/ });
    expect(mark.textContent).toContain("Refined 2 times");
    await userEvent.click(mark);
    const details = await screen.findByTestId("lesson-details");
    await waitFor(() => expect(within(details).getByText("Shorter. Answer first.")).toBeTruthy());
    expect(within(details).getByText("- Explain the reasoning, then the answer.")).toBeTruthy();
    await userEvent.click(within(details).getByRole("button", { name: "Keep" }));
    await waitFor(() =>
      expect(gateway.world.lessons.find((l) => l.id === L.answerFirst)?.status).toBe("confirmed"),
    );
  });

  it("Soul & Memory counts lessons per file", async () => {
    setup(<SoulMemoryPanel />);
    const row = await screen.findByRole("button", { name: "Open USER.md" });
    await waitFor(() => expect(row.textContent).toContain("1 lesson from you"));
  });

  it("Upcoming marks a parameter a lesson changed", async () => {
    setup(<UpcomingPanel now={Date.parse(FIXTURE_NOW)} />);
    expect(await screen.findByRole("button", { name: /Learned from you on/ })).toBeTruthy();
    expect(screen.getByText(/Changed from your feedback/)).toBeTruthy();
  });
});

describe("The editor slot's margin marks (teaching loop §5.2)", () => {
  it("passes each lesson-owned line as a mark, and a mark opens that lesson", async () => {
    const seen: { marks?: readonly { id: string; text: string; label: string }[] } = {};
    let activate: ((id: string) => void) | undefined;
    const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    render(
      <GatewayProvider client={gateway} store={store}>
        <UiSlotsProvider
          value={{
            renderEditor: (p) => {
              if (p.marks) seen.marks = p.marks;
              activate = p.onMarkActivate;
              return <textarea aria-label="slot editor" readOnly value={p.value} />;
            },
          }}
        >
          <MemoryFileEditor path="USER.md" budget={4000} />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    await waitFor(() => expect(seen.marks).toHaveLength(1));
    expect(seen.marks?.[0]).toMatchObject({
      id: L.janeShort,
      text: expect.stringContaining("Jane Ortiz"),
      label: expect.stringMatching(/^Learned from you on .*Show details$/),
    });
    act(() => activate?.(L.janeShort));
    expect(await screen.findByTestId("lesson-details")).toBeTruthy();
  });
});
