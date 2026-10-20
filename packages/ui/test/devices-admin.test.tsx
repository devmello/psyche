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
  });
});
