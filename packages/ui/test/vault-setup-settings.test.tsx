import type { VaultStatus } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { CredentialsSection } from "../src/screens/settings/CredentialsSection.tsx";
import type { UiSlots } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Credentials: set the vault up, and confirm the recovery key later. */

const base: VaultStatus = {
  state: "uninitialized",
  slots: [],
  recoveryConfirmed: false,
  autoLockMinutes: 480,
  lockAt: null,
  itemCount: 0,
};

function setup(status: VaultStatus, slots: UiSlots = {}): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      slots={slots}
      edit={(w) => {
        w.vault = {
          status,
          ...(status.state === "uninitialized" ? {} : { recoveryKey: "AAAA-BBBB-CCCC-DDDD" }),
        };
      }}
      onGateway={(g) => {
        gw = g;
      }}
    >
      <CredentialsSection now={Date.parse(FIXTURE_NOW)} />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

const callsOf = (g: MockGateway, method: string) => g.calls.filter((c) => c.method === method);

describe("Settings → Credentials: set up the vault", () => {
  it("sets the vault up once, shows the key, and confirms it with its last group", async () => {
    const gw = setup(base);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Set up the vault" }));

    const card = await screen.findByTestId("vault-recovery-key");
    expect(card.textContent).toContain("MOCK-ABCD-EFGH-WXYZ");
    expect(callsOf(gw(), "vault.setup")).toHaveLength(1);

    // A wrong group is refused and nothing is confirmed.
    await user.type(screen.getByLabelText("Last group"), "NOPE");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not the last group of the recovery key",
    );
    expect(screen.getByTestId("vault-recovery-key")).toBeTruthy();

    await user.type(screen.getByLabelText("Last group"), "wxyz");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByTestId("vault-recovery-key")).toBeNull());
    expect(screen.queryByTestId("vault-setup")).toBeNull();
    expect(callsOf(gw(), "vault.setup")).toHaveLength(1);
    // The key is never sent back; only the typed group is.
    expect(JSON.stringify(callsOf(gw(), "vault.confirmRecovery"))).not.toContain("MOCK-ABCD");
  });

  it("keeps the key on screen when the status refreshes under it", async () => {
    setup(base);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Set up the vault" }));
    expect((await screen.findByTestId("vault-recovery-key")).textContent).toContain("WXYZ");
    // The status is now "unlocked" and unconfirmed; the key is still the one shown.
    await waitFor(() => expect(screen.getByTestId("vault-protection")).toBeTruthy());
    expect(screen.getByTestId("vault-recovery-key").textContent).toContain("WXYZ");
  });

  it("offers no setup when a vault exists and its recovery key is confirmed", async () => {
    setup({
      ...base,
      state: "unlocked",
      slots: ["key_file", "recovery"],
      recoveryConfirmed: true,
    });
    await screen.findByTestId("vault-protection");
    expect(screen.queryByRole("button", { name: "Set up the vault" })).toBeNull();
    expect(screen.queryByTestId("vault-confirm-recovery")).toBeNull();
  });
});

describe("Settings → Credentials: confirm your recovery key", () => {
  const unconfirmed: VaultStatus = {
    ...base,
    state: "unlocked",
    slots: ["key_file", "recovery"],
  };

  it("asks for the last group, refuses a wrong one and accepts the right one", async () => {
    const gw = setup(unconfirmed);
    const user = userEvent.setup();
    expect((await screen.findByTestId("vault-confirm-recovery")).textContent).toContain(
      "Confirm your recovery key",
    );
    expect(screen.queryByRole("button", { name: "Set up the vault" })).toBeNull();

    await user.type(screen.getByLabelText("Last group"), "XXXX");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("alert");
    // The wrong words are cleared from the field, not kept.
    expect((screen.getByLabelText("Last group") as HTMLInputElement).value).toBe("");

    await user.type(screen.getByLabelText("Last group"), "DDDD");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByTestId("vault-confirm-recovery")).toBeNull());
    expect(callsOf(gw(), "vault.confirmRecovery")).toHaveLength(2);
    expect(callsOf(gw(), "vault.unlock")).toHaveLength(0);
  });

  it("unlocks a locked vault first, the way onboarding does, and asks for no presence", async () => {
    const gw = setup({ ...unconfirmed, state: "locked" });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Last group"), "DDDD");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByTestId("vault-confirm-recovery")).toBeNull());
    expect(callsOf(gw(), "vault.unlock")).toHaveLength(1);
    expect(gw().calls.map((c) => c.method)).not.toContain("presence.confirm");
  });
});

describe("Settings → Credentials: the recovery key stays viewable", () => {
  const confirmed: VaultStatus = {
    ...base,
    state: "unlocked",
    slots: ["key_file", "recovery"],
    recoveryConfirmed: true,
    recoveryKeyStored: true,
  };

  it("shows the key on a plain tap, with no Touch ID, password or presence call", async () => {
    const gw = setup(confirmed);
    const user = userEvent.setup();
    const panel = await screen.findByTestId("vault-view-recovery");
    // Not on the page until asked for.
    expect(screen.queryByTestId("vault-recovery-key")).toBeNull();
    expect(panel.textContent).not.toContain("AAAA-BBBB");
    await user.click(within(panel).getByRole("button", { name: "Show recovery key" }));
    expect((await screen.findByTestId("vault-recovery-key")).textContent).toContain(
      "AAAA-BBBB-CCCC-DDDD",
    );
    expect(callsOf(gw(), "vault.recoveryKey")).toHaveLength(1);
    expect(gw().calls.map((c) => c.method)).not.toContain("presence.confirm");
    // Hiding takes the key off the page again.
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByTestId("vault-recovery-key")).toBeNull();
    expect(document.body.textContent).not.toContain("AAAA-BBBB-CCCC-DDDD");
  });

  it("unlocks a locked vault first, the way the confirm form does, and still asks for no presence", async () => {
    const gw = setup({ ...confirmed, state: "locked" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show recovery key" }));
    await screen.findByTestId("vault-recovery-key");
    expect(callsOf(gw(), "vault.unlock")).toHaveLength(1);
    expect(gw().calls.map((c) => c.method)).not.toContain("presence.confirm");
  });

  it("offers nothing to show when the Gateway no longer holds the key (an older vault)", async () => {
    setup({ ...confirmed, recoveryKeyStored: false });
    await screen.findByTestId("vault-protection");
    expect(screen.queryByRole("button", { name: "Show recovery key" })).toBeNull();
    expect(screen.queryByTestId("vault-view-recovery")).toBeNull();
  });

  it("an unconfirmed vault shows the key next to the confirm form", async () => {
    setup({ ...confirmed, recoveryConfirmed: false });
    const user = userEvent.setup();
    const panel = await screen.findByTestId("vault-confirm-recovery");
    await user.click(within(panel).getByRole("button", { name: "Show recovery key" }));
    await screen.findByTestId("vault-recovery-key");
    expect(screen.getByLabelText("Last group")).toBeTruthy();
  });

  it("copies the key through the host's clipboard and says so (#507)", async () => {
    const writeClipboard = vi.fn(async (_text: string) => {});
    setup(confirmed, { writeClipboard });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show recovery key" }));
    const box = await screen.findByTestId("vault-recovery-key");
    await user.click(within(box).getByRole("button", { name: "Copy" }));
    expect(writeClipboard).toHaveBeenCalledWith("AAAA-BBBB-CCCC-DDDD");
    expect(await within(box).findByRole("button", { name: "Copied" })).toBeTruthy();
  });
});
