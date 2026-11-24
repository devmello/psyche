import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { PEOPLE_IDS } from "../src/fixtures/people.ts";
import { ConnectedEntityCard } from "../src/people/ConnectedEntityCard.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** A fact's History on the person card: lazy `memory.entities.history`, newest first, current marked. */

function setup(ui: ReactElement, options: { edit?: (w: FixtureWorld) => void } = {}) {
  let gateway: MockGateway | undefined;
  const user = userEvent.setup();
  render(
    <StoryWorld
      {...(options.edit ? { edit: options.edit } : {})}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate: vi.fn() }}
    >
      {ui}
    </StoryWorld>,
  );
  const gw = () => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway;
  };
  const historyCalls = () => gw().calls.filter((c) => c.method === "memory.entities.history");
  return { gw, historyCalls, user };
}

/** The fact row that shows `text`, found by its group class. */
const row = (text: string) => screen.getByText(text).closest("div.group\\/row") as HTMLElement;

describe("fact History", () => {
  it("does not load history on card load", async () => {
    const { historyCalls } = setup(<ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    await screen.findByRole("article", { name: "Sam Lee" });
    expect(historyCalls()).toHaveLength(0);
  });

  it("loads one fact's versions when opened: the current value marked current, then earlier values", async () => {
    const { historyCalls, user } = setup(
      <ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />,
    );
    await screen.findByRole("article", { name: "Sam Lee" });
    await user.click(within(row("Head of product")).getByRole("button", { name: /^History of/ }));

    const list = await screen.findByRole("list", { name: /^Earlier values of/ });
    expect(historyCalls()).toHaveLength(1);
    expect(historyCalls()[0]?.params).toEqual({ entityId: PEOPLE_IDS.samLee, attribute: "role" });

    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Head of product");
    expect(items[0]?.textContent).toContain("Current");
    expect(within(list).getByText("Product manager")).toBeTruthy();
    expect(items[1]?.textContent).not.toContain("Current");
  });

  it("shows the quiet empty line when the fact was never changed", async () => {
    const { user } = setup(<ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    await screen.findByRole("article", { name: "Sam Lee" });
    await user.click(within(row("Email over calls")).getByRole("button", { name: /^History of/ }));
    expect(await screen.findByText("No earlier values.")).toBeTruthy();
  });

  it("shows an error with a retry that loads again", async () => {
    const { gw, historyCalls, user } = setup(
      <ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />,
    );
    await screen.findByRole("article", { name: "Sam Lee" });
    gw().failNext("memory.entities.history", "unavailable", "history is down");
    await user.click(within(row("Head of product")).getByRole("button", { name: /^History of/ }));

    const retry = await screen.findByRole("button", { name: "Try again" });
    await user.click(retry);
    await waitFor(() => expect(historyCalls()).toHaveLength(2));
    expect(await screen.findByText("Product manager")).toBeTruthy();
  });
});
