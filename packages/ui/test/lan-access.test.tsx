import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { DiscoverGateways } from "../src/screens/settings/GatewaysGroup.tsx";
import { LanAccessGroup } from "../src/screens/settings/LanAccessGroup.tsx";
import {
  type DiscoveredGateway,
  type GatewayEntry,
  type GatewaysSlot,
  UiSlotsProvider,
} from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const lanInfo = (over: Record<string, unknown> = {}) => ({
  identity: { publicKey: "k".repeat(43), fingerprint: `sha256:${"ab".repeat(32)}` },
  hostName: "studio-mac",
  publicOrigin: null,
  trustedProxy: false,
  lan: {
    enabled: false,
    port: 7979,
    interfaces: [],
    listening: [],
    candidates: [
      { name: "en0", address: "192.168.1.20", isDefault: true },
      { name: "en5", address: "10.0.0.8", isDefault: false },
    ],
    origin: null,
    certSpki: null,
    advertising: false,
    problems: [],
    ...over,
  },
});

/** The fixture world has no `gateway.info`; answer it, and record every other call. */
function withInfo(info: unknown) {
  return (g: MockGateway) => {
    const request = g.request.bind(g) as (m: string, p: unknown, o?: unknown) => Promise<unknown>;
    (g as unknown as { request: typeof request }).request = (m, p, o) =>
      m === "gateway.info" ? Promise.resolve(info) : request(m, p, o);
  };
}

describe("Settings → Allow computers on this network", () => {
  it("is off by default, offers the primary network first, and writes the choice", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        onGateway={(g) => {
          gateway = g;
          withInfo(lanInfo())(g);
        }}
      >
        <LanAccessGroup />
      </StoryWorld>,
    );
    const toggle = await screen.findByRole("switch", { name: "Allow computers on this network" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Primary network")).toBeTruthy();
    expect(screen.getByText("en5 (10.0.0.8)")).toBeTruthy();
    // Nothing about listening, the certificate or discovery until it is on.
    expect(screen.queryByText("Certificate")).toBeNull();
    await userEvent.click(toggle);
    await waitFor(() => expect(gateway?.calls.some((c) => c.method === "settings.set")).toBe(true));
    const set = gateway?.calls.find((c) => c.method === "settings.set");
    expect(set?.params).toMatchObject({
      key: "gateway.lan",
      value: { enabled: true, interfaces: [], port: 7979 },
    });
  });

  it("shows where it listens, the address, the certificate to compare and what went wrong", async () => {
    render(
      <StoryWorld
        onGateway={withInfo(
          lanInfo({
            enabled: true,
            interfaces: ["en0"],
            listening: [{ address: "192.168.1.20", port: 7979 }],
            origin: "https://studio-mac.local:7979",
            certSpki: Buffer.alloc(32, 0xab).toString("base64url"),
            advertising: true,
            problems: ["unknown_interface:en9"],
          }),
        )}
      >
        <LanAccessGroup />
      </StoryWorld>,
    );
    expect(await screen.findByText("Listening on 192.168.1.20:7979")).toBeTruthy();
    expect(screen.getByText("https://studio-mac.local:7979")).toBeTruthy();
    expect(screen.getByText("abab abab abab abab abab abab")).toBeTruthy();
    expect(screen.getByText("Shown to Psyche on this network")).toBeTruthy();
    expect(screen.getByText("en9 is not a network on this Mac.")).toBeTruthy();
    expect(screen.getByText(/only on a network you trust/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace certificate" })).toBeTruthy();
  });
});

const found: DiscoveredGateway[] = [
  {
    id: "aa",
    name: "studio-mac",
    fingerprint: `sha256:${"cd".repeat(32)}`,
    conflict: false,
    saved: false,
  },
  { id: "bb", name: "mini", fingerprint: null, conflict: false, saved: true },
  { id: "cc", name: "twin", fingerprint: null, conflict: true, saved: false },
];

function slot(over: Partial<GatewaysSlot> = {}): GatewaysSlot {
  return {
    list: async () => [] as GatewayEntry[],
    add: vi.fn(),
    remove: vi.fn(),
    switchTo: vi.fn(),
    repair: vi.fn(),
    ...over,
  };
}

describe("Add a Gateway → On this network", () => {
  it("looks only when asked, lists what it found with the key it announced, and adds by id", async () => {
    const addDiscovered = vi.fn(async () => ({
      id: "gw_1",
      name: "studio-mac",
      origin: "https://studio-mac.local:7979",
      remote: true,
      active: false,
      pinned: false,
    }));
    const discover = vi.fn(async () => found);
    const onAdded = vi.fn();
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways: slot({ discover, addDiscovered }) }}>
          <DiscoverGateways onAdded={onAdded} />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    expect(discover).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look on this network" }));
    expect(await screen.findByText("studio-mac")).toBeTruthy();
    expect(screen.getByText("Key cdcd cdcd cdcd cdcd cdcd cdcd")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText(/a claim|is a claim/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add studio-mac" }));
    expect(addDiscovered).toHaveBeenCalledWith("aa");
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });

  it("says so when nothing answers, and when looking fails", async () => {
    const { rerender } = render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways: slot({ discover: async () => [] }) }}>
          <DiscoverGateways onAdded={() => {}} />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Look on this network" }));
    expect(await screen.findByText(/No Psyche found/)).toBeTruthy();
    rerender(
      <StoryWorld>
        <UiSlotsProvider
          value={{
            gateways: slot({
              discover: async () => {
                throw new Error("denied");
              },
            }),
          }}
        >
          <DiscoverGateways onAdded={() => {}} />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Look on this network" }));
    expect(await screen.findByText(/Couldn't look on the network/)).toBeTruthy();
  });

  it("draws nothing where the app cannot look (no discover)", () => {
    const { container } = render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways: slot() }}>
          <DiscoverGateways onAdded={() => {}} />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    expect(container.textContent).toBe("");
  });
});
