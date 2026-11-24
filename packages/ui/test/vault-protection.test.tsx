import type { VaultStatus } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import {
  VaultProtectionPanel,
  vaultSlotLabel,
} from "../src/screens/settings/CredentialsSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

describe("Settings → Credentials: vault protection", () => {
  it("names a key-file vault and offers Move to Keychain only as unavailable", () => {
    render(
      <StoryWorld>
        <VaultProtectionPanel slots={["key_file", "recovery"]} />
      </StoryWorld>,
    );
    expect(screen.getByTestId("vault-protection").textContent).toContain(
      "Vault protected by: a key file on this Mac",
    );
    expect(
      (screen.getByRole("button", { name: "Move to Keychain" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("labels the Keychain slot", () => {
    expect(vaultSlotLabel(["keychain", "recovery"])).toBe("the Keychain (Touch ID)");
  });
});

/** The panel over a mock vault in `status`; `gateway` records the calls it makes. */
function renderPanel(status: VaultStatus, onChanged: () => void = () => {}) {
  const ref: { current?: MockGateway } = {};
  render(
    <StoryWorld
      edit={(world) => {
        world.vault = { status };
      }}
      onGateway={(g) => (ref.current = g)}
    >
      <VaultProtectionPanel slots={status.slots} status={status} onChanged={onChanged} />
    </StoryWorld>,
  );
  const gateway = () => {
    if (ref.current === undefined) throw new Error("no gateway");
    return ref.current;
  };
  return { gateway };
}

const UNLOCKED: VaultStatus = {
  state: "unlocked",
  slots: ["key_file", "recovery"],
  recoveryConfirmed: true,
  autoLockMinutes: 480,
  lockAt: "2026-11-24T08:00:00.000Z",
  itemCount: 0,
};

describe("Settings → Credentials: Lock now and auto-lock", () => {
  it("offers Lock now only while the vault is unlocked", () => {
    const { unmount } = render(
      <StoryWorld>
        <VaultProtectionPanel slots={["key_file"]} status={UNLOCKED} onChanged={() => {}} />
      </StoryWorld>,
    );
    expect(screen.getByRole("button", { name: "Lock now" })).toBeTruthy();
    unmount();

    render(
      <StoryWorld>
        <VaultProtectionPanel
          slots={["key_file"]}
          status={{ ...UNLOCKED, state: "locked", lockAt: null }}
          onChanged={() => {}}
        />
      </StoryWorld>,
    );
    expect(screen.queryByRole("button", { name: "Lock now" })).toBeNull();
  });

  it("locks the vault through vault.lock and refreshes the panel", async () => {
    const onChanged = vi.fn();
    const { gateway } = renderPanel(UNLOCKED, onChanged);
    await userEvent.click(screen.getByRole("button", { name: "Lock now" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(gateway().calls.map((c) => c.method)).toContain("vault.lock");
  });

  it("shows a failed lock in the panel's error notice and does not refresh", async () => {
    const onChanged = vi.fn();
    const { gateway } = renderPanel(UNLOCKED, onChanged);
    gateway().failNext("vault.lock", "unavailable", "the Mac helper is offline");
    await userEvent.click(screen.getByRole("button", { name: "Lock now" }));
    expect(
      await screen.findByText("The vault could not be locked: the Mac helper is offline"),
    ).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("shows the current auto-lock and sets a new one through vault.setAutoLock", async () => {
    const onChanged = vi.fn();
    const { gateway } = renderPanel(UNLOCKED, onChanged);
    const picker = screen.getByLabelText("Auto-lock after idle time") as HTMLSelectElement;
    expect(picker.value).toBe("480");
    expect(screen.queryByText(/stays unlocked until you lock it/)).toBeNull();

    await userEvent.selectOptions(picker, "60");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const call = gateway().calls.find((c) => c.method === "vault.setAutoLock");
    expect(call?.params).toEqual({ minutes: 60 });
  });

  it("'Never' sends null, and the panel shows the no-auto-lock warning while it is off", async () => {
    const onChanged = vi.fn();
    const { gateway } = renderPanel(UNLOCKED, onChanged);
    await userEvent.selectOptions(screen.getByLabelText("Auto-lock after idle time"), "never");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(gateway().calls.find((c) => c.method === "vault.setAutoLock")?.params).toEqual({
      minutes: null,
    });
  });

  it("shows the warning when auto-lock is already off", () => {
    renderPanel({ ...UNLOCKED, autoLockMinutes: null, lockAt: null });
    expect(screen.getByRole("note").textContent).toContain("stays unlocked until you lock it");
    expect((screen.getByLabelText("Auto-lock after idle time") as HTMLSelectElement).value).toBe(
      "never",
    );
  });

  it("shows a refused change in the error notice and keeps the old value", async () => {
    const onChanged = vi.fn();
    const { gateway } = renderPanel(UNLOCKED, onChanged);
    gateway().failNext("vault.setAutoLock", "forbidden", "admin only");
    await userEvent.selectOptions(screen.getByLabelText("Auto-lock after idle time"), "1440");
    expect(await screen.findByText(/Auto-lock was not changed/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
