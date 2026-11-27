import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  OnboardingFlow,
  type OnboardingFlowProps,
} from "../src/screens/onboarding/OnboardingFlow.tsx";
import type { OnboardingResult } from "../src/screens/onboarding/types.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** The opt-in Folders step: Documents, Desktop and Downloads, read only, nothing ticked. */

const OFFERED = [
  { id: "documents" as const, path: "/Users/ada/Documents" },
  { id: "desktop" as const, path: "/Users/ada/Desktop" },
  { id: "downloads" as const, path: "/Users/ada/Downloads" },
];

function run(offered: typeof OFFERED, onShareFolders?: OnboardingFlowProps["onShareFolders"]) {
  const onComplete = vi.fn<(r: OnboardingResult) => void>();
  render(
    <StoryWorld
      onGateway={(g) => {
        g.starterFolders = offered;
      }}
    >
      <OnboardingFlow
        onComplete={onComplete}
        defaultStep="folders"
        {...(onShareFolders ? { onShareFolders } : {})}
      />
    </StoryWorld>,
  );
  return onComplete;
}

/** From the Folders step, through Done, to the end (Safety is no longer a step on the way). */
async function toTheEnd(user: ReturnType<typeof userEvent.setup>, first: RegExp) {
  await user.click(screen.getByRole("button", { name: first }));
  await user.click(await screen.findByRole("button", { name: /open the main chat/i }));
}

describe("onboarding folders step", () => {
  it("starts with nothing ticked", async () => {
    run(OFFERED);
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const b of boxes) expect((b as HTMLInputElement).checked).toBe(false);
  });

  it("ticking two returns exactly those two, with their paths", async () => {
    const user = userEvent.setup();
    const onComplete = run(OFFERED);
    await user.click(await screen.findByRole("checkbox", { name: /documents/i }));
    await user.click(screen.getByRole("checkbox", { name: /downloads/i }));
    await toTheEnd(user, /^next/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete.mock.calls[0]?.[0].sharedFolders).toEqual([
      { id: "documents", path: "/Users/ada/Documents" },
      { id: "downloads", path: "/Users/ada/Downloads" },
    ]);
  });

  it("Skip writes nothing, even after ticking", async () => {
    const user = userEvent.setup();
    const onComplete = run(OFFERED);
    await user.click(await screen.findByRole("checkbox", { name: /desktop/i }));
    await toTheEnd(user, /skip for now/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete.mock.calls[0]?.[0].sharedFolders).toBeUndefined();
  });

  it("offers only what the Gateway offers: a folder it left out has no box", async () => {
    run(OFFERED.filter((o) => o.id !== "downloads"));
    expect(await screen.findAllByRole("checkbox")).toHaveLength(2);
    expect(screen.queryByRole("checkbox", { name: /downloads/i })).toBeNull();
  });

  it("is left out entirely when nothing is offered", async () => {
    run([]);
    await screen.findByTestId("onboarding-try");
    expect(screen.queryByTestId("onboarding-folders")).toBeNull();
  });

  it("a card that needs approval points to Settings, with no retry", async () => {
    const user = userEvent.setup();
    const needs = Object.assign(new Error("approval required"), {
      code: "approval_required",
      details: { approvalId: "ap1" },
    });
    const share = vi
      .fn<NonNullable<OnboardingFlowProps["onShareFolders"]>>()
      .mockRejectedValue(needs);
    const onComplete = run(OFFERED, share);
    await user.click(await screen.findByRole("checkbox", { name: /documents/i }));
    await toTheEnd(user, /^next/i);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /later in Settings → Privacy & security → Access/i,
    );
    expect(onComplete).not.toHaveBeenCalled();
    // The card cannot be answered here: no retry is offered.
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /open file access/i }));
    expect(share).toHaveBeenCalledTimes(1);
    const result = onComplete.mock.calls[0]?.[0];
    expect(result?.openFileAccess).toBe(true);
    expect(result?.sharedFolders).toBeUndefined();
  });

  it("Continue without sharing finishes with nothing shared", async () => {
    const user = userEvent.setup();
    const needs = Object.assign(new Error("x"), {
      code: "approval_required",
      details: { approvalId: "a" },
    });
    const onComplete = run(OFFERED, vi.fn().mockRejectedValue(needs));
    await user.click(await screen.findByRole("checkbox", { name: /desktop/i }));
    await toTheEnd(user, /^next/i);
    await user.click(await screen.findByRole("button", { name: /continue without sharing/i }));
    expect(onComplete.mock.calls[0]?.[0].sharedFolders).toBeUndefined();
  });
});
