import { encodePairingLink, PsycheError, parsePairingLink } from "@psyche/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { encode } from "uqr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QrCode } from "../src/components/QrCode.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { AddGatewayForm } from "../src/screens/settings/GatewaysGroup.tsx";
import { PairComputerGroup } from "../src/screens/settings/PairComputerGroup.tsx";
import { SettingsApprovalContext } from "../src/screens/settings/shared.tsx";
import { type GatewayEntry, type GatewaysSlot, UiSlotsProvider } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const LINK = encodePairingLink({
  gatewayUrl: "https://studio-mac.tail1234.ts.net",
  gatewayFingerprint: `sha256:${"cd34".repeat(16)}`,
  setupToken: `pst_${Buffer.alloc(32, 5).toString("base64url")}`,
  hostName: "studio-mac",
});

describe("the QR code", () => {
  it("draws the link's own modules in this window, with a quiet zone", () => {
    const { container } = render(<QrCode value={LINK} label="QR code" />);
    const svg = container.querySelector("svg");
    const matrix = encode(LINK, { ecc: "M", border: 0 }).data;
    expect(svg?.getAttribute("viewBox")).toBe(`0 0 ${matrix.length + 8} ${matrix.length + 8}`);
    // Every dark module is in the path, and nothing else is.
    const dark = matrix.flat().filter(Boolean).length;
    const d = container.querySelector("path")?.getAttribute("d") ?? "";
    const covered = [...d.matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(covered).toBe(dark);
    expect(svg?.getAttribute("role")).toBe("img");
    expect(container.querySelector("image, foreignObject, a")).toBeNull();
  });

  it("draws nothing for text no QR code can hold, rather than a wrong code", () => {
    const { container } = render(<QrCode value={"x".repeat(9000)} label="QR code" />);
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("Settings → Pair another computer (the Host)", () => {
  function setup() {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        onGateway={(g) => {
          gateway = g;
        }}
      >
        <PairComputerGroup now={STORY_NOW} />
      </StoryWorld>,
    );
    const created = () => gateway?.calls.filter((c) => c.method === "devices.setupToken.create");
    return { created };
  }

  it("starts with read, write and approvals ticked and admin off (decision G1)", async () => {
    setup();
    const box = (name: string) => screen.getByRole("checkbox", { name });
    await screen.findByRole("button", { name: "Make a pairing link" });
    expect(box("Read").getAttribute("aria-checked")).toBe("true");
    expect(box("Write").getAttribute("aria-checked")).toBe("true");
    expect(box("Approvals").getAttribute("aria-checked")).toBe("true");
    expect(box("Admin").getAttribute("aria-checked")).toBe("false");
    // There is no node scope to tick.
    expect(screen.queryByRole("checkbox", { name: "Node" })).toBeNull();
  });

  it("asks for exactly the ticked scopes and shows the link, a QR code of it, and when it ends", async () => {
    const { created } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Make a pairing link" }));
    const field = (await screen.findByLabelText("Pairing link")) as HTMLTextAreaElement;
    expect(created()?.[0]?.params).toEqual({
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
    const link = parsePairingLink(field.value);
    expect(link.gatewayUrl).toBe("https://studio-mac.tail1234.ts.net");
    expect(screen.getByTestId("qr-code")).toBeTruthy();
    expect(screen.getAllByText(/Expires in 10 min/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Once used, that computer gets: Read, Write, Approvals\./),
    ).toBeTruthy();
    expect(screen.getByText(/cd34 cd34 cd34 cd34 cd34 cd34/)).toBeTruthy();
  });

  it("gives admin only when the owner ticks it", async () => {
    const { created } = setup();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Admin" }));
    await userEvent.click(screen.getByRole("button", { name: "Make a pairing link" }));
    await screen.findByLabelText("Pairing link");
    expect(created()?.[0]?.params).toEqual({
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    });
  });

  it("takes the link and QR code off the screen once the token has been used", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        onGateway={(g) => {
          gateway = g;
        }}
      >
        <PairComputerGroup now={STORY_NOW} />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Make a pairing link" }));
    await screen.findByLabelText("Pairing link");
    const tokens = (gateway as unknown as { setupTokens: { status: string }[] }).setupTokens;
    for (const token of tokens) token.status = "used";
    await waitFor(() => expect(screen.queryByTestId("qr-code")).toBeNull(), { timeout: 8000 });
    expect(screen.queryByLabelText("Pairing link")).toBeNull();
    expect(screen.getByText(/no longer valid/)).toBeTruthy();
  }, 15000);

  it("lists unused links and revokes one", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Make a pairing link" }));
    await screen.findByLabelText("Pairing link");
    const list = await screen.findByRole("list", { name: "Unused pairing links" });
    expect(list.textContent).toContain("Not used yet");
    await userEvent.click(screen.getByRole("button", { name: /Revoke the pairing link made/ }));
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Unused pairing links" })).toBeNull(),
    );
    expect(screen.queryByLabelText("Pairing link")).toBeNull();
  });
});

describe("making a link needs the owner's presence once the Gateway can verify it", () => {
  it("hands the approval to the Settings banner and makes the link when it is approved", async () => {
    const asked = vi.fn();
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        onGateway={(g) => {
          gateway = g;
          const request = g.request.bind(g) as (
            m: string,
            p: unknown,
            o?: unknown,
          ) => Promise<unknown>;
          // The first create comes back "approval_required", as it does with a verifier.
          (g as unknown as { request: unknown }).request = (
            m: string,
            p: { approvalId?: string },
            o?: unknown,
          ) =>
            m === "devices.setupToken.create" && p.approvalId === undefined
              ? Promise.reject(
                  new PsycheError("approval_required", "needs approval", {
                    details: { approvalId: "ap_1" },
                  }),
                )
              : request(m, p, o);
        }}
      >
        <SettingsApprovalContext.Provider value={asked}>
          <PairComputerGroup now={STORY_NOW} />
        </SettingsApprovalContext.Provider>
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Make a pairing link" }));
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    const pending = asked.mock.calls[0]?.[0] as {
      approvalId: string;
      label: string;
      retry: (id: string) => Promise<unknown>;
    };
    expect(pending).toMatchObject({ approvalId: "ap_1", label: "Pair another computer" });
    expect(screen.queryByLabelText("Pairing link")).toBeNull();
    await pending.retry("ap_1");
    expect(await screen.findByLabelText("Pairing link")).toBeTruthy();
    const creates = gateway?.calls.filter((c) => c.method === "devices.setupToken.create");
    expect(creates?.at(-1)?.params).toEqual({
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      approvalId: "ap_1",
    });
  });
});

describe("Add a Gateway with a pairing link", () => {
  const added: GatewayEntry = {
    id: "gw_0123456789ab",
    name: "studio-mac",
    origin: "https://studio-mac.tail1234.ts.net",
    remote: true,
    active: false,
    pinned: true,
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
  function form(gateways: GatewaysSlot, onAdded = vi.fn()) {
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways }}>
          <AddGatewayForm onAdded={onAdded} />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    return onAdded;
  }

  it("sends a pasted link to addLink, not to the address path", async () => {
    const gateways = slot();
    const onAdded = form(gateways);
    await userEvent.click(screen.getByLabelText("Pairing link or address"));
    await userEvent.paste(LINK);
    expect((screen.getByLabelText("Name (optional)") as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Add Gateway" }));
    expect(gateways.addLink).toHaveBeenCalledWith(LINK);
    expect(gateways.add).not.toHaveBeenCalled();
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(added, true));
  });

  it("does not overwrite what the owner already typed when a link arrives from the OS", async () => {
    let arrive: () => void = () => {};
    const gateways = slot({
      takePendingLink: vi.fn(async () => (arrive === undefined ? null : pending)),
      onPendingLink: (cb) => {
        arrive = cb;
        return () => {};
      },
    });
    let pending: string | null = null;
    form(gateways);
    await userEvent.type(screen.getByLabelText("Pairing link or address"), "studio-mac.tail1234");
    pending = LINK;
    arrive();
    expect(await screen.findByText("A new pairing link arrived. Use it?")).toBeTruthy();
    expect((screen.getByLabelText("Pairing link or address") as HTMLInputElement).value).toBe(
      "studio-mac.tail1234",
    );
    await userEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect((screen.getByLabelText("Pairing link or address") as HTMLInputElement).value).toBe(LINK);
    expect(gateways.addLink).not.toHaveBeenCalled();
  });

  it("keeps typed addresses on the address path", async () => {
    const gateways = slot();
    const onAdded = form(gateways);
    await userEvent.type(
      screen.getByLabelText("Pairing link or address"),
      "studio-mac.tail1234.ts.net",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add Gateway" }));
    expect(gateways.add).toHaveBeenCalledWith("studio-mac.tail1234.ts.net", undefined);
    expect(gateways.addLink).not.toHaveBeenCalled();
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(added, false));
  });

  it("shows a link the OS opened for review and adds nothing until the owner presses Add", async () => {
    const gateways = slot({ takePendingLink: vi.fn(async () => LINK) });
    form(gateways);
    const field = (await screen.findByDisplayValue(LINK)) as HTMLInputElement;
    expect(field).toBeTruthy();
    expect(screen.getByText(/Opened from a pairing link/)).toBeTruthy();
    expect(gateways.addLink).not.toHaveBeenCalled();
    expect(gateways.add).not.toHaveBeenCalled();
  });

  it("says why a link was refused, in the owner's words", async () => {
    const gateways = slot({
      addLink: vi.fn(async () => {
        throw Object.assign(new Error("pairing link"), {
          code: "invalid_params",
          details: { problem: "link_extra_fields" },
        });
      }),
    });
    form(gateways);
    await userEvent.click(screen.getByLabelText("Pairing link or address"));
    await userEvent.paste(LINK);
    await userEvent.click(screen.getByRole("button", { name: "Add Gateway" }));
    expect(
      await screen.findByText(
        "That pairing link has something Psyche doesn't understand, so it isn't used.",
      ),
    ).toBeTruthy();
  });
});
