import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewaysGroup } from "../src/screens/settings/GatewaysGroup.tsx";
import {
  ConnectServerEntry,
  claimProblemText,
  KeepOnNetworkChoice,
  RemoteServerSetup,
} from "../src/screens/settings/RemoteServerSetup.tsx";
import {
  type DiscoveredGateway,
  type GatewayEntry,
  type GatewaysSlot,
  UiSlotsProvider,
} from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const thisMac: GatewayEntry = {
  id: "this-mac",
  name: "This Mac",
  origin: null,
  remote: false,
  active: true,
  pinned: false,
};
const labBox: GatewayEntry = {
  id: "gw_0123456789ab",
  name: "lab-box.local",
  origin: "https://lab-box.local:7979",
  remote: true,
  active: false,
  pinned: true,
};
const waiting: DiscoveredGateway = {
  id: "lan_1",
  name: "lab-box",
  fingerprint: null,
  conflict: false,
  saved: false,
  claimable: true,
};
const setUp: DiscoveredGateway = {
  id: "lan_2",
  name: "studio",
  fingerprint: null,
  conflict: false,
  saved: false,
  claimable: false,
};

const refusal = (problem: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(problem), { code: "forbidden", details: { problem, ...extra } });

function slot(over: Partial<GatewaysSlot> = {}): GatewaysSlot {
  return {
    list: vi.fn(async () => [thisMac]),
    add: vi.fn(async () => labBox),
    remove: vi.fn(async () => {}),
    switchTo: vi.fn(async () => {}),
    repair: vi.fn(async () => {}),
    discover: vi.fn(async () => [waiting, setUp]),
    claim: vi.fn(async () => labBox),
    ...over,
  };
}

function renderSetup(gateways: GatewaysSlot, onClose = vi.fn()) {
  render(
    <StoryWorld>
      <UiSlotsProvider value={{ gateways }}>
        <RemoteServerSetup onClose={onClose} />
      </UiSlotsProvider>
    </StoryWorld>,
  );
  return onClose;
}

const typeCode = async (code: string) => {
  await userEvent.type(await screen.findByLabelText("Setup code"), code);
  await userEvent.click(screen.getByRole("button", { name: "Set up server" }));
};

describe("Set up a remote server (remote-gateway design §3.6)", () => {
  it("looks on the network at once and lists servers waiting for setup apart from set-up ones", async () => {
    const gateways = slot();
    renderSetup(gateways);
    expect(await screen.findByRole("button", { name: "Set up lab-box" })).toBeTruthy();
    expect(screen.getByText("Waiting for setup")).toBeTruthy();
    // A server that is set up already is shown, but only to say how to add it.
    expect(screen.getByText("studio")).toBeTruthy();
    expect(
      screen.getByText("Already set up. Add it with a pairing link from that server."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up studio" })).toBeNull();
    expect(gateways.discover).toHaveBeenCalledTimes(1);
  });

  it("claims a found server by its id with the code, then offers to switch to it", async () => {
    const gateways = slot();
    renderSetup(gateways);
    await userEvent.click(await screen.findByRole("button", { name: "Set up lab-box" }));
    expect(screen.getByText("Setup code for lab-box")).toBeTruthy();
    await typeCode("7k3qm-xr2td");
    expect(gateways.claim).toHaveBeenCalledWith({ id: "lan_1" }, "7k3qm-xr2td");
    expect(await screen.findByText("lab-box.local is set up")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Switch to lab-box.local" }));
    expect(gateways.switchTo).toHaveBeenCalledWith("gw_0123456789ab");
  });

  it("says to type the address when nothing is waiting, and claims a typed address", async () => {
    const gateways = slot({ discover: vi.fn(async () => []) });
    renderSetup(gateways);
    expect(
      await screen.findByText(
        "No server waiting for setup was found on this network. Type its address instead.",
      ),
    ).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Server address"), "192.168.139.196");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await typeCode("7K3QM-XR2TD");
    expect(gateways.claim).toHaveBeenCalledWith({ address: "192.168.139.196" }, "7K3QM-XR2TD");
  });

  it("works without discovery: the address is always there", async () => {
    const { discover: _d, ...rest } = slot();
    renderSetup(rest as GatewaysSlot);
    expect(await screen.findByLabelText("Server address")).toBeTruthy();
    expect(screen.queryByText("On this network")).toBeNull();
  });

  it("counts down a wrong code, and keeps the owner on the code step to try again", async () => {
    const claim = vi
      .fn<NonNullable<GatewaysSlot["claim"]>>()
      .mockRejectedValueOnce(refusal("claim_wrong_code", { attemptsLeft: 2 }))
      .mockRejectedValueOnce(refusal("claim_wrong_code", { attemptsLeft: 1 }))
      .mockResolvedValueOnce(labBox);
    renderSetup(slot({ claim }));
    await userEvent.click(await screen.findByRole("button", { name: "Set up lab-box" }));
    await typeCode("00000-00000");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That code isn't right. 2 more tries, then the server makes you wait.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Set up server" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "That code isn't right. 1 more try, then the server makes you wait.",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Set up server" }));
    expect(await screen.findByText("lab-box.local is set up")).toBeTruthy();
  });

  it("says to run psyche setup code when the code expired", async () => {
    const claim = vi.fn(async () => {
      throw refusal("claim_code_expired");
    });
    renderSetup(slot({ claim }));
    await userEvent.click(await screen.findByRole("button", { name: "Set up lab-box" }));
    await typeCode("7K3QM-XR2TD");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That code has expired. Run psyche setup code on the server for a new one.",
    );
  });

  it("Back returns to the list and Cancel leaves", async () => {
    const onClose = renderSetup(slot());
    await userEvent.click(await screen.findByRole("button", { name: "Set up lab-box" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByLabelText("Server address")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("has a sentence for every refusal the desktop sends", () => {
    const cases: [unknown, string][] = [
      [refusal("claim_wrong_code", { attemptsLeft: 0 }), "Wait a minute"],
      [refusal("claim_too_many_attempts", { retryAfterSec: 42 }), "Try again in 42 seconds."],
      [refusal("claim_bad_code"), "10 letters and numbers"],
      [refusal("claim_not_claimable"), "already set up"],
      [refusal("claim_unreachable"), "Couldn't reach a server"],
      [refusal("claim_cert_mismatch"), "certificate didn't match"],
      [refusal("claim_server_unproven"), "didn't prove it knows the code"],
      [refusal("claim_failed"), "Couldn't set up the server"],
      [refusal("claim_something_new"), "Couldn't set up the server"],
      [
        Object.assign(new Error("saved"), {
          code: "conflict",
          details: { problem: "claim_saved" },
        }),
        "saved already",
      ],
      [
        Object.assign(new Error("lan"), {
          code: "invalid_params",
          details: { problem: "claim_not_lan" },
        }),
        "Type an address on this network",
      ],
      // The native dialog was cancelled: the Gateways group's own sentence.
      [Object.assign(new Error("no"), { code: "forbidden" }), "cancelled"],
    ];
    for (const [err, text] of cases) expect(claimProblemText(err)).toContain(text);
  });
});

describe("where the setup is offered", () => {
  it("Settings → Gateways on this computer opens it in place of the add forms", async () => {
    const gateways = slot();
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways }}>
          <GatewaysGroup />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Set up a remote server" }));
    const setup = screen.getByTestId("remote-server-setup");
    expect(await within(setup).findByRole("button", { name: "Set up lab-box" })).toBeTruthy();
    expect(screen.queryByLabelText("Address")).toBeNull();
  });

  it("is not offered where the window can't claim (the web, an older desktop)", async () => {
    const { claim: _c, ...rest } = slot();
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways: rest as GatewaysSlot }}>
          <GatewaysGroup />
          <ConnectServerEntry />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    await screen.findByText("This Mac");
    expect(screen.queryByRole("button", { name: "Set up a remote server" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect to a Psyche server" })).toBeNull();
  });

  it("first run: Connect to a Psyche server opens the setup", async () => {
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways: slot() }}>
          <ConnectServerEntry />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect to a Psyche server" }));
    expect(await screen.findByRole("button", { name: "Set up lab-box" })).toBeTruthy();
  });
});

describe("onboarding on a claimed server", () => {
  it("keeps it reachable by default and says what turning it off does", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StoryWorld>
        <KeepOnNetworkChoice checked onChange={onChange} />
      </StoryWorld>,
    );
    const toggle = screen.getByRole("switch", { name: "Keep this server reachable on my network" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
    rerender(
      <StoryWorld>
        <KeepOnNetworkChoice checked={false} onChange={onChange} />
      </StoryWorld>,
    );
    expect(screen.getByText(/this computer disconnects/)).toBeTruthy();
  });
});
