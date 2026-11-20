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

describe("Settings → Devices: which presence key the helper uses", () => {
  const helper = {
    id: "n1",
    deviceId: "d1",
    kind: "mac-helper",
    capabilities: [],
    status: "online",
    lastHeartbeatAt: null,
  } as unknown as Parameters<typeof DevicesPanel>[0]["nodes"][number];
  const winHelper = { ...helper, kind: "win-helper" } as typeof helper;
  const key = (kind?: "device_identity" | "windows_hello") => ({
    deviceId: "d1",
    keyId: "a".repeat(64),
    registeredAt: "2026-11-02T10:00:00.000Z",
    ...(kind === undefined ? {} : { kind }),
  });
  const touchId = () => ({
    bundled: undefined,
    onRegister: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
  });

  it("names the Mac's device key and the Windows Hello key in plain words", () => {
    const { rerender } = render(
      <StoryWorld>
        <DevicesPanel
          devices={[mac]}
          pairing={[]}
          nodes={[helper]}
          presenceKeys={[key("device_identity")]}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("presence-key").textContent).toBe(
      "Payments use Touch ID or your Mac password. Nothing to set up.",
    );
    rerender(
      <StoryWorld>
        <DevicesPanel
          devices={[mac]}
          pairing={[]}
          nodes={[winHelper]}
          presenceKeys={[{ ...key("windows_hello"), algorithm: "rsa-2048-pkcs1-sha256" }]}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("presence-key").textContent).toBe(
      "Windows Hello key (RSA-2048), as reported by the helper",
    );
    rerender(
      <StoryWorld>
        <DevicesPanel devices={[mac]} pairing={[]} nodes={[helper]} />
      </StoryWorld>,
    );
    expect(screen.queryByTestId("presence-key")).toBeNull();
  });

  it("a Mac helper's row has nothing to register or remove, even with a key listed", () => {
    const { rerender } = render(
      <StoryWorld>
        <DevicesPanel
          devices={[mac]}
          pairing={[]}
          nodes={[helper]}
          presenceKeys={[key("device_identity")]}
          touchId={touchId()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("presence-key").textContent).toContain("Nothing to set up");
    expect(screen.queryByRole("button", { name: "Register this key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
    rerender(
      <StoryWorld>
        <DevicesPanel
          devices={[mac]}
          pairing={[]}
          nodes={[helper]}
          presenceKeys={[]}
          touchId={touchId()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("presence-key").textContent).toContain("Nothing to set up");
    expect(screen.queryByRole("button", { name: "Register this key" })).toBeNull();
  });
});

describe("Settings → Devices: registering a Windows Hello key (security review, finding 1)", () => {
  const KEY = "0123456789abcdef".repeat(4);
  const handlers = () => ({
    onRegister: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
  });

  it("a Mac helper gets the one-line note and no buttons from TouchIdKeySetup itself", () => {
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          nodeKind="mac-helper"
          bundled={{ deviceId: "dev_helper" }}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("presence-key").textContent).toContain("Nothing to set up");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("desktop: shows the bundled helper's key id and registers exactly that", async () => {
    const h = handlers();
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          nodeKind="win-helper"
          bundled={{ deviceId: "dev_helper", keyId: KEY, kind: "windows_hello" }}
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
          nodeKind="win-helper"
          bundled={{ deviceId: "dev_helper", keyId: KEY, kind: "windows_hello" }}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("touch-id-not-bundled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Register this key" })).toBeNull();
  });

  it("a bundled helper without a key says why, and nothing can be registered", () => {
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          nodeKind="win-helper"
          bundled={{ deviceId: "dev_helper", error: "missing_entitlement" }}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("touch-id-no-key").textContent).toContain("missing_entitlement");
    expect(screen.queryByRole("button", { name: "Register this key" })).toBeNull();
  });

  it("shows the bundled helper's key problem and a key-id mismatch even while a key is registered", () => {
    const registered = {
      deviceId: "dev_helper",
      keyId: "a".repeat(64),
      registeredAt: "2026-11-02T10:00:00.000Z",
      kind: "windows_hello" as const,
    };
    const { rerender } = render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          nodeKind="win-helper"
          registered={registered}
          bundled={{ deviceId: "dev_helper", error: "missing_entitlement" }}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("bundled-key-problem").textContent).toContain("missing_entitlement");
    rerender(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          nodeKind="win-helper"
          registered={registered}
          bundled={{ deviceId: "dev_helper", keyId: "b".repeat(64), kind: "windows_hello" }}
          {...handlers()}
        />
      </StoryWorld>,
    );
    expect(screen.getByTestId("bundled-key-mismatch").textContent).toContain("bbbb bbbb");
    rerender(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          nodeKind="win-helper"
          registered={registered}
          bundled={{ deviceId: "dev_helper", keyId: "a".repeat(64), kind: "windows_hello" }}
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
          nodeKind="win-helper"
          bundled={{ deviceId: "dev_helper", keyId: KEY, kind: "windows_hello" }}
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
        <TouchIdKeySetup deviceId="dev_helper" nodeKind="win-helper" {...h} />
      </StoryWorld>,
    );
    const register = screen.getByRole("button", { name: "Register this key" }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Key id"), KEY);
    await userEvent.click(register);
    expect(h.onRegister).toHaveBeenCalledWith(KEY);
  });

  it("a registered key can be removed", async () => {
    const h = handlers();
    render(
      <StoryWorld>
        <TouchIdKeySetup
          deviceId="dev_helper"
          nodeKind="win-helper"
          registered={{
            deviceId: "dev_helper",
            keyId: KEY,
            registeredAt: "2026-11-02T10:00:00.000Z",
            kind: "windows_hello",
          }}
          {...h}
        />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(h.onRemove).toHaveBeenCalled());
  });
});
