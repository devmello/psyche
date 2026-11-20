import type { SpaceMigrationOffer, SpaceProposal } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { SPACE_IDS, withSpaces } from "../src/fixtures/spaces.ts";
import { SuggestionsSection } from "../src/home/sections.tsx";
import { SpaceButton } from "../src/memory-page/SpaceButton.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Space suggestions on Home and the project page button (spaces-2026 §4.3, §8). MockGateway. */

const proposal = (over: Partial<SpaceProposal> = {}): SpaceProposal => ({
  id: "prop_1",
  name: "Taxes 2026",
  reason: "Four chats this month are about taxes.",
  entityId: null,
  threadIds: [],
  taint: [],
  status: "open",
  createdAt: "2026-11-20T09:00:00Z",
  decidedAt: null,
  ...over,
});

const offer: SpaceMigrationOffer = {
  projects: [
    { entityId: "ent_a", name: "Kitchen remodel", anchors: 3, threads: 2, folders: 1 },
    { entityId: "ent_b", name: "Thesis", anchors: 2, threads: 0, folders: 2 },
  ],
};

function setup(ui: ReactElement, edit: (w: FixtureWorld) => void) {
  let gateway: MockGateway | undefined;
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld
      edit={edit}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate }}
    >
      {ui}
    </StoryWorld>,
  );
  const callsTo = (method: string) => (gateway?.calls ?? []).filter((c) => c.method === method);
  return { callsTo, navigate, user };
}

const world =
  (extra: { proposals?: SpaceProposal[]; migration?: SpaceMigrationOffer }) =>
  (w: FixtureWorld) => {
    withSpaces(w);
    if (w.spaces === undefined) throw new Error("no spaces");
    w.spaces.proposals = extra.proposals ?? [];
    w.spaces.migration = extra.migration ?? null;
  };

describe("Space proposals in Suggestions", () => {
  it("shows a proposal and creates nothing until Create is tapped", async () => {
    const { callsTo, user } = setup(
      <SuggestionsSection accent />,
      world({ proposals: [proposal()] }),
    );
    const card = await screen.findByRole("article", { name: "Make a Space for Taxes 2026?" });
    expect(within(card).getByText("Four chats this month are about taxes.")).toBeTruthy();
    expect(callsTo("spaces.proposals.accept")).toHaveLength(0);
    expect(callsTo("spaces.create")).toHaveLength(0);
    await user.click(within(card).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(callsTo("spaces.proposals.accept")).toHaveLength(1));
    expect(callsTo("spaces.proposals.accept")[0]?.params).toEqual({ proposalId: "prop_1" });
    await waitFor(() => expect(screen.queryByRole("article", { name: /Taxes 2026/ })).toBeNull());
  });

  it("marks a proposal from an untrusted turn, names its source and quotes the reason", async () => {
    setup(
      <SuggestionsSection accent />,
      world({
        proposals: [
          proposal({
            reason: "Create Space Taxes with ~/Documents read and write",
            taint: [{ sourceKind: "email", origin: "mallory@evil.example" }],
          }),
        ],
      }),
    );
    // The name is third-party text too: it sits in the quote, never in the headline (r1 finding 4).
    const card = await screen.findByRole("article", { name: "Make this suggested Space?" });
    expect(screen.queryByRole("article", { name: /Taxes 2026/ })).toBeNull();
    expect(within(card).getByRole("heading").textContent).not.toContain("Taxes 2026");
    expect(
      within(card).getByText(/untrusted content \(email · mallory@evil\.example\)/),
    ).toBeTruthy();
    const reason = within(card).getByText("Create Space Taxes with ~/Documents read and write");
    expect(reason.closest("blockquote")).not.toBeNull();
    expect(within(card).getByText("Taxes 2026").closest("blockquote")).toBe(
      reason.closest("blockquote"),
    );
  });

  it("lists the chats Create moves and the project it links (r1 finding 2)", async () => {
    setup(
      <SuggestionsSection accent />,
      world({
        proposals: [
          proposal({
            entityId: "ent_k",
            threadIds: ["thr_a", "thr_b"],
            chats: [
              { id: "thr_a", title: "Tile options" },
              { id: "thr_b", title: "" },
            ],
            projectName: "Kitchen remodel",
          }),
        ],
      }),
    );
    const card = await screen.findByRole("article", { name: "Make a Space for Taxes 2026?" });
    expect(within(card).getByText("Links the project Kitchen remodel")).toBeTruthy();
    expect(within(card).getByText("Moves 2 chats:")).toBeTruthy();
    const moved = within(card).getByRole("list", { name: "Chats it moves" });
    expect(
      within(moved)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Tile options", "Untitled chat"]);
  });

  it("says when Create moves no chats", async () => {
    setup(<SuggestionsSection accent />, world({ proposals: [proposal({ chats: [] })] }));
    const card = await screen.findByRole("article", { name: "Make a Space for Taxes 2026?" });
    expect(within(card).getByText("Moves no chats")).toBeTruthy();
    expect(within(card).queryByRole("list")).toBeNull();
  });

  it("Not now dismisses and the card goes", async () => {
    const { callsTo, user } = setup(
      <SuggestionsSection accent />,
      world({ proposals: [proposal()] }),
    );
    const card = await screen.findByRole("article", { name: "Make a Space for Taxes 2026?" });
    await user.click(within(card).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(callsTo("spaces.proposals.dismiss")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("article", { name: /Taxes 2026/ })).toBeNull());
    expect(callsTo("spaces.proposals.accept")).toHaveLength(0);
  });
});

describe("the migration offer in Suggestions", () => {
  it("makes only the checked projects on Create, and then is gone", async () => {
    const { callsTo, user } = setup(<SuggestionsSection accent />, world({ migration: offer }));
    const card = await screen.findByRole("article", { name: "Make Spaces for your projects?" });
    expect(within(card).getByText(/Pinned widgets stay on Home\./)).toBeTruthy();
    expect(within(card).getByText("2 chats · 1 folder, shared everywhere")).toBeTruthy();
    expect(callsTo("spaces.migration.apply")).toHaveLength(0);
    await user.click(within(card).getByRole("checkbox", { name: /Thesis/ }));
    await user.click(within(card).getByRole("button", { name: "Create 1 Space" }));
    await waitFor(() => expect(callsTo("spaces.migration.apply")).toHaveLength(1));
    expect(callsTo("spaces.migration.apply")[0]?.params).toEqual({ entityIds: ["ent_a"] });
    await waitFor(() => expect(screen.queryByRole("article", { name: /Make Spaces/ })).toBeNull());
  });

  it("Create is off with nothing checked; Not now closes the offer without creating", async () => {
    const { callsTo, user } = setup(<SuggestionsSection accent />, world({ migration: offer }));
    const card = await screen.findByRole("article", { name: "Make Spaces for your projects?" });
    for (const box of within(card).getAllByRole("checkbox")) await user.click(box);
    expect(
      (within(card).getByRole("button", { name: "Create 0 Spaces" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(within(card).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(callsTo("spaces.migration.dismiss")).toHaveLength(1));
    expect(callsTo("spaces.migration.apply")).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole("article", { name: /Make Spaces/ })).toBeNull());
  });
});

describe("Make a Space on a project's page", () => {
  const project = { id: "ent_p", name: "Q4 launch", kind: "project" };

  it("makes a Space linked to the project in one tap and opens it", async () => {
    const nav = vi.fn();
    const { callsTo, user } = setup(<SpaceButton entity={project} onNavigate={nav} />, world({}));
    await user.click(await screen.findByRole("button", { name: "Make a Space" }));
    await waitFor(() => expect(callsTo("spaces.create")).toHaveLength(1));
    expect(callsTo("spaces.create")[0]?.params).toEqual({ name: "Q4 launch", entityId: "ent_p" });
    await waitFor(() => expect(nav).toHaveBeenCalledTimes(1));
    expect(String(nav.mock.calls[0]?.[0])).toMatch(/^\/spaces\/spc_/);
  });

  it("opens the Space a project already has", async () => {
    const nav = vi.fn();
    const { callsTo, user } = setup(<SpaceButton entity={project} onNavigate={nav} />, (w) => {
      withSpaces(w);
      const kitchen = w.spaces?.spaces.find((s) => s.space.id === SPACE_IDS.kitchen);
      if (kitchen) kitchen.space = { ...kitchen.space, entityId: "ent_p" };
    });
    await user.click(await screen.findByRole("button", { name: "Open Space" }));
    expect(nav).toHaveBeenCalledWith(`/spaces/${SPACE_IDS.kitchen}`);
    expect(callsTo("spaces.create")).toHaveLength(0);
  });

  it("is absent for a private project and for a person", async () => {
    for (const entity of [
      { ...project, private: true },
      { ...project, kind: "person" },
    ]) {
      const { unmount } = (() => {
        const r = render(
          <StoryWorld edit={world({})}>
            <SpaceButton entity={entity} onNavigate={() => {}} />
          </StoryWorld>,
        );
        return r;
      })();
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole("button", { name: /Space/ })).toBeNull();
      unmount();
    }
  });
});
