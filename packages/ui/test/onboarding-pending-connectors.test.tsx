import type { Connector } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { OnboardingFlow } from "../src/screens/onboarding/OnboardingFlow.tsx";
import { ConnectProgress, useConnectorConnect } from "../src/screens/settings/connect-flow.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** #620: onboarding lists every account with its status and resumes one that is not connected. */

const NOW = "2026-10-25T10:00:00.000Z";
const account = (
  id: string,
  type: string,
  label: string,
  status: Connector["status"],
  config: Connector["config"] = {},
): Connector => ({
  id,
  type,
  label,
  account: status === "connected" ? "This Mac" : null,
  scopes: [],
  scopeMode: "read",
  actionMatrix: {},
  credentialId: null,
  status,
  config,
  lastSync: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const waitingNotes = account("con-notes", "apple:notes", "Apple Notes", "needs_auth", {
  permission: {
    kind: "automation",
    state: "notDetermined",
    settingsPath: "System Settings → Privacy & Security → Automation → Psyche (Helper) → Notes",
  },
});
const ACCOUNTS: Connector[] = [
  account("con-mail", "apple:mail", "Apple Mail", "connected"),
  waitingNotes,
  account("con-google", "google", "Google", "needs_auth"),
  account("con-imap", "imap", "Other email (IMAP)", "error"),
];

function world(connectors: Connector[], onGateway?: (g: MockGateway) => void) {
  return {
    edit: (w: { connectors: Connector[]; appleGrant?: "granted" | "denied" | "notDetermined" }) => {
      w.connectors = structuredClone(connectors);
      w.appleGrant = "granted";
    },
    ...(onGateway ? { onGateway } : {}),
  };
}

describe("onboarding accounts with their status (#620)", () => {
  it("lists every account: connected, needs permission, needs sign-in and failed", async () => {
    render(
      <StoryWorld {...world(ACCOUNTS)}>
        <OnboardingFlow onComplete={vi.fn()} defaultStep="connectors" />
      </StoryWorld>,
    );
    const list = await screen.findByRole("list", { name: "Your accounts" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
    const row = (name: string) =>
      within(list)
        .getAllByRole("listitem")
        .find((li) => li.textContent?.includes(name)) as HTMLElement;
    expect(within(row("Apple Mail")).getByText("Read only")).toBeTruthy();
    expect(within(row("Apple Notes")).getByText("Needs permission")).toBeTruthy();
    expect(
      within(row("Apple Notes")).getByRole("button", { name: "Allow Apple Notes" }),
    ).toBeTruthy();
    expect(within(row("Google")).getByText("Needs sign-in")).toBeTruthy();
    expect(within(row("Google")).getByRole("button", { name: /^Continue Google/ })).toBeTruthy();
    expect(within(row("Other email")).getByText("Not connected")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Connected (1)" })).toBeTruthy();
    // No type that already has an account is offered again.
    const offered = within(screen.getByLabelText("Connect another account"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    for (const label of [
      "Apple Mail",
      "Apple Notes",
      "Google (Gmail, Calendar, Drive)",
      "Other email (IMAP)",
    ]) {
      expect(offered).not.toContain(label);
    }
  });

  it("Allow resumes the waiting account: asks for the permission, then it is connected", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld {...world(ACCOUNTS, (g) => (gw = g))}>
        <OnboardingFlow onComplete={vi.fn()} defaultStep="connectors" />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Allow Apple Notes" }));
    expect(await screen.findByText(/Apple Notes is connected as This Mac\./)).toBeTruthy();
    const call = (gw as unknown as MockGateway).calls.find(
      (c) => c.method === "connectors.connect",
    );
    expect(call?.params).toMatchObject({
      connectorId: "con-notes",
      config: { permissionAction: "check" },
    });
  });
});

function Connect({ type, label }: { type: string; label: string }): ReactElement {
  const flow = useConnectorConnect();
  return (
    <>
      <button type="button" onClick={() => void flow.start(type, "read", label)}>
        Start
      </button>
      <ConnectProgress state={flow.state} onOpen={() => {}} onCancel={flow.cancel} />
    </>
  );
}

describe("connect flow on an existing account (#620)", () => {
  it("resumes an existing account that is not connected instead of saying it is", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld {...world([waitingNotes], (g) => (gw = g))}>
        <Connect type="apple:notes" label="Apple Notes" />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText(/Apple Notes is connected as This Mac\./)).toBeTruthy();
    expect(screen.queryByText("Apple Notes is already connected.")).toBeNull();
    const connects = (gw as unknown as MockGateway).calls.filter(
      (c) => c.method === "connectors.connect",
    );
    expect(connects.map((c) => (c.params as { connectorId?: string }).connectorId)).toEqual([
      undefined,
      "con-notes",
    ]);
  });

  it("keeps the sentence when the existing account really is connected", async () => {
    render(
      <StoryWorld {...world([account("con-notes", "apple:notes", "Apple Notes", "connected")])}>
        <Connect type="apple:notes" label="Apple Notes" />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Apple Notes is already connected.")).toBeTruthy();
  });
});
