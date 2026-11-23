import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { SPACE_IDS, withSpaces } from "../src/fixtures/spaces.ts";
import { ConnectedEntityCard } from "../src/people/ConnectedEntityCard.tsx";
import { useEntitySearch } from "../src/people/hooks.ts";
import { GoalPage } from "../src/screens/goals/GoalPage.tsx";
import { SpacePage } from "../src/spaces/SpacePage.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Three half-wired controls finished on the desktop (2026-11-23): Space folders (add, remove,
 * read & write), goal links (link and unlink) and splitting a merged person.
 */

afterEach(cleanup);

let gateway: MockGateway | undefined;

function callsTo(method: string) {
  if (gateway === undefined) throw new Error("gateway not ready");
  return gateway.calls.filter((c) => c.method === method);
}

describe("Space folders", () => {
  function renderSpace(pickFolder?: () => Promise<string | null>) {
    return render(
      <StoryWorld
        edit={withSpaces}
        onGateway={(g) => {
          gateway = g;
        }}
        slots={pickFolder ? { navigate: vi.fn(), pickFolder } : { navigate: vi.fn() }}
      >
        <SpacePage spaceId={SPACE_IDS.kitchen} />
      </StoryWorld>,
    );
  }

  it("keeps the explanation where there is no Mac picker", async () => {
    renderSpace();
    expect(await screen.findByText("Add folders on the computer where Psyche runs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add folder" })).toBeNull();
  });

  it("adds a folder from the Mac's picker, switches its mode and removes it", async () => {
    const pickFolder = vi.fn(() => Promise.resolve("/Users/owner/Projects/Bills"));
    renderSpace(pickFolder);
    fireEvent.click(await screen.findByRole("button", { name: "Add folder" }));
    await waitFor(() => expect(callsTo("spaces.folders.add")).toHaveLength(1));
    expect(callsTo("spaces.folders.add")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      path: "/Users/owner/Projects/Bills",
      mode: "ro",
    });

    const mode = await screen.findByRole("combobox", { name: "Access to ~/Projects/Kitchen" });
    fireEvent.change(mode, { target: { value: "ro" } });
    await waitFor(() => expect(callsTo("spaces.folders.setMode")).toHaveLength(1));
    expect(callsTo("spaces.folders.setMode")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      path: "~/Projects/Kitchen",
      mode: "ro",
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove ~/Projects/Kitchen" }));
    await waitFor(() => expect(callsTo("spaces.folders.remove")).toHaveLength(1));
    expect(callsTo("spaces.folders.remove")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      path: "~/Projects/Kitchen",
    });
  });

  it("does nothing when the picker is cancelled", async () => {
    renderSpace(() => Promise.resolve(null));
    fireEvent.click(await screen.findByRole("button", { name: "Add folder" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(callsTo("spaces.folders.add")).toHaveLength(0);
  });
});

describe("Goal links", () => {
  it("links a task from the picker, then unlinks it", async () => {
    render(
      <StoryWorld
        onGateway={(g) => {
          gateway = g;
        }}
      >
        <GoalPage goalId={IDS.goals.halfMarathon} />
      </StoryWorld>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Link…" }));
    const dialog = await screen.findByRole("dialog");
    const candidates = await waitFor(() => {
      const found = within(dialog)
        .getAllByRole("button")
        .filter((b) => (b.textContent ?? "").trim() !== "");
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    fireEvent.click(candidates[0] as HTMLElement);
    await waitFor(() => expect(callsTo("goals.link")).toHaveLength(1));
    const linked = callsTo("goals.link")[0]?.params as { goalId: string; taskId?: string };
    expect(linked.goalId).toBe(IDS.goals.halfMarathon);
    expect(linked.taskId).toBeTruthy();

    const unlinks = await waitFor(() => {
      const found = screen.getAllByRole("button", { name: "Unlink" });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    fireEvent.click(unlinks[unlinks.length - 1] as HTMLElement);
    await waitFor(() => expect(callsTo("goals.link")).toHaveLength(2));
    expect(callsTo("goals.link")[1]?.params).toMatchObject({
      goalId: IDS.goals.halfMarathon,
      taskId: linked.taskId,
      unlink: true,
    });
  });
});

function SamWithIdentifiers() {
  const { entities } = useEntitySearch("a", { kinds: ["person"], limit: 20 });
  const person = entities.find((e) => !e.isOwner);
  return person ? <ConnectedEntityCard id={person.id} now={STORY_NOW} /> : <p>loading</p>;
}

describe("Split a merged person", () => {
  it("moves the chosen identifier to a new person", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          const sam = w.graph.entities.find((e) => e.kind === "person" && !e.isOwner);
          const base = sam ? w.graph.identifiers.find((i) => i.entityId === sam.id) : undefined;
          // A merge brought a second identifier in: the split has two to choose from.
          if (base) w.graph.identifiers.push({ ...base, kind: "phone", value: "+15550100" });
        }}
        onGateway={(g) => {
          gateway = g;
        }}
      >
        <SamWithIdentifiers />
      </StoryWorld>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /More/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Split…" }));
    const dialog = await screen.findByRole("dialog");
    const boxes = await waitFor(() => {
      const found = within(dialog).getAllByRole("checkbox");
      expect(found.length).toBeGreaterThanOrEqual(2);
      return found;
    });
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Sam Two" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Split" }));
    await waitFor(() => expect(callsTo("memory.entities.split")).toHaveLength(1));
    const sent = callsTo("memory.entities.split")[0]?.params as {
      identifiers: unknown[];
      name: string;
    };
    expect(sent.name).toBe("Sam Two");
    expect(sent.identifiers).toHaveLength(1);
  });
});
