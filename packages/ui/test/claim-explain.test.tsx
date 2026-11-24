import type { MemoryClaim } from "@psyche/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { ClaimExplain } from "../src/memory/ClaimExplain.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const T = "2026-10-18T09:00:00.000Z";

const claim: MemoryClaim = {
  id: "clm_ava1",
  text: "Ava prefers morning meetings",
  kind: "preference",
  provenance: "owner",
  confidence: 0.91,
  sources: ["memory/2026-10-18.md"],
  supersededBy: null,
  retractedAt: null,
  createdAt: T,
  updatedAt: "2026-10-20T09:00:00.000Z",
};

function harness() {
  const ref: { gateway?: MockGateway } = {};
  const onGateway = (g: MockGateway) => {
    ref.gateway = g;
  };
  return { ref, onGateway };
}

describe("ClaimExplain", () => {
  it("renders nothing without a claim id", () => {
    const { onGateway } = harness();
    const { container } = render(
      <StoryWorld onGateway={onGateway}>
        <ClaimExplain claimId={null} />
      </StoryWorld>,
    );
    expect(screen.queryByRole("button", { name: "Why do you believe this?" })).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows the action with a claim id and explains the claim", async () => {
    const { ref, onGateway } = harness();
    render(
      <StoryWorld onGateway={onGateway}>
        <ClaimExplain claimId="clm_ava1" />
      </StoryWorld>,
    );
    await waitFor(() => expect(ref.gateway).toBeDefined());
    ref.gateway?.world.memoryClaims.push(claim);

    await userEvent.click(screen.getByRole("button", { name: "Why do you believe this?" }));
    // The sheet shows the loading state while memory.explain runs, then the result.
    expect(await screen.findByTestId("explain-body")).toBeTruthy();
    expect(screen.getByTestId("explain-body").querySelector("p")?.textContent).toBe(claim.text);
    expect(screen.getByTestId("explain-confidence").textContent).toContain("91%");
    expect(screen.getByTestId("explain-quote").textContent).toBe(claim.text);
    expect(screen.getByText("memory/2026-10-18.md, line 1")).toBeTruthy();
    expect(
      ref.gateway?.calls.some(
        (c) =>
          c.method === "memory.explain" &&
          (c.params as { claimId?: string } | undefined)?.claimId === "clm_ava1",
      ),
    ).toBe(true);
  });

  it("shows an error state when the claim cannot be explained", async () => {
    const { ref, onGateway } = harness();
    render(
      <StoryWorld onGateway={onGateway}>
        <ClaimExplain claimId="clm_missing" />
      </StoryWorld>,
    );
    await waitFor(() => expect(ref.gateway).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: "Why do you believe this?" }));
    const error = await screen.findByTestId("explain-error");
    expect(error.textContent).toContain("Couldn't load why");
    expect(screen.queryByTestId("explain-body")).toBeNull();
  });

  it("shows the empty sources state when no chunk is linked", async () => {
    const { ref, onGateway } = harness();
    render(
      <StoryWorld onGateway={onGateway}>
        <ClaimExplain claimId="clm_orphan" />
      </StoryWorld>,
    );
    await waitFor(() => expect(ref.gateway).toBeDefined());
    ref.gateway?.world.memoryClaims.push({ ...claim, id: "clm_orphan", sources: [] });

    await userEvent.click(screen.getByRole("button", { name: "Why do you believe this?" }));
    expect(await screen.findByTestId("explain-empty")).toBeTruthy();
  });
});
