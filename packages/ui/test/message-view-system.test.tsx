import type { Block, LearnedFact, Message } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MessageView } from "../src/chat/MessageView.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

function setup(message: Message) {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  Object.assign((gateway as unknown as { handlers: Record<string, unknown> }).handlers, {
    "memory.forgetLearned": () => ({ removed: true }),
  });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <MessageView message={message} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return gateway;
}

const system = (blocks: Block[]): Message => ({
  id: "msg_system00001",
  seq: 1,
  threadId: "thr_main000001",
  role: "system",
  blocks,
  createdAt: FIXTURE_NOW,
  provenance: "agent",
  runId: null,
});

const fact: LearnedFact = {
  factId: "lf_sister00001",
  text: "Has a sister named Maya.",
  kind: "person",
  date: "2026-11-04",
  threadId: "thr_main000001",
};

describe("system messages", () => {
  it("shows a learned block as the quiet Learned line, with Undo", async () => {
    const gateway = setup(system([{ type: "learned", items: [fact] }]));
    expect(screen.getByTestId("learned")).toBeTruthy();
    expect(screen.getByText("Has a sister named Maya.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(gateway.calls.filter((c) => c.method === "memory.forgetLearned")).toHaveLength(1);
  });

  it("keeps text next to a learned block", () => {
    setup(
      system([
        { type: "text", md: "Noted." },
        { type: "learned", items: [fact] },
      ]),
    );
    expect(screen.getByText("Noted.")).toBeTruthy();
    expect(screen.getByTestId("learned")).toBeTruthy();
  });

  it("shows a taught line and a work note, so nothing the Gateway posts is dropped", () => {
    setup(
      system([
        {
          type: "taught",
          feedbackId: "fb_taught00001",
          lessonId: "les_a00000001",
          statement: "Keep replies short.",
          messageId: "msg_x00000001",
        },
        {
          type: "work_note",
          items: [
            {
              kind: "update",
              entityId: "ent_thesis00001",
              name: "Thesis draft",
              attribute: "stopped_at",
              value: "section 3",
              factId: "fact_update00001",
            },
          ],
        },
      ] as Block[]),
    );
    expect(screen.getByText("Keep replies short.")).toBeTruthy();
    expect(screen.getByTestId("work-note")).toBeTruthy();
  });
});
