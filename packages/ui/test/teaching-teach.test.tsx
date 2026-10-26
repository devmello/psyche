import type { RunStep } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/chat/commands.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StepFeedback } from "../src/teaching/StepFeedback.tsx";

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
  return { gateway, ...utils };
}

const callsOf = (gateway: MockGateway, method: string) =>
  gateway.calls.filter((c) => c.method === method);

describe("/teach (teaching loop §5.1)", () => {
  it("parses with a required correction", () => {
    expect(parseCommand("/teach Shorter please")).toEqual({
      type: "command",
      name: "teach",
      arg: "Shorter please",
    });
    expect(parseCommand("/teach").type).toBe("error");
  });

  it("corrects the last reply and says what Psyche will remember", async () => {
    const { gateway } = setup(
      <ChatThread threadId={IDS.threads.main} now={Date.parse(FIXTURE_NOW)} />,
    );
    const box = await screen.findByRole("textbox", { name: "Message Wren" });
    await waitFor(() => expect(callsOf(gateway, "chat.history").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByRole("article").length).toBeGreaterThan(0));
    await userEvent.type(box, "/teach Answer first, then why.{Enter}");
    expect(await screen.findByText("Psyche will remember: Answer first, then why.")).toBeTruthy();
    const [give] = callsOf(gateway, "feedback.give");
    expect(give?.params).toMatchObject({
      kind: "correction",
      text: "Answer first, then why.",
      target: { type: "message", threadId: IDS.threads.main },
    });
    expect(callsOf(gateway, "chat.send")).toHaveLength(0);
  });
});

describe("Not like this on a step", () => {
  const step: RunStep = {
    id: "step_1",
    runId: "run_1",
    seq: 1,
    kind: "tool",
    status: "ok",
    label: "Searched the web",
    startedAt: FIXTURE_NOW,
    endedAt: FIXTURE_NOW,
    toolCallId: "tc_web_receipt",
    attempt: 1,
  } as RunStep;

  it("offers the step's reasons and records feedback on its tool call", async () => {
    const { gateway } = setup(<StepFeedback step={step} />);
    await userEvent.click(screen.getByRole("button", { name: "Not like this: Searched the web" }));
    const form = await screen.findByRole("form", { name: "Teach Psyche" });
    expect(within(form).queryByRole("button", { name: "Too long" })).toBeNull();
    await userEvent.click(within(form).getByRole("button", { name: "Should have asked first" }));
    await userEvent.click(within(form).getByRole("button", { name: "Teach" }));
    await waitFor(() => expect(callsOf(gateway, "feedback.give")).toHaveLength(1));
    expect(callsOf(gateway, "feedback.give")[0]?.params).toMatchObject({
      target: { type: "tool_call", id: "tc_web_receipt" },
      kind: "not_helpful",
      reason: "should_have_asked",
    });
  });

  it("is not offered on thinking steps", () => {
    setup(<StepFeedback step={{ ...step, kind: "thinking" }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
