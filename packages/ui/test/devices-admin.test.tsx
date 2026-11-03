import type { Device } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DevicesPanel } from "../src/screens/settings/DevicesSection.tsx";
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
  const key = (kind?: "keychain" | "enclave_file") => ({
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
    expect(screen.getByTestId("presence-key").textContent).toBe("Touch ID key (keychain)");
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
      "Touch ID key (Secure Enclave file, this build has no provisioning profile)",
    );
    rerender(
      <StoryWorld>
        <DevicesPanel devices={[mac]} pairing={[]} nodes={[helper]} />
      </StoryWorld>,
    );
    expect(screen.queryByTestId("presence-key")).toBeNull();
  });
});
