import { PsycheError, type WorkHistoryEntry } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { ConnectedWorkHistory } from "../src/memory-page/WorkHistory.tsx";

type Handlers = Record<string, (params: never) => unknown>;

const entry = (over: Partial<WorkHistoryEntry>): WorkHistoryEntry => ({
  factId: "fact_a0000001",
  attribute: "stopped_at",
  value: "section 3",
  from: null,
  at: FIXTURE_NOW,
  origin: "chat",
  chip: null,
  undoable: false,
  ...over,
});

const chatUpdate = entry({ factId: "fact_chat00001", undoable: true, from: "section 2" });
const mailDeadline = entry({
  factId: "fact_mail00001",
  attribute: "deadline",
  value: "2026-11-06T23:59:00.000Z",
  origin: "mail",
  chip: { source: "mail", label: "Prof. Rao" },
});
const nightlyStatus = entry({
  factId: "fact_night0001",
  attribute: "status",
  value: "done",
  origin: "nightly",
  chip: { source: "files", label: "thesis.tex" },
});
const youNext = entry({
  factId: "fact_you000001",
  attribute: "next_step",
  value: "email Rao",
  origin: "you",
});

function setup(entries: WorkHistoryEntry[], handlers: Handlers = {}) {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  Object.assign((gateway as unknown as { handlers: Handlers }).handlers, {
    "memory.work.history": () => ({ entries }),
    ...handlers,
  });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gateway} store={store}>
      <ConnectedWorkHistory
        entityId="ent_thesis00001"
        name="Thesis draft"
        now={Date.parse(FIXTURE_NOW)}
      />
    </GatewayProvider>,
  );
  return gateway;
}

const callsOf = (gateway: MockGateway, method: string) =>
  gateway.calls.filter((c) => c.method === method);

describe("work item History", () => {
  it("lists the changes with where they came from and a source chip", async () => {
    setup([chatUpdate, mailDeadline, nightlyStatus, youNext]);
    const rows = await screen.findAllByTestId("history-row");
    expect(rows).toHaveLength(4);
    const row = (i: number) => within(rows[i] as HTMLElement);
    expect(row(0).getByText(/Stopped at section 3/)).toBeTruthy();
    expect(row(0).getByText("(was: section 2)")).toBeTruthy();
    expect(row(0).getByTestId("history-origin").textContent).toBe("Chat");
    expect(row(1).getByText("Due Nov 6")).toBeTruthy();
    expect(row(1).getByTestId("history-chip").textContent).toBe("Mail · Prof. Rao");
    expect(row(2).getByText("Marked Done")).toBeTruthy();
    expect(row(2).getByTestId("history-origin").textContent).toBe("Nightly");
    expect(row(2).getByTestId("history-chip").textContent).toBe("Files · thesis.tex");
    expect(row(3).getByText("Next step: email Rao")).toBeTruthy();
    expect(row(3).queryByTestId("history-chip")).toBeNull();
  });

  it("says so when nothing has changed", async () => {
    setup([]);
    expect(await screen.findByText("No changes yet.")).toBeTruthy();
  });

  it("offers Undo only on the eligible entry, and it calls memory.work.undoUpdate", async () => {
    const gateway = setup([chatUpdate, mailDeadline, youNext], {
      "memory.work.undoUpdate": () => ({ status: "undone" }),
    });
    await screen.findAllByTestId("history-row");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Undo: Stopped at section 3" }));
    expect(callsOf(gateway, "memory.work.undoUpdate").map((c) => c.params)).toEqual([
      { factId: "fact_chat00001" },
    ]);
    expect((await screen.findByRole("status")).textContent).toBe(
      "Undone. Thesis draft is back as it was.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("handles changed_again without touching anything", async () => {
    setup([chatUpdate], { "memory.work.undoUpdate": () => ({ status: "changed_again" }) });
    await userEvent.click(await screen.findByRole("button", { name: /^Undo:/ }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Thesis draft changed again since, so nothing was undone.",
    );
  });

  it("handles already_undone", async () => {
    setup([chatUpdate], { "memory.work.undoUpdate": () => ({ status: "already_undone" }) });
    await userEvent.click(await screen.findByRole("button", { name: /^Undo:/ }));
    expect((await screen.findByRole("status")).textContent).toBe("Already undone.");
  });

  it("shows the Gateway's refusal inline for a read-only window", async () => {
    setup([chatUpdate], {
      "memory.work.undoUpdate": () => {
        throw new PsycheError("forbidden", "this connection cannot write");
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: /^Undo:/ }));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Undo:/ })).toBeTruthy();
  });
});
