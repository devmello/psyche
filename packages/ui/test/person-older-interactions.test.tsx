import type { MethodResult } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { ConnectedEntityCard } from "../src/people/ConnectedEntityCard.tsx";
import { clipSubject } from "../src/people/EntityCard.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

type Interaction = MethodResult<"memory.entities.interactions">["interactions"][number];

const SAM = "ent_sam_lee";

/** Mail `n` from Sam; 1 is the newest. */
function mail(n: number, subject: string): Interaction {
  return {
    id: `int_${n}`,
    kind: "mail",
    source: "mail",
    occurredAt: new Date(Date.parse("2026-11-20T09:00:00Z") - n * 3_600_000).toISOString(),
    direction: "in",
    subject,
    threadKey: null,
    link: `message://m${n}`,
    projectId: null,
    participants: [{ entityId: SAM, role: "from" }],
  };
}

function thread(count: number): Interaction[] {
  return Array.from({ length: count }, (_, i) => mail(i + 1, `Thread ${i + 1}`));
}

function show(interactions: Interaction[], onGateway?: (g: MockGateway) => void) {
  return render(
    <StoryWorld
      edit={(w) => {
        w.graph.interactions = interactions;
      }}
      onGateway={onGateway}
    >
      <ConnectedEntityCard id={SAM} now={STORY_NOW} />
    </StoryWorld>,
  );
}

const showOlder = () => screen.queryByRole("button", { name: "Show older" });

describe("Recent list with Show older", () => {
  it("shows each interaction once, even when the card and the first page both have it", async () => {
    show(thread(12));
    await screen.findByText("Thread 1");
    // Threads 1 to 5 are the card's rows; page 1 (1 to 10) repeats them.
    await showOlderClick();
    for (let n = 1; n <= 10; n += 1) {
      expect(screen.getAllByText(`Thread ${n}`)).toHaveLength(1);
    }
  });

  it("appends older rows in the same list, and hides the button at the end", async () => {
    show(thread(12));
    await screen.findByText("Thread 1");
    expect(screen.queryByText("Thread 6")).toBeNull();
    await showOlderClick();
    expect(await screen.findByText("Thread 6")).toBeTruthy();
    expect(screen.getByText("Thread 10")).toBeTruthy();
    expect(screen.queryByText("Thread 11")).toBeNull();
    fireEvent.click(showOlder() as HTMLElement);
    expect(await screen.findByText("Thread 12")).toBeTruthy();
    expect(screen.getByText("Thread 11")).toBeTruthy();
    await waitFor(() => expect(showOlder()).toBeNull());
  });

  it("has no Show older button when the list is complete", async () => {
    show(thread(3));
    await screen.findByText("Thread 3");
    // Let the first page's query settle before asserting its absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(showOlder()).toBeNull();
  });

  it("shows the error with Try again when older rows fail to load, then retries", async () => {
    let gateway: MockGateway | undefined;
    show(thread(12), (g) => {
      gateway = g;
    });
    await screen.findByText("Thread 1");
    await showOlderClick();
    await screen.findByText("Thread 6");
    gateway?.failNext("memory.entities.interactions", "unavailable", "the Gateway is down");
    fireEvent.click(showOlder() as HTMLElement);
    expect(await screen.findByText(/Could not load older interactions/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Thread 11")).toBeTruthy();
    expect(screen.queryByText(/Could not load older interactions/)).toBeNull();
  });

  it("keeps the subject as plain text, cut to 120 code points", () => {
    expect(clipSubject("😀".repeat(5), 3)).toBe("😀😀…");
    expect(clipSubject("short", 120)).toBe("short");
    expect([...clipSubject("x".repeat(400))]).toHaveLength(120);
  });
});

/** Clicks Show older once it is on screen, then waits for its rows. */
async function showOlderClick(): Promise<void> {
  const button = await screen.findByRole("button", { name: "Show older" });
  fireEvent.click(button);
  await screen.findByText("Thread 6");
}
