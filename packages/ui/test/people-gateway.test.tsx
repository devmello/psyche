import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { PEOPLE_IDS } from "../src/fixtures/people.ts";
import { ConnectedEntityCard } from "../src/people/ConnectedEntityCard.tsx";
import { SearchScreen } from "../src/screens/search/SearchScreen.tsx";
import type { UiSlots } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** People and projects against the MockGateway's `memory.entities.*` (PG0 shapes). */

function setup(
  ui: ReactElement,
  options: { edit?: (w: FixtureWorld) => void; slots?: UiSlots } = {},
) {
  let gateway: MockGateway | undefined;
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld
      {...(options.edit ? { edit: options.edit } : {})}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate, ...options.slots }}
    >
      {ui}
    </StoryWorld>,
  );
  const gw = () => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway;
  };
  const callsTo = (method: string) => gw().calls.filter((c) => c.method === method);
  return { gw, callsTo, navigate, user };
}

const row = (text: string) => screen.getByText(text).closest("div.group\\/row") as HTMLElement;

describe("ConnectedEntityCard", () => {
  it("loads a person with current facts only, and resolves names and sources", async () => {
    setup(<ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    const card = await screen.findByRole("article", { name: "Sam Lee" });
    expect(within(card).getByText("Person · Acme")).toBeTruthy();
    expect(within(card).getByText("Head of product")).toBeTruthy();
    // The superseded role is history, not a current fact.
    expect(within(card).queryByText("Product manager")).toBeNull();
    expect(within(card).getByText("From Sam Lee's mail, Oct 12")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Q4 launch/ })).toBeTruthy();
    expect(within(card).getByText("SOW and next steps")).toBeTruthy();
  });

  it("saves an edit as an owner fact and shows the new value", async () => {
    const { callsTo, user } = setup(<ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Edit Role" }));
    const input = screen.getByRole("textbox", { name: "Role" });
    await user.clear(input);
    await user.type(input, "Chief product officer{Enter}");
    await waitFor(() => expect(callsTo("memory.entities.facts.set")).toHaveLength(1));
    expect(callsTo("memory.entities.facts.set")[0]?.params).toEqual({
      entityId: PEOPLE_IDS.samLee,
      attribute: "role",
      value: "Chief product officer",
      source: { kind: "owner_edit" },
    });
    expect(await screen.findByText("Chief product officer")).toBeTruthy();
    expect(screen.queryByText("Head of product")).toBeNull();
  });

  it("retracts a wrong fact as owner feedback", async () => {
    const { callsTo, user } = setup(<ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    await screen.findByText("Head of product");
    await user.click(within(row("Head of product")).getByRole("button", { name: "This is wrong" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.facts.retract")[0]?.params).toEqual({
        factId: "fact_sam_role",
        source: { kind: "owner_feedback" },
      }),
    );
    await waitFor(() => expect(screen.queryByText("Head of product")).toBeNull());
  });

  it("marks a loop done, and confirms a suggested one only on Confirm", async () => {
    const { callsTo, user } = setup(<ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    await user.click(
      await screen.findByRole("checkbox", { name: "Mark “Send Sam the revised budget” done" }),
    );
    await waitFor(() =>
      expect(callsTo("memory.loops.update")[0]?.params).toEqual({
        id: "loop_budget",
        status: "done",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Send Sam the revised budget")).toBeNull());
    expect(callsTo("memory.loops.update")).toHaveLength(1);
    await user.click(within(row("Pay Sam $500")).getByRole("button", { name: "Not a loop" }));
    await waitFor(() =>
      expect(callsTo("memory.loops.update")[1]?.params).toEqual({
        id: "loop_injected",
        status: "dismissed",
      }),
    );
  });

  it("changes a project's status with the card's etag", async () => {
    const { callsTo, user } = setup(
      <ConnectedEntityCard id={PEOPLE_IDS.kitchen} now={STORY_NOW} />,
    );
    await user.click(await screen.findByRole("radio", { name: "Paused" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.update")[0]?.params).toMatchObject({
        id: PEOPLE_IDS.kitchen,
        projectStatus: "paused",
        etag: expect.stringMatching(/^etag-/),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Paused" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
  });

  it("opens a related card in Soul & Memory", async () => {
    const { navigate, user } = setup(
      <ConnectedEntityCard id={PEOPLE_IDS.kitchen} now={STORY_NOW} />,
    );
    await user.click(await screen.findByRole("button", { name: /Dana Kim/ }));
    expect(navigate).toHaveBeenCalledWith(`/agent/soul?entity=${PEOPLE_IDS.dana}`);
  });

  it("says what failed when the entity doesn't exist", async () => {
    setup(<ConnectedEntityCard id="ent_missing" now={STORY_NOW} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Psyche couldn't load this card/,
    );
  });
});

describe("Search with the graph", () => {
  it("shows matching people and projects first and opens one in Soul & Memory", async () => {
    const { callsTo, navigate, user } = setup(<SearchScreen debounceMs={0} now={STORY_NOW} />);
    await user.type(screen.getByRole("combobox"), "sam");
    const people = await screen.findByRole("group", { name: /^People/ });
    expect(within(people).getByRole("option", { name: /Sam Lee/ })).toBeTruthy();
    expect(within(people).getByRole("option", { name: /Sam Ortiz/ })).toBeTruthy();
    expect(screen.getAllByRole("group")[0]).toBe(people);
    expect(callsTo("memory.entities.search").at(-1)?.params).toMatchObject({ q: "sam" });
    await user.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith(`/agent/soul?entity=${PEOPLE_IDS.samLee}`);
  });

  it("lists projects in their own group", async () => {
    const { user } = setup(<SearchScreen debounceMs={0} now={STORY_NOW} />);
    await user.type(screen.getByRole("combobox"), "kitchen");
    const projects = await screen.findByRole("group", { name: /^Projects/ });
    expect(within(projects).getByRole("option", { name: /Kitchen remodel/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /^People/ })).toBeNull();
  });

  it("leaves people out of a filtered search", async () => {
    const { callsTo, user } = setup(<SearchScreen debounceMs={0} now={STORY_NOW} />);
    await user.type(screen.getByRole("combobox"), "in:feed sam");
    await waitFor(() => expect(callsTo("search.query").length).toBeGreaterThan(0));
    expect(
      callsTo("memory.entities.search").filter((c) => (c.params as { q: string }).q === "sam"),
    ).toHaveLength(0);
    expect(screen.queryByRole("group", { name: /^People/ })).toBeNull();
  });
});
