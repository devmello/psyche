import type { MethodResult } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectedInteractions, clipSubject } from "../src/people/ConnectedInteractions.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

type Interaction = MethodResult<"memory.entities.interactions">["interactions"][number];

const SAM = "ent_sam_lee";

function mail(
  n: number,
  subject: string | null,
  link: string | null = `message://m${n}`,
): Interaction {
  return {
    id: `int_${n}`,
    kind: "mail",
    source: "mail",
    occurredAt: new Date(Date.parse("2026-11-20T09:00:00Z") - n * 3_600_000).toISOString(),
    direction: "in",
    subject,
    threadKey: null,
    link,
    projectId: null,
    participants: [{ entityId: SAM, role: "from" }],
  };
}

function show(interactions: Interaction[]) {
  return render(
    <StoryWorld
      edit={(w) => {
        w.graph.interactions = interactions;
      }}
    >
      <ConnectedInteractions entityId={SAM} name="Sam Lee" />
    </StoryWorld>,
  );
}

describe("recent interactions", () => {
  it("lists who, what and when, newest first, with a link to the source", async () => {
    show([mail(2, "Re: budget"), mail(1, "Launch notes"), mail(3, null, null)]);
    const rows = await screen.findAllByTestId("interaction-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Launch notes/),
      expect.stringMatching(/^Re: budget/),
      expect.stringMatching(/^Mail/),
    ]);
    expect(rows[0]?.textContent).toMatch(/Received · Mail · /);
    // Rows without a link show no open button; rows with one do.
    expect(within(rows[2] as HTMLElement).queryByRole("button")).toBeNull();
    expect(
      within(rows[0] as HTMLElement).getByRole("button", { name: "Open in Mail" }),
    ).toBeTruthy();
  });

  it("renders a third-party subject as plain text, never as markup", async () => {
    show([mail(1, "<img src=x onerror=alert(1)>**bold**")]);
    const row = (await screen.findAllByTestId("interaction-row"))[0] as HTMLElement;
    expect(row.querySelector("img")).toBeNull();
    expect(row.textContent).toContain("<img src=x onerror=alert(1)>**bold**");
  });

  it("cuts a long subject before it reaches the screen", async () => {
    const long = "x".repeat(200);
    show([mail(1, long)]);
    const row = (await screen.findAllByTestId("interaction-row"))[0] as HTMLElement;
    const shown = row.querySelector("span.truncate")?.textContent ?? "";
    expect([...shown].length).toBeLessThanOrEqual(120);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("clips by code point, so an emoji is never split", () => {
    const text = "😀".repeat(5);
    expect(clipSubject(text, 3)).toBe("😀😀…");
    expect(clipSubject("short", 120)).toBe("short");
  });

  it("says so when there are no interactions", async () => {
    show([]);
    expect(await screen.findByText("No interactions with Sam Lee yet.")).toBeTruthy();
  });

  it("pages with Show more", async () => {
    show(Array.from({ length: 12 }, (_, i) => mail(i + 1, `Thread ${i + 1}`)));
    await waitFor(() => expect(screen.getAllByTestId("interaction-row")).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getAllByTestId("interaction-row")).toHaveLength(12));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("shows the error when the list cannot load", async () => {
    render(
      <StoryWorld
        onGateway={(g) => {
          g.failNext("memory.entities.interactions", "unavailable", "the Gateway is down");
        }}
      >
        <ConnectedInteractions entityId={SAM} name="Sam Lee" />
      </StoryWorld>,
    );
    expect(await screen.findByText(/Could not load interactions/)).toBeTruthy();
  });
});
