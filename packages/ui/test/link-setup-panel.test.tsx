import type { LinkSetupStatus } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DisconnectLink,
  isLinkPage,
  LinkSetupPanel,
  type LinkSetupView,
  reasonText,
  setupErrorText,
} from "../src/screens/settings/CredentialLinkSetup.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

afterEach(cleanup);

const view = (url: string): LinkSetupView => {
  const status: LinkSetupStatus = {
    state: "signing_in",
    cli: { path: "/opt/homebrew/bin/link-cli", source: "saved" },
    candidates: [],
    signIn: { verificationUrl: url, phrase: "blue-otter-moon", expiresAt: 0 },
  };
  return {
    status,
    onConnect: async () => {},
    onSignIn: async () => {},
    onDisconnect: async () => {},
    onRecheck: () => {},
  };
};

function setup(url: string) {
  const openExternal = vi.fn(async (_url: string) => {});
  const openInPsyche = vi.fn();
  render(
    <UiSlotsProvider value={{ openExternal, openInPsyche }}>
      <LinkSetupPanel view={view(url)} />
    </UiSlotsProvider>,
  );
  return { openExternal, openInPsyche };
}

describe("Link's sign-in page", () => {
  it("always opens in the system browser, never in Psyche's own browser", () => {
    const s = setup("https://login.link.com/device?c=1");
    fireEvent.click(screen.getByRole("link", { name: "Open Link's page" }));
    expect(s.openExternal).toHaveBeenCalledWith("https://login.link.com/device?c=1");
    expect(s.openInPsyche).not.toHaveBeenCalled();
    // No menu offering the agent-driven browser either.
    expect(screen.queryByRole("menuitem", { name: "Open in Psyche" })).toBeNull();
  });

  it("opens nothing that is not on Link's own host", () => {
    const s = setup("https://login.link.com.evil.example/device");
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByText("Open Link's page"));
    expect(s.openExternal).not.toHaveBeenCalled();
    expect(s.openInPsyche).not.toHaveBeenCalled();
  });

  it.each([
    ["https://login.link.com/d", true],
    ["https://link.com/d", true],
    ["http://login.link.com/d", false],
    ["https://link.com.evil.example/", false],
    ["https://user@login.link.com/", false],
    ["javascript:alert(1)", false],
  ])("%s → %s", (u, ok) => expect(isLinkPage(u)).toBe(ok));
});

describe("why a path or a disconnect was refused", () => {
  it.each([
    ["in_psyche_home", "it is inside Psyche's own folder; install the Link CLI with npm instead"],
    ["not_link_cli", "it is not part of the Link CLI package"],
    [
      "volta_shim",
      "it is Volta's shim; use the Link CLI's own folder under Volta, or install it with npm",
    ],
  ] as const)("%s", (reason, text) => {
    expect(reasonText(reason)).toBe(text);
    expect(setupErrorText({ details: { reason } })).toBe(`Psyche won't run that program: ${text}.`);
  });

  it("explains a disconnect that waits for a payment", () => {
    expect(setupErrorText({ details: { reason: "payment_in_progress" } })).toBe(
      "A payment is still in progress. Disconnect once it has finished.",
    );
  });
});

describe("disconnecting while a payment is open", () => {
  const refused = Object.assign(new Error("conflict"), {
    details: {
      reason: "payment_in_progress",
      open: 1,
      payments: [{ merchantName: "Acme Books", merchantHost: "acme.example" }],
    },
  });

  it("offers `Disconnect anyway` only after a plain disconnect was refused, and names the payment", async () => {
    const calls: (boolean | undefined)[] = [];
    const onDisconnect = vi.fn(async (force?: boolean) => {
      calls.push(force);
      if (force !== true) throw refused;
    });
    render(<DisconnectLink onDisconnect={onDisconnect} />);
    expect(screen.queryByRole("button", { name: "Disconnect anyway" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.queryByRole("button", { name: "Disconnect anyway" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("Acme Books");
    expect(calls).toEqual([undefined]);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect anyway" }));
    await waitFor(() => expect(calls).toEqual([undefined, true]));
  });

  it("still offers it when the open payment has no merchant name", async () => {
    const nameless = Object.assign(new Error("conflict"), {
      details: { reason: "payment_in_progress", open: 1, payments: [{ merchantName: "" }] },
    });
    const calls: (boolean | undefined)[] = [];
    const onDisconnect = vi.fn(async (force?: boolean) => {
      calls.push(force);
      if (force !== true) throw nameless;
    });
    render(<DisconnectLink onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("a payment");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect anyway" }));
    await waitFor(() => expect(calls).toEqual([undefined, true]));
  });

  it("shows other failures as errors, without the force option", async () => {
    const onDisconnect = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<DisconnectLink onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/That didn't work/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect anyway" })).toBeNull();
  });
});
