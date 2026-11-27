import { PsycheError, parsePairingLinkAny } from "@psyche/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { DevicesSection } from "../src/screens/settings/DevicesSection.tsx";
import { PairIphoneGroup } from "../src/screens/settings/PairComputerGroup.tsx";
import { SettingsApprovalContext } from "../src/screens/settings/shared.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const LAN_ON = {
  enabled: true,
  port: 7979,
  interfaces: [] as string[],
  ipv6: false,
  listening: [{ address: "192.168.1.20", port: 7979 }],
  candidates: [{ name: "en0", address: "192.168.1.20", isDefault: true }],
  origin: "https://studio-mac.local:7979",
  certSpki: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk",
  advertising: true,
  problems: [] as string[],
};

const LAN_OFF = { ...LAN_ON, enabled: false, listening: [], origin: null, certSpki: null };

/**
 * A Gateway whose network listener follows the `gateway.lan` setting: writing it switches the
 * answer of `gateway.info`, as the real Gateway does when it opens or closes its sockets.
 */
function lanGateway(initial: typeof LAN_ON | typeof LAN_OFF, refuseFirstSet = false) {
  let lan: Record<string, unknown> = { ...initial };
  let refused = !refuseFirstSet;
  return (g: MockGateway) => {
    const request = g.request.bind(g) as (m: string, p: unknown, o?: unknown) => Promise<unknown>;
    (g as unknown as { request: typeof request }).request = (m, p, o) => {
      if (m === "gateway.info") {
        return Promise.resolve({
          identity: { publicKey: "k".repeat(43), fingerprint: `sha256:${"cd34".repeat(16)}` },
          hostName: "studio-mac",
          publicOrigin: null,
          trustedProxy: false,
          lan,
        });
      }
      if (m === "settings.set") {
        const params = p as { key: string; value: Record<string, unknown>; approvalId?: string };
        if (params.key === "gateway.lan") {
          if (!refused && params.approvalId === undefined) {
            refused = true;
            return Promise.reject(
              new PsycheError("approval_required", "needs approval", {
                details: { approvalId: "ap_lan" },
              }),
            );
          }
          lan = params.value.enabled === true ? { ...LAN_ON, ...params.value } : { ...LAN_OFF };
        }
      }
      return request(m, p, o);
    };
  };
}

function renderPair(
  initial: typeof LAN_ON | typeof LAN_OFF,
  opts: { refuseFirstSet?: boolean; asked?: (p: unknown) => void } = {},
) {
  let gateway: MockGateway | undefined;
  const prepare = lanGateway(initial, opts.refuseFirstSet);
  const group = <PairIphoneGroup now={STORY_NOW} />;
  render(
    <StoryWorld
      onGateway={(g) => {
        gateway = g;
        prepare(g);
      }}
    >
      {opts.asked ? (
        <SettingsApprovalContext.Provider value={opts.asked}>
          {group}
        </SettingsApprovalContext.Provider>
      ) : (
        group
      )}
    </StoryWorld>,
  );
  const calls = (method: string) => gateway?.calls.filter((c) => c.method === method) ?? [];
  return { calls };
}

describe("Settings → Pair iPhone", () => {
  it("turns on the network listener in the same tap, then shows the QR code and link", async () => {
    const { calls } = renderPair(LAN_OFF);
    await userEvent.click(await screen.findByRole("button", { name: "Pair iPhone" }));
    const field = (await screen.findByLabelText("Pairing link")) as HTMLTextAreaElement;
    // The listener was switched on first, keeping the owner's interface choices.
    const writes = calls("settings.set").filter(
      (c) => (c.params as { key: string }).key === "gateway.lan",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.params).toMatchObject({
      key: "gateway.lan",
      value: { enabled: true, interfaces: [], port: 7979, ipv6: false },
    });
    // The link is for this network and gives a phone what pairing already gives one: no admin.
    expect(calls("devices.setupToken.create")[0]?.params).toEqual({
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      via: "lan",
    });
    expect(parsePairingLinkAny(field.value).version).toBe(2);
    expect(screen.getByTestId("qr-code")).toBeTruthy();
    expect(screen.getByText(/Open Psyche on your iPhone and scan this code/)).toBeTruthy();
    // It says plainly that network access is now on, and offers to turn it off.
    expect(screen.getByText(/Pairing turned on network access/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn network access off" })).toBeTruthy();
  });

  it("turns network access off again from the same group", async () => {
    const { calls } = renderPair(LAN_OFF);
    await userEvent.click(await screen.findByRole("button", { name: "Pair iPhone" }));
    await userEvent.click(await screen.findByRole("button", { name: "Turn network access off" }));
    await screen.findByText("Network access is off again.");
    const writes = calls("settings.set").filter(
      (c) => (c.params as { key: string }).key === "gateway.lan",
    );
    expect(writes.at(-1)?.params).toMatchObject({ value: { enabled: false } });
    // The link made for the network goes away with it.
    expect(screen.queryByLabelText("Pairing link")).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn network access off" })).toBeNull();
  });

  it("leaves the listener alone when it is already on, and says nothing about turning it on", async () => {
    const { calls } = renderPair(LAN_ON);
    await userEvent.click(await screen.findByRole("button", { name: "Pair iPhone" }));
    await screen.findByLabelText("Pairing link");
    expect(
      calls("settings.set").filter((c) => (c.params as { key: string }).key === "gateway.lan"),
    ).toHaveLength(0);
    expect(screen.queryByText(/Pairing turned on network access/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn network access off" })).toBeNull();
  });

  it("waits for the approval before turning network access on, and makes no link meanwhile", async () => {
    const asked = vi.fn();
    const { calls } = renderPair(LAN_OFF, { refuseFirstSet: true, asked });
    await userEvent.click(await screen.findByRole("button", { name: "Pair iPhone" }));
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    const pending = asked.mock.calls[0]?.[0] as {
      key: string;
      approvalId: string;
      retry: (id: string) => Promise<unknown>;
    };
    expect(pending).toMatchObject({ key: "gateway.lan", approvalId: "ap_lan" });
    expect(calls("devices.setupToken.create")).toHaveLength(0);
    expect(screen.queryByLabelText("Pairing link")).toBeNull();
    await pending.retry("ap_lan");
    expect(await screen.findByLabelText("Pairing link")).toBeTruthy();
    expect(calls("devices.setupToken.create")).toHaveLength(1);
  });
});

describe("Settings → Devices, in plain words", () => {
  it("leads with Pair iPhone and has no Linux computers group or jargon", async () => {
    render(
      <StoryWorld onGateway={lanGateway(LAN_OFF)}>
        <DevicesSection now={STORY_NOW} />
      </StoryWorld>,
    );
    expect(await screen.findByRole("button", { name: "Pair iPhone" })).toBeTruthy();
    // Positive control: the page itself rendered.
    expect(await screen.findByText("The computers and phones that can use Psyche.")).toBeTruthy();
    expect(screen.queryByText(/Add a Linux computer/)).toBeNull();
    expect(screen.queryByText(/Computers Psyche can use/)).toBeNull();
    expect(screen.queryByText(/devices & nodes/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: /nodes/i })).toBeNull();
    expect(screen.queryByText(/\bscopes\b/i)).toBeNull();
    expect(screen.queryByText(/client and node/i)).toBeNull();
    expect(screen.queryByText(/Gateway key|Gateway's key/)).toBeNull();
  });
});
