import type { FeedbackEvent } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";
import { FeedbackList } from "../src/teaching/FeedbackList.tsx";

/** Twenty-five events, newest first: "Thumbs up on a reply" at the top, one a minute older each. */
function manyEvents(): FeedbackEvent[] {
  const base = Date.parse(FIXTURE_NOW);
  return Array.from({ length: 25 }, (_, i) => ({
    id: `fb_${String(i).padStart(2, "0")}`,
    kind: i % 2 === 0 ? "helpful" : "not_helpful",
    target: { type: "message", id: `msg_${i}` },
    text: null,
    reason: null,
    scope: null,
    detail: null,
    surface: "desktop",
    lessonId: null,
    createdAt: new Date(base - i * 60_000).toISOString(),
  })) as FeedbackEvent[];
}

function setup() {
  const world = createFixtureWorld();
  world.feedbackEvents = manyEvents();
  const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const utils = render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <FeedbackList />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway, ...utils };
}

const callsOf = (gateway: MockGateway, method: string) =>
  gateway.calls.filter((c) => c.method === method);

describe("Feedback you gave (teaching loop §5.3)", () => {
  it("lists the newest feedback first with kind and target in plain words", async () => {
    setup();
    const list = await screen.findByTestId("feedback-list");
    const rows = within(list).getAllByTestId("feedback-row");
    expect(rows).toHaveLength(20);
    expect(rows[0]?.textContent).toContain("Thumbs up · Reply");
    expect(rows[1]?.textContent).toContain("Thumbs down · Reply");
  });

  it("pages older feedback with nextCursor until none is left", async () => {
    const { gateway } = setup();
    const list = await screen.findByTestId("feedback-list");
    await userEvent.click(within(list).getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(within(list).getAllByTestId("feedback-row")).toHaveLength(25));
    expect(callsOf(gateway, "feedback.list").map((c) => c.params)).toEqual([
      { limit: 20 },
      { cursor: "20", limit: 20 },
    ]);
    expect(within(list).queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("deletes one row after a confirm that says lessons made only from it are forgotten", async () => {
    const { gateway } = setup();
    const list = await screen.findByTestId("feedback-list");
    const rows = within(list).getAllByTestId("feedback-row");
    expect(rows).toHaveLength(20);
    await userEvent.click(
      within(list).getAllByRole("button", { name: /^Delete feedback from/ })[0]!,
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Lessons made only from this feedback will be forgotten");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(callsOf(gateway, "feedback.delete").map((c) => c.params)).toEqual([
        { eventId: "fb_00" },
      ]),
    );
    // The newest row is gone; the next one is now first.
    await waitFor(() =>
      expect(within(list).getAllByTestId("feedback-row")[0]?.textContent).toContain(
        "Thumbs down · Reply",
      ),
    );
  });

  it("shows a failed delete inline instead of swallowing it", async () => {
    const { gateway } = setup();
    const list = await screen.findByTestId("feedback-list");
    gateway.failNext("feedback.delete", "not_found", "feedback event fb_00 not found");
    await userEvent.click(
      within(list).getAllByRole("button", { name: /^Delete feedback from/ })[0]!,
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    // The confirm dialog hides the page from the a11y tree while it closes, so look up the text.
    expect(await screen.findByText(/Couldn't delete this feedback/)).toBeTruthy();
    expect(within(list).getAllByTestId("feedback-row")).toHaveLength(20);
  });
});
