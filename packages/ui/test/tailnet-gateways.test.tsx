import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddGatewayForm } from "../src/screens/settings/GatewaysGroup.tsx";
import {
  type GatewayEntry,
  type GatewaysSlot,
  type TailnetListing,
  UiSlotsProvider,
} from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const PEER = {
  id: "0123456789abcdef",
  name: "studio-mac",
  dnsName: "studio-mac.tail1234.ts.net",
  online: true,
  tagged: true,
};
const added: GatewayEntry = {
  id: "gw_1",
  name: "studio-mac",
  origin: "https://studio-mac.tail1234.ts.net",
  remote: true,
  active: false,
  pinned: false,
};

function slot(over: Partial<GatewaysSlot> = {}): GatewaysSlot {
  return {
    list: async () => [],
    add: vi.fn(async () => added),
    addLink: vi.fn(async () => added),
    remove: vi.fn(async () => {}),
    switchTo: vi.fn(async () => {}),
    repair: vi.fn(async () => {}),
    ...over,
  };
}

function mount(gateways: GatewaysSlot) {
  const onAdded = vi.fn();
  render(
    <StoryWorld>
      <UiSlotsProvider value={{ gateways }}>
        <AddGatewayForm onAdded={onAdded} />
      </UiSlotsProvider>
    </StoryWorld>,
  );
  return onAdded;
}

const listing = (over: Partial<TailnetListing>): TailnetListing => ({
  state: "ok",
  peers: [PEER],
  ...over,
});

describe("Add a Gateway: on your tailnet", () => {
  it("is hidden when Tailscale is not installed", async () => {
    const gateways = slot({ tailnet: vi.fn(async () => listing({ state: "missing", peers: [] })) });
    mount(gateways);
    await waitFor(() => expect(gateways.tailnet).toHaveBeenCalledWith(false));
    expect(screen.queryByText("On your tailnet")).toBeNull();
    // The typed address field is still there, above which the list would have been.
    expect(screen.getByLabelText("Pairing link or address")).toBeTruthy();
  });

  it("says Tailscale is off, and offers Open Tailscale and Try again", async () => {
    const gateways = slot({
      tailnet: vi.fn(async () => listing({ state: "off", peers: [] })),
      openTailscale: vi.fn(async () => {}),
    });
    mount(gateways);
    expect(await screen.findByText("Tailscale is off on this computer.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open Tailscale" }));
    expect(gateways.openTailscale).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(gateways.tailnet).toHaveBeenCalledTimes(2);
  });

  it("shows loading first, then the tagged peers without contacting any peer", async () => {
    let finish: (l: TailnetListing) => void = () => {};
    const gateways = slot({
      tailnet: vi.fn(
        () =>
          new Promise<TailnetListing>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    mount(gateways);
    expect(screen.getByText("Checking Tailscale…")).toBeTruthy();
    finish(listing({}));
    expect(await screen.findByText("studio-mac")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(gateways.tailnet).toHaveBeenCalledWith(false);
    expect(gateways.tailnet).not.toHaveBeenCalledWith(true);
  });

  it("says so when the tailnet has no Psyche, and looks for untagged peers on the owner's click", async () => {
    const gateways = slot({
      tailnet: vi
        .fn()
        .mockResolvedValueOnce(listing({ peers: [] }))
        .mockResolvedValueOnce(listing({})),
    });
    mount(gateways);
    expect(await screen.findByText(/No Psyche found on your tailnet/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Look for Psyche on my tailnet" }));
    expect(gateways.tailnet).toHaveBeenLastCalledWith(true);
  });

  it("Connect goes through the same add as a typed address, never a pre-trusted one", async () => {
    const gateways = slot({
      tailnet: vi.fn(async () => listing({})),
      addTailnet: vi.fn(async () => added),
    });
    const onAdded = mount(gateways);
    await userEvent.click(await screen.findByRole("button", { name: "Connect to studio-mac" }));
    expect(gateways.addTailnet).toHaveBeenCalledWith(PEER.id);
    // It sends an id, not an address: the address comes from the listing main made.
    expect(gateways.add).not.toHaveBeenCalled();
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(added, false));
  });

  it("reports a refused Connect in the sheet", async () => {
    const gateways = slot({
      tailnet: vi.fn(async () => listing({})),
      addTailnet: vi.fn(async () => {
        throw Object.assign(new Error("declined"), { code: "forbidden" });
      }),
    });
    const onAdded = mount(gateways);
    await userEvent.click(await screen.findByRole("button", { name: "Connect to studio-mac" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onAdded).not.toHaveBeenCalled();
  });
});
