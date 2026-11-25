import type { ApprovalRequest, Grant } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { PermissionsPanel, trustedSiteOf } from "../src/screens/settings/PermissionsSection.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * "Always for this site" on a first-read card, and Settings → Permissions → Trusted sites.
 * Each absence is paired with a case where the thing shows (a negative-only test passes when the
 * feature is broken).
 */

const NOW = Date.parse(FIXTURE_NOW);

function readApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "new_origin",
    summary: "Open docs.example.org",
    sideEffect: "read",
    scopesOffered: ["once", "task", "site", "session", "always"],
    deviceOnly: false,
    requiresAuthentication: false,
    taint: false,
    ...over,
  } as ApprovalRequest;
}

function show(approval: ApprovalRequest, onAnswer = vi.fn()) {
  render(
    <UiSlotsProvider value={{}}>
      <ApprovalCard approval={approval} canAnswer now={NOW} armDelayMs={0} onAnswer={onAnswer} />
    </UiSlotsProvider>,
  );
  return onAnswer;
}

const offered = { trustSite: { origin: "https://docs.example.org", subdomains: true } };
const allow = () => screen.getByRole("button", { name: "Allow" });

describe("first-read card: Always for this site", () => {
  it("offers it when the Gateway offered it, and answers once with trustSite", async () => {
    const onAnswer = show(readApproval({ details: offered }));
    // The card does not say what a chat-long grant would cover (no origin on it), so the site
    // choice is the second one; the vague chat choice stays under More options.
    expect(screen.getByTestId("approval-second-choice").textContent).toBe(
      "Always for this site (docs.example.org)",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Always for this site (docs.example.org)" }),
    );
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "once", { trustSite: "origin" }),
    );
  });

  it("the subdomain choice sends subdomains", async () => {
    const onAnswer = show(readApproval({ details: offered }));
    await userEvent.click(screen.getByRole("button", { name: "More options…" }));
    await userEvent.click(
      screen.getByRole("button", {
        name: "Always for this site and its subdomains (docs.example.org)",
      }),
    );
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "once", { trustSite: "subdomains" }),
    );
  });

  it("does not offer the subdomain choice when the card did not", async () => {
    show(
      readApproval({
        details: { trustSite: { origin: "https://project.example.org", subdomains: false } },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "More options…" }));
    expect(screen.getByRole("button", { name: /^Always for this site \(/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /and its subdomains/ })).toBeNull();
  });

  it("does not offer it without the Gateway's offer (control: with it, it shows)", async () => {
    show(readApproval({ details: {} }));
    await userEvent.click(screen.getByRole("button", { name: "More options…" }));
    expect(screen.queryByRole("button", { name: /Always for this site \(/ })).toBeNull();
    // The control: the same menu does list the card's own site choice.
    expect(screen.getByRole("button", { name: /^Always allow/ })).toBeTruthy();
  });

  it("a plain Allow once sends no trustSite", async () => {
    const onAnswer = show(readApproval({ details: offered }));
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "once", undefined));
  });
});

function trustedGrant(over: Partial<Grant> = {}): Grant {
  return {
    id: "grt_trusted_1",
    kind: "new_origin",
    scope: "always",
    grantKey: "k",
    subject: {
      trustedSite: { origin: "https://docs.example.org", subdomains: false },
      target: { kind: "origin", value: "https://docs.example.org" },
    },
    binding: null,
    expiresAt: "2027-06-01T00:00:00Z",
    useCount: 0,
    lastUsedAt: null,
    createdFromApprovalId: "apr_1",
    taskId: null,
    createdAt: "2026-11-10T09:00:00Z",
    revokedAt: null,
    ...over,
  };
}

function panel(grants: Grant[], onRevoke = vi.fn(), onChange = vi.fn(), values = {}) {
  render(
    <UiSlotsProvider value={{}}>
      <PermissionsPanel
        values={values}
        onChange={onChange}
        connectors={[]}
        grants={grants}
        onRevoke={onRevoke}
        now={NOW}
      />
    </UiSlotsProvider>,
  );
  return { onRevoke, onChange };
}

describe("Settings → Permissions: trusted sites", () => {
  it("lists each trusted origin with when it was added, and Remove revokes it", async () => {
    const { onRevoke } = panel([
      trustedGrant(),
      trustedGrant({
        id: "grt_trusted_2",
        subject: { trustedSite: { origin: "https://example.com", subdomains: true } },
      }),
    ]);
    // Each entry also appears in the grants ledger; the Trusted sites list has the Added line.
    expect(screen.getAllByText("docs.example.org").length).toBeGreaterThan(0);
    expect(screen.getAllByText("example.com and its subdomains").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Added /)).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove docs.example.org from trusted sites" }),
    );
    expect(onRevoke).toHaveBeenCalledWith(expect.objectContaining({ id: "grt_trusted_1" }));
  });

  it("an empty list says so (control: the list above shows entries)", () => {
    panel([]);
    expect(screen.getByText(/No trusted sites yet/)).toBeTruthy();
  });

  it("a revoked entry and an ordinary site grant are not listed as trusted", () => {
    expect(trustedSiteOf(trustedGrant())).not.toBeNull();
    expect(trustedSiteOf(trustedGrant({ subject: { origin: "https://acme.com" } }))).toBeNull();
    panel([trustedGrant({ revokedAt: "2026-11-11T00:00:00Z" })]);
    expect(screen.getByText(/No trusted sites yet/)).toBeTruthy();
  });

  it("the optional sensitive categories are on by default and toggle their own setting", async () => {
    const { onChange } = panel([]);
    const gov = screen.getByRole("switch", { name: "Ask before reading government sites" });
    const icloud = screen.getByRole("switch", { name: "Ask before reading iCloud" });
    expect(gov.getAttribute("aria-checked")).toBe("true");
    expect(icloud.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(gov);
    expect(onChange).toHaveBeenCalledWith("permissions.sensitive.government", false);
    expect(onChange).not.toHaveBeenCalledWith("permissions.sensitive.icloud", expect.anything());
  });

  it("shows a category off when its setting is false (control for the default)", () => {
    panel([], vi.fn(), vi.fn(), { "permissions.sensitive.icloud": false });
    expect(
      screen
        .getByRole("switch", { name: "Ask before reading iCloud" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});
