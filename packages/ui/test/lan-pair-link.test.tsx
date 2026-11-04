import { parsePairingLinkAny } from "@psyche/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { gatewayProblemText } from "../src/screens/settings/GatewaysGroup.tsx";
import { LanAccessGroup } from "../src/screens/settings/LanAccessGroup.tsx";
import { PairComputerGroup } from "../src/screens/settings/PairComputerGroup.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const info = (publicOrigin: string | null, lan?: Record<string, unknown>) => ({
  identity: { publicKey: "k".repeat(43), fingerprint: `sha256:${"cd34".repeat(16)}` },
  hostName: "studio-mac",
  publicOrigin,
  trustedProxy: publicOrigin !== null,
  ...(lan === undefined
    ? {}
    : {
        lan: {
          enabled: true,
          port: 7979,
          interfaces: [],
          ipv6: false,
          listening: [{ address: "192.168.1.20", port: 7979 }],
          candidates: [{ name: "en0", address: "192.168.1.20", isDefault: true }],
          origin: "https://studio-mac.local:7979",
          certSpki: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk",
          advertising: true,
          problems: [],
          ...lan,
        },
      }),
});

/** The fixture world answers `gateway.info` with a Tailscale host; answer it ourselves. */
function withInfo(value: unknown) {
  return (g: MockGateway) => {
    const request = g.request.bind(g) as (m: string, p: unknown, o?: unknown) => Promise<unknown>;
    (g as unknown as { request: typeof request }).request = (m, p, o) =>
      m === "gateway.info" ? Promise.resolve(value) : request(m, p, o);
  };
}

function renderPair(value: unknown) {
  let gateway: MockGateway | undefined;
  render(
    <StoryWorld
      onGateway={(g) => {
        gateway = g;
        withInfo(value)(g);
      }}
    >
      <PairComputerGroup now={STORY_NOW} />
    </StoryWorld>,
  );
  const created = () => gateway?.calls.filter((c) => c.method === "devices.setupToken.create");
  return { created };
}

describe("Settings → Pair another computer, on the local network", () => {
  it("offers a link for this network only while LAN is on and listening", async () => {
    renderPair(info("https://studio-mac.tail1234.ts.net"));
    await screen.findByRole("button", { name: "Make a pairing link" });
    expect(screen.queryByText("From this network")).toBeNull();
    cleanup();
    renderPair(info("https://studio-mac.tail1234.ts.net", { listening: [] }));
    await screen.findByRole("button", { name: "Make a pairing link" });
    expect(screen.queryByText("From this network")).toBeNull();
    cleanup();
    renderPair(info("https://studio-mac.tail1234.ts.net", { enabled: false }));
    await screen.findByRole("button", { name: "Make a pairing link" });
    expect(screen.queryByText("From this network")).toBeNull();
  });

  it("keeps making the address link by default, exactly as before", async () => {
    const { created } = renderPair(info("https://studio-mac.tail1234.ts.net", {}));
    await screen.findByText("From this network");
    await userEvent.click(screen.getByRole("button", { name: "Make a pairing link" }));
    const field = (await screen.findByLabelText("Pairing link")) as HTMLTextAreaElement;
    expect(created()?.[0]?.params).toEqual({
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
    expect(parsePairingLinkAny(field.value).version).toBe(1);
    expect(screen.queryByText(/same network as this Mac/)).toBeNull();
  });

  it("makes a v2 link and a QR code of it when the owner picks this network", async () => {
    const { created } = renderPair(info("https://studio-mac.tail1234.ts.net", {}));
    await userEvent.click(await screen.findByRole("radio", { name: /From this network/ }));
    await userEvent.click(screen.getByRole("button", { name: "Make a pairing link" }));
    const field = (await screen.findByLabelText("Pairing link")) as HTMLTextAreaElement;
    expect(created()?.[0]?.params).toEqual({
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      via: "lan",
    });
    const parsed = parsePairingLinkAny(field.value);
    expect(parsed.version).toBe(2);
    if (parsed.version === 2)
      expect(parsed.payload.gatewayUrl).toBe("https://studio-mac.local:7979");
    expect(screen.getByTestId("qr-code")).toBeTruthy();
    expect(screen.getByText(/same network as this Mac/)).toBeTruthy();
  });

  it("works for a Mac with no public address: the network link is the default", async () => {
    const { created } = renderPair(info(null, {}));
    const make = await screen.findByRole("button", { name: "Make a pairing link" });
    await waitFor(() => expect((make as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/Set the public address/i)).toBeNull();
    await userEvent.click(make);
    await screen.findByLabelText("Pairing link");
    expect(created()?.[0]?.params).toMatchObject({ via: "lan" });
  });
});

describe("the text for a refused link", () => {
  it("says plainly that the address is not on a local network", () => {
    const err = { code: "invalid_params", details: { problem: "link_not_lan" } };
    expect(gatewayProblemText(err)).toMatch(/isn't on a local network/);
    const old = { code: "invalid_params", details: { problem: "link_lan" } };
    expect(gatewayProblemText(old)).toMatch(/new one/);
  });
});

describe("Settings → Allow computers on this network, IPv6", () => {
  const candidates = [
    { name: "en0", address: "192.168.1.20", isDefault: true },
    { name: "en0", address: "fd12:3456:789a:1::20", isDefault: false },
    { name: "en5", address: "10.0.0.8", isDefault: false },
  ];

  it("offers IPv6 only when the Mac has a unique-local address, off by default", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        onGateway={(g) => {
          gateway = g;
          withInfo(info(null, { enabled: false, listening: [], candidates }))(g);
        }}
      >
        <LanAccessGroup />
      </StoryWorld>,
    );
    const toggle = await screen.findByRole("switch", {
      name: "Also use this network's IPv6 addresses",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // One row per network, listing every address of the interface once.
    expect(screen.getByText("en0 (192.168.1.20, fd12:3456:789a:1::20)")).toBeTruthy();
    expect(screen.getAllByText(/en0/)).toHaveLength(1);
    await userEvent.click(toggle);
    await waitFor(() => expect(gateway?.calls.some((c) => c.method === "settings.set")).toBe(true));
    expect(gateway?.calls.find((c) => c.method === "settings.set")?.params).toMatchObject({
      key: "gateway.lan",
      value: { enabled: false, interfaces: [], port: 7979, ipv6: true },
    });
  });

  it("does not show the switch on a network with no IPv6 address", async () => {
    render(
      <StoryWorld
        onGateway={withInfo(
          info(null, { enabled: false, listening: [], candidates: candidates.slice(0, 1) }),
        )}
      >
        <LanAccessGroup />
      </StoryWorld>,
    );
    await screen.findByRole("switch", { name: "Allow computers on this network" });
    expect(screen.queryByRole("switch", { name: /IPv6/ })).toBeNull();
  });

  it("names an IPv6 address whole when it cannot be bound", async () => {
    render(
      <StoryWorld
        onGateway={withInfo(
          info(null, {
            listening: [],
            candidates,
            problems: ["bind_failed:fd12:3456:789a:1::20:EADDRINUSE"],
          }),
        )}
      >
        <LanAccessGroup />
      </StoryWorld>,
    );
    expect(await screen.findByText(/Couldn't listen on fd12:3456:789a:1::20\./)).toBeTruthy();
  });
});
