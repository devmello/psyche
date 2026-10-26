import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ReceiptLine } from "../src/blocks/Receipt.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { ReceiptFeedback, receiptTarget } from "../src/teaching/ReceiptFeedback.tsx";

describe("Not like this on receipts (teaching loop §5.1)", () => {
  const world = createFixtureWorld();
  const receipt = world.receipts.find((r) => r.toolCallId);
  if (receipt === undefined) throw new Error("no fixture receipt with a tool call");

  it("targets the tool call, else the approval, else offers nothing", () => {
    expect(receiptTarget(receipt)).toEqual({ type: "tool_call", id: receipt.toolCallId });
    expect(receiptTarget({ ...receipt, toolCallId: null, approvalId: "ap_1" })).toEqual({
      type: "approval",
      id: "ap_1",
    });
    expect(receiptTarget({ ...receipt, toolCallId: null, approvalId: null })).toBeNull();
  });

  it("opens the Teach form from the line's menu and records feedback", async () => {
    const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    render(
      <GatewayProvider client={gateway} store={store}>
        <ReceiptLine receipt={receipt} menu={<ReceiptFeedback receipt={receipt} />} />
      </GatewayProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: `More for ${receipt.summary}` }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Not like this" }));
    const form = await screen.findByRole("form", { name: "Teach Psyche" });
    await userEvent.click(within(form).getByRole("button", { name: "Didn't do what I asked" }));
    await userEvent.type(within(form).getByRole("textbox"), "Use the work address.");
    await userEvent.click(within(form).getByRole("button", { name: "Teach" }));
    await waitFor(() =>
      expect(gateway.calls.filter((c) => c.method === "feedback.give")).toHaveLength(1),
    );
    expect(gateway.calls.find((c) => c.method === "feedback.give")?.params).toMatchObject({
      target: { type: "tool_call", id: receipt.toolCallId },
      kind: "correction",
      reason: "not_what_i_asked",
      text: "Use the work address.",
    });
    expect(await screen.findByText("Psyche will remember:")).toBeTruthy();
  });
});
