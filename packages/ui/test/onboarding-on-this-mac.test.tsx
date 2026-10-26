import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { OnboardingFlow } from "../src/screens/onboarding/OnboardingFlow.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Onboarding's Connectors step on the MockGateway (docs/connectors/apple-apps-2026.md §7.2). */
function setup(edit: (w: FixtureWorld) => void = (w) => (w.connectors = [])) {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld onGateway={(g) => (gw = g)} edit={edit}>
      <OnboardingFlow onComplete={() => {}} defaultStep="connectors" />
    </StoryWorld>,
  );
  const connects = () =>
    (gw as unknown as MockGateway).calls
      .filter((c) => c.method === "connectors.connect")
      .map((c) => (c.params as { catalogueId: string }).catalogueId);
  return { connects, gateway: () => gw as unknown as MockGateway };
}

const macList = () => screen.getByRole("list", { name: "On this Mac" });

describe("onboarding: On this Mac vs Accounts (#640)", () => {
  it("groups the Mac's apps apart from accounts, with the four defaults selected", async () => {
    setup();
    const mac = await screen.findByRole("list", { name: "On this Mac" });
    const rows = within(mac).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Apple Calendar",
      "Apple Reminders",
      "Apple Mail",
      "Apple Notes",
    ]);
    for (const box of within(mac).getAllByRole("checkbox"))
      expect(box.getAttribute("aria-checked")).toBe("true");
    // Accounts sign in online; the Mac's apps are not in their picker.
    expect(screen.getByRole("heading", { name: "Accounts" })).toBeTruthy();
    const picker = screen.getByLabelText("Account to connect") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(["google", "microsoft", "imap"]);
    expect(screen.getByRole("button", { name: "Connect 4 apps" })).toBeTruthy();
  });

  it("connects the selected apps one at a time, in order", async () => {
    const { connects } = setup();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Apple Mail" }));
    await userEvent.click(screen.getByRole("button", { name: "Connect 3 apps" }));
    await waitFor(() => expect(connects()).toHaveLength(3));
    expect(connects().map((id) => id.replace("apple-", "apple:"))).toEqual([
      "apple:calendar",
      "apple:reminders",
      "apple:notes",
    ]);
    // Each one is listed as it connects; Mail stays on offer.
    const yours = await screen.findByRole("list", { name: "Your accounts" });
    await waitFor(() => expect(within(yours).getAllByRole("listitem")).toHaveLength(3));
    expect(
      within(macList())
        .getAllByRole("listitem")
        .map((r) => r.textContent),
    ).toEqual(["Apple Mail"]);
  });

  it("waits on a missing macOS grant before asking for the next app", async () => {
    const { connects } = setup((w) => {
      w.connectors = [];
      w.appleGrant = "denied";
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect 4 apps" }));
    // Each app's connect leaves it waiting on its grant, listed with Allow; the next follows.
    await waitFor(() => expect(connects()).toHaveLength(4));
    const yours = await screen.findByRole("list", { name: "Your accounts" });
    await waitFor(() =>
      expect(within(yours).getAllByRole("button", { name: /^Allow Apple/ })).toHaveLength(4),
    );
  });

  it("selects nothing by default once something is connected", async () => {
    setup((w) => {
      w.connectors = w.connectors.slice(0, 1);
    });
    const mac = await screen.findByRole("list", { name: "On this Mac" });
    for (const box of within(mac).getAllByRole("checkbox"))
      expect(box.getAttribute("aria-checked")).toBe("false");
    expect(
      (screen.getByRole("button", { name: "Connect apps" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
