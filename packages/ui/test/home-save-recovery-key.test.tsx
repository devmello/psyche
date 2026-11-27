import type { VaultStatus } from "@psyche/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { HomeScreen } from "../src/home/HomeScreen.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Home's "Save your recovery key" card (Needs you): it shows while the vault exists, the key is
 * not confirmed and the Gateway still holds it, and goes once the owner confirms.
 */

const status: VaultStatus = {
  state: "unlocked",
  slots: ["key_file", "recovery"],
  recoveryConfirmed: false,
  recoveryKeyStored: true,
  autoLockMinutes: 480,
  lockAt: null,
  itemCount: 0,
};

function mount(vault?: VaultStatus): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      edit={(w) => {
        if (vault !== undefined) w.vault = { status: vault, recoveryKey: "AAAA-BBBB-CCCC-DDDD" };
      }}
      onGateway={(g) => {
        gw = g;
      }}
    >
      <HomeScreen now={STORY_NOW} />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("Home: Save your recovery key", () => {
  it("shows under Needs you until confirmed, and never puts the key on Home unasked", async () => {
    const gw = mount(status);
    const card = await screen.findByTestId("save-recovery-key");
    expect(screen.getByTestId("section-needs-you").contains(card)).toBe(true);
    expect(card.textContent).toContain("Save your recovery key");
    expect(document.body.textContent).not.toContain("AAAA-BBBB-CCCC-DDDD");
    expect(gw().calls.map((c) => c.method)).not.toContain("vault.recoveryKey");

    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Show recovery key" }));
    expect((await screen.findByTestId("vault-recovery-key")).textContent).toContain(
      "AAAA-BBBB-CCCC-DDDD",
    );
    expect(gw().calls.map((c) => c.method)).not.toContain("presence.confirm");

    // Confirming with the key's last group removes the card.
    await user.type(screen.getByLabelText("Last group"), "dddd");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByTestId("save-recovery-key")).toBeNull());
    expect(document.body.textContent).not.toContain("AAAA-BBBB-CCCC-DDDD");
  });

  it("stays while the key is wrong or unconfirmed (positive control for the removal)", async () => {
    mount(status);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show recovery key" }));
    await user.type(await screen.findByLabelText("Last group"), "NOPE");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("alert");
    expect(screen.getByTestId("save-recovery-key")).toBeTruthy();
  });

  it.each([
    ["confirmed", { ...status, recoveryConfirmed: true }],
    ["no vault yet", { ...status, state: "uninitialized" as const, recoveryKeyStored: false }],
    ["an older vault whose key is not kept", { ...status, recoveryKeyStored: false }],
  ])("is not shown for %s", async (_name, vault) => {
    mount(vault);
    await screen.findByTestId("home");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("save-recovery-key")).toBeNull();
  });

  it("is not shown where the Gateway has no vault", async () => {
    mount(undefined);
    await screen.findByTestId("home");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("save-recovery-key")).toBeNull();
  });
});
