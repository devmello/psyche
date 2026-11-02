import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { ConnectedEntityCard } from "../src/people/ConnectedEntityCard.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

let gateway: MockGateway;

function show(upcoming: boolean) {
  return render(
    <StoryWorld
      edit={(w) => {
        const sam = w.graph.entities.find((e) => e.kind === "person" && !e.isOwner);
        if (upcoming && sam)
          w.review = {
            items: [],
            quarantine: [],
            runs: [],
            upcoming: [
              {
                entityId: sam.id,
                name: sam.name,
                kind: "birthday",
                date: "2026-11-05",
                daysAway: 4,
                turns: 7,
                lastContactAt: null,
                text: `${sam.name} turns 7 on Thursday`,
              },
            ],
          };
      }}
      onGateway={(g) => (gateway = g)}
    >
      <PersonId upcoming={upcoming} />
    </StoryWorld>,
  );
}

function PersonId({ upcoming }: { upcoming: boolean }) {
  void upcoming;
  return <FirstPerson />;
}

import { useEntitySearch } from "../src/people/hooks.ts";

function FirstPerson() {
  const { entities } = useEntitySearch("a", { kinds: ["person"], limit: 20 });
  const person = entities.find((e) => !e.isOwner);
  return person ? <ConnectedEntityCard id={person.id} now={STORY_NOW} /> : <p>loading</p>;
}

describe("person page (everything memory)", () => {
  it("shows what is coming up for them", async () => {
    show(true);
    const row = await screen.findByTestId("upcoming-row");
    expect(row.textContent).toMatch(/turns 7 on Thursday/);
  });

  it("has no Coming up section when nothing is coming up", async () => {
    show(false);
    await screen.findByText(/Facts/);
    expect(screen.queryByTestId("upcoming-row")).toBeNull();
  });

  it("the menu counts what forgetting would remove before it does", async () => {
    show(false);
    const menu = await screen.findByRole("button", { name: /More/ });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Forget what they said/ }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog.textContent).toMatch(/deletes 2 facts and 3 quotes/));
    expect(gateway.world.review?.personLog ?? []).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget what they said" }));
    await waitFor(() => expect((gateway.world.review?.personLog ?? [])[0]).toMatch(/^said:/));
  });

  it("exclude does not delete, and exclude-and-forget does", async () => {
    show(false);
    fireEvent.click(await screen.findByRole("button", { name: /More/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Don't learn about them…$/ }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog.textContent).toMatch(/will not be read/));
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop learning" }));
    await waitFor(() => expect((gateway.world.review?.personLog ?? [])[0]).toMatch(/^exclude:/));
  });
});
