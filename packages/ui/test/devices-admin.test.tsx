import type { Device } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DevicesPanel } from "../src/screens/settings/DevicesSection.tsx";
import { TouchIdKeySetup } from "../src/screens/settings/TouchIdKeySetup.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const mac: Device = {
  id: "d1",
  name: "Psyche Desktop",
  platform: "macos",
  role: "client",
  publicKey: "MCowBQYDK2VwAyEAx8x9Qm3h0Tq6vQ3m1gD4k2nqv9c3F0aY0bJ6m1s2t3U=",
  scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  pairedAt: "2026-10-20T10:00:00.000Z",
  lastSeenAt: "2026-10-20T10:00:00.000Z",
  revokedAt: null,
} as Device;

describe("Settings → Devices: the first admin", () => {
  it("says this Mac is the admin device only for this window's own admin device", () => {
    const { rerender } = render(
      <StoryWorld>
        <DevicesPanel devices={[mac]} pairing={[]} nodes={[]} thisDeviceId="d1" />
      </StoryWorld>,
    );
    expect(screen.getByTestId("this-mac-admin").textContent).toContain(
      "This Mac is the admin device",
    );
    rerender(
      <StoryWorld>
        <DevicesPanel devices={[mac]} pairing={[]} nodes={[]} thisDeviceId="other" />
      </StoryWorld>,
    );
    expect(screen.queryByTestId("this-mac-admin")).toBeNull();
    // A browser that holds admin is not a Mac (#554).
    rerender(
      <StoryWorld>
        <DevicesPanel
          devices={[{ ...mac, platform: "web" }]}
          pairing={[]}
          nodes={[]}
          thisDeviceId="d1"
        />
      </StoryWorld>,
    );
    expect(screen.queryByTestId("this-mac-admin")).toBeNull();
    expect(screen.getByText("This device")).toBeTruthy();
  });
});

describe("Settings → Devices: which Touch ID key the helper uses", () => {
  const helper = {
    id: "n1",
    deviceId: "d1",
    kind: "mac-helper",
    capabilities: [],
    status: "online",
    lastHeartbeatAt: null,
  } as unknown as Parameters<typeof DevicesPanel>[0]["nodes"][number];
  const key = (kind?: "keychain" | "enclave_keychain_acl" | "enclave_file") => ({
    deviceId: "d1",
    keyId: "a".repeat(64),
    registeredAt: "2026-11-02T10:00:00.000Z",
    ...(kind === undefined ? {} : { kind }),
  });

  it("names the keychain key and the Secure Enclave file in plain words", () => {
    const { rerender } = render(
      <StoryWorld>
        <DevicesPanel
          devices={[mac]}
          pairing={[]}
          nodes={[helper]}
          presenceKeys={[key("keychain")]}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("presence-key").textContent).toBe(
      "Touch ID key (keychain), as reported by the helper",
    );
    rerender(
      <StoryWorld>
        <DevicesPanel
          devices={[mac]}
          pairing={[]}
          nodes={[helper]}
          presenceKeys={[key("enclave_file")]}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("presence-key").textContent).toBe(
      "Touch ID key (Secure Enclave file, this build has no provisioning profile), as reported by the helper",
    );
    rerender(
      <StoryWorld>
        <DevicesPanel
          devices={[mac]}
          pairing={[]}
          nodes={[helper]}
          presenceKeys={[key("enclave_keychain_acl")]}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("presence-key").textContent).toBe(
      "Touch ID key (Secure Enclave, readable only by Psyche Helper without a macOS prompt), as reported by the helper",
    );
    rerender(
      <StoryWorld>
        <DevicesPanel devices={[mac]} pairing={[]} nodes={[helper]} />
      </StoryWorld>,
    );
    expect(screen.queryByTestId("presence-key")).toBeNull();
  });
});

describe("Settings → Devices: registering a Touch ID key (security review, finding 1)", () => {
  const KEY = "0123456789abcdef".repeat(4);
  const handlers = () => ({
    onRegister: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    onAllowDevFileKey: vi.fn(async () => undefined),
  });

  it("desktop: shows the bundled helper's key id and registers exactly that", async () => {
    const h = handlers();
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          bundled={{ deviceId: "dev_helper", keyId: KEY, kind: "keychain" }}
          allowDevFileKey={false}
          {...h}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("bundled-key-id").textContent).toBe("0123 4567 89ab cdef …");
    await userEvent.click(screen.getByRole("button", { name: "Register this key" }));
    // The host registers the bundled helper's own key: no key id comes from the page.
    expect(h.onRegister).toHaveBeenCalledWith();
  });

  it("a helper that is not the bundled one gets no Register button", () => {
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_rogue"
          bundled={{ deviceId: "dev_helper", keyId: KEY, kind: "keychain" }}
          allowDevFileKey={false}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("touch-id-not-bundled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Register this key" })).toBeNull();
  });

  it("a development file key needs the owner's switch first, and says what it risks", async () => {
    const h = handlers();
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          bundled={{ deviceId: "dev_helper", keyId: KEY, kind: "enclave_file" }}
          allowDevFileKey={false}
          {...h}
        />
      </StoryWorld>,
    );
    expect(
      (screen.getByRole("button", { name: "Register this key" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain("Any app running as you could ask it to sign");
    await userEvent.click(screen.getByRole("switch", { name: "Allow a development Touch ID key" }));
    expect(h.onAllowDevFileKey).toHaveBeenCalledWith(true);
  });

  it("an untrusted keychain key is named in plain words and nothing can be registered", () => {
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          bundled={{ deviceId: "dev_helper", error: "presence_key_untrusted" }}
          allowDevFileKey={false}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("touch-id-no-key").textContent).toContain("--reset-presence-key");
    expect(screen.queryByRole("button", { name: "Register this key" })).toBeNull();
  });

  it("the untrusted copy names the full helper path and the quit step; access denied is careful", () => {
    const { rerender } = render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          bundled={{ deviceId: "dev_helper", error: "presence_key_untrusted" }}
          allowDevFileKey={false}
          {...handlers()}
        />
      </StoryWorld>,
    );
    const untrusted = screen.getByTestId("touch-id-no-key").textContent ?? "";
    expect(untrusted).toContain(
      "/Applications/Psyche.app/Contents/Resources/PsycheHelper.app/Contents/MacOS/psyche-helper",
    );
    expect(untrusted).toContain("quit Psyche Helper first");
    expect(untrusted).toContain("moved or reinstalled");
    rerender(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          bundled={{ deviceId: "dev_helper", error: "presence_key_access_denied" }}
          allowDevFileKey={false}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("touch-id-no-key").textContent).toContain(
      "only if the dialog names psyche-helper",
    );
  });

  it("names the interaction, changed-while-running and ACL-unavailable key states", () => {
    const text = (error: string) => {
      const { unmount } = render(
        <StoryWorld>
          <TouchIdKeySetup
            deviceId="dev_helper"
            bundled={{ deviceId: "dev_helper", error }}
            allowDevFileKey={false}
            {...handlers()}
          />
        </StoryWorld>,
      );
      const out = screen.getByTestId("touch-id-no-key").textContent ?? "";
      unmount();
      return out;
    };
    expect(text("presence_key_interaction_not_allowed")).toContain("Unlock the Mac");
    expect(text("presence_key_changed")).toContain("changed while Psyche Helper was running");
    expect(text("presence_key_acl_unavailable")).toContain("access list");
  });

  it("shows the bundled helper's key problem and a key-id mismatch even while a key is registered", () => {
    const registered = {
      deviceId: "dev_helper",
      keyId: "a".repeat(64),
      registeredAt: "2026-11-02T10:00:00.000Z",
      kind: "enclave_keychain_acl" as const,
    };
    const { rerender } = render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          registered={registered}
          bundled={{ deviceId: "dev_helper", error: "presence_key_untrusted" }}
          allowDevFileKey={false}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("bundled-key-problem").textContent).toContain("--reset-presence-key");
    rerender(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          registered={registered}
          bundled={{ deviceId: "dev_helper", keyId: "b".repeat(64), kind: "enclave_keychain_acl" }}
          allowDevFileKey={false}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("bundled-key-mismatch").textContent).toContain("bbbb bbbb");
    rerender(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          registered={registered}
          bundled={{ deviceId: "dev_helper", keyId: "a".repeat(64), kind: "enclave_keychain_acl" }}
          allowDevFileKey={false}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.queryByTestId("bundled-key-mismatch")).toBeNull();
  });

  it("asks the owner to confirm a replacement naming the old key, then registers with it", async () => {
    const previous = "c".repeat(64);
    const onRegister = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("replace"), {
          code: "conflict",
          details: { reason: "replace_confirmation_required", replacesKeyId: previous },
        }),
      )
      .mockResolvedValue(undefined);
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          bundled={{ deviceId: "dev_helper", keyId: KEY, kind: "enclave_keychain_acl" }}
          allowDevFileKey={false}
          {...handlers()}
          onRegister={onRegister}
        />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Register this key" }));
    const box = await screen.findByTestId("confirm-replace");
    expect(box.textContent).toContain("cccc cccc cccc cccc");
    await userEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(onRegister).toHaveBeenLastCalledWith(undefined, previous);
  });

  it("web: the owner pastes the key id the helper prints; nothing registers without one", async () => {
    const h = handlers();
    render(
      <StoryWorld>
        <TouchIdKeySetup deviceId="dev_helper" allowDevFileKey={false} {...h} />
      </StoryWorld>,
    );
    const register = screen.getByRole("button", { name: "Register this key" }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Key id"), KEY);
    await userEvent.click(register);
    expect(h.onRegister).toHaveBeenCalledWith(KEY);
  });

  it("a registered key can be removed (recovery after a fingerprint change)", async () => {
    const h = handlers();
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          registered={{
            deviceId: "dev_helper",
            keyId: KEY,
            registeredAt: "2026-11-02T10:00:00.000Z",
          }}
          allowDevFileKey={false}
          {...h}
        />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(h.onRemove).toHaveBeenCalled());
  });
});
