import { type Message, PsycheError, type WorkNoteItem } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { MessageView } from "../src/chat/MessageView.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

type Handlers = Record<string, (params: never) => unknown>;

function setup(ui: ReactElement, handlers: Handlers = {}) {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  Object.assign((gateway as unknown as { handlers: Handlers }).handlers, handlers);
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        {ui}
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return gateway;
}

const note = (items: WorkNoteItem[]): Message => ({
  id: "msg_worknote0001",
  seq: 1,
  threadId: "thr_main000001",
  role: "system",
  blocks: [{ type: "work_note", items }],
  createdAt: FIXTURE_NOW,
  provenance: "agent",
  runId: null,
});

const proposal: WorkNoteItem = {
  kind: "proposal",
  entityId: "ent_thesis00001",
  name: "Thesis draft",
  attribute: "deadline",
  value: "2026-11-06T23:59:00.000Z",
  factId: "fact_proposal001",
};
const update: WorkNoteItem = {
  kind: "update",
  entityId: "ent_thesis00001",
  name: "Thesis draft",
  attribute: "stopped_at",
  value: "section 3",
  factId: "fact_update00001",
};

const callsOf = (gateway: MockGateway, method: string) =>
  gateway.calls.filter((c) => c.method === method);

describe("work note under a chat turn (MW7)", () => {
  it("says what Psyche noticed, and Confirm calls the Review decide method", async () => {
    const gateway = setup(<MessageView message={note([proposal])} />, {
      "memory.review.decide": () => ({ facts: [] }),
    });
    expect(screen.getByText(/Psyche noticed:/)).toBeTruthy();
    expect(screen.getByText(/Thesis draft, due Nov 6/)).toBeTruthy();
    // Showing the note changes nothing.
    expect(callsOf(gateway, "memory.review.decide")).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Confirm: Thesis draft" }));
    expect(callsOf(gateway, "memory.review.decide").map((c) => c.params)).toEqual([
      { factIds: ["fact_proposal001"], decision: "confirm" },
    ]);
    expect((await screen.findByRole("status")).textContent).toBe("Confirmed: Thesis draft.");
  });

  it("Discard calls the same method with discard", async () => {
    const gateway = setup(<MessageView message={note([proposal])} />, {
      "memory.review.decide": () => ({ facts: [] }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Discard: Thesis draft" }));
    expect(callsOf(gateway, "memory.review.decide").map((c) => c.params)).toEqual([
      { factIds: ["fact_proposal001"], decision: "discard" },
    ]);
    expect((await screen.findByRole("status")).textContent).toMatch(/^Discarded/);
  });

  it("a proposal Review already settled says so", async () => {
    setup(<MessageView message={note([proposal])} />, {
      "memory.review.decide": () => {
        throw new PsycheError("conflict", "that fact is not waiting for review");
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Confirm: Thesis draft" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "This was already handled in Review.",
    );
  });

  it("a proposal that is gone says it was handled, too", async () => {
    setup(<MessageView message={note([proposal])} />, {
      "memory.review.decide": () => {
        throw new PsycheError("not_found", "no such fact");
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Discard: Thesis draft" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "This was already handled in Review.",
    );
  });

  it("shows what an update replaced", () => {
    setup(<MessageView message={note([{ ...update, previous: "section 2" }])} />);
    expect(screen.getByText("(was: section 2)")).toBeTruthy();
  });

  it("an update says what changed and Undo calls memory.work.undoUpdate", async () => {
    const gateway = setup(<MessageView message={note([update])} />, {
      "memory.work.undoUpdate": () => ({ status: "undone" }),
    });
    expect(screen.getByText("Updated Thesis draft:")).toBeTruthy();
    expect(screen.getByText("stopped at section 3")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo the update to Thesis draft" }));
    expect(callsOf(gateway, "memory.work.undoUpdate").map((c) => c.params)).toEqual([
      { factId: "fact_update00001" },
    ]);
    expect((await screen.findByRole("status")).textContent).toMatch(/^Undone\./);
  });

  it("tells the owner when the field changed again", async () => {
    setup(<MessageView message={note([update])} />, {
      "memory.work.undoUpdate": () => ({ status: "changed_again" }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Undo the update to Thesis draft" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Thesis draft changed again since, so nothing was undone.",
    );
  });

  it("shows the Gateway's refusal when the connection may not write", async () => {
    setup(<MessageView message={note([proposal])} />, {
      "memory.review.decide": () => {
        throw new PsycheError("forbidden", "operator.write is required");
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Confirm: Thesis draft" }));
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
    expect(screen.getByRole("button", { name: "Confirm: Thesis draft" })).toBeTruthy();
  });
});
