import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "../src/screens/onboarding/OnboardingFlow.tsx";
import type { OnboardingResult } from "../src/screens/onboarding/types.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** The opt-in Folders step: Documents, Desktop and Downloads, read only, nothing ticked. */

const OFFERED = [
  { id: "documents" as const, path: "/Users/ada/Documents" },
  { id: "desktop" as const, path: "/Users/ada/Desktop" },
  { id: "downloads" as const, path: "/Users/ada/Downloads" },
];

function run(offered: typeof OFFERED) {
  const onComplete = vi.fn<(r: OnboardingResult) => void>();
  render(
    <StoryWorld
      onGateway={(g) => {
        g.starterFolders = offered;
      }}
    >
      <OnboardingFlow onComplete={onComplete} defaultStep="folders" />
    </StoryWorld>,
  );
  return onComplete;
}

/** From the Folders step, through Safety and Done, to the end. */
async function toTheEnd(user: ReturnType<typeof userEvent.setup>, first: RegExp) {
  await user.click(screen.getByRole("button", { name: first }));
  await user.click(await screen.findByRole("button", { name: /^next/i }));
  await user.click(await screen.findByRole("button", { name: /chat/i }));
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
    await screen.findByTestId("onboarding-safety");
    expect(screen.queryByTestId("onboarding-folders")).toBeNull();
  });
});
