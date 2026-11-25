import type { ApprovalRequest, Grant } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import {
  grantExecutable,
  grantSubject,
  PermissionsPanel,
} from "../src/screens/settings/PermissionsSection.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * "Always allow <program> in <folder>" on a host-command card, and its Settings row. Each absence
 * is paired with a case where the option shows.
 */

const NOW = Date.parse(FIXTURE_NOW);
const OFFER = {
  sandbox: "srt",
  hostProgram: {
    program: "rg",
    executable: "/opt/homebrew/bin/rg",
    sha256: "sha256:abc",
    folder: "/Users/me/project",
    argv: null,
  },
};

function hostApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "exec_host",
    summary: "Run `rg foo` on this Mac",
    sideEffect: "destructive",
    scopesOffered: ["once", "always"],
    deviceOnly: true,
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

describe("host-command card: Always allow <program> in <folder>", () => {
  it("answers once with hostProgram when the Gateway offered it", async () => {
    const onAnswer = show(hostApproval({ details: OFFER }));
    // The program in its folder is the one second choice, labelled with exactly that reach.
    await userEvent.click(
      screen.getByRole("button", { name: "Always allow rg in /Users/me/project" }),
    );
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "once", { hostProgram: true }),
    );
  });

  it("does not offer it without the Gateway's offer (control: with it, it shows)", () => {
    show(hostApproval({ details: { sandbox: "srt" } }));
    expect(screen.queryByRole("button", { name: /^Always allow rg in/ })).toBeNull();
    // The card still offers its own exact-command Always, so the control is that this one differs.
    expect(screen.getByRole("button", { name: "Always allow this exact command" })).toBeTruthy();
  });

  it("a plain Allow once sends no hostProgram", async () => {
    const onAnswer = show(hostApproval({ details: OFFER }));
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "once", undefined));
  });
});

function programGrant(): Grant {
  return {
    id: "grt_prog_1",
    kind: "exec_host",
    scope: "always",
    grantKey: "k",
    subject: { hostProgram: OFFER.hostProgram },
    binding: null,
    expiresAt: "2026-12-10T00:00:00Z",
    useCount: 0,
    lastUsedAt: null,
    createdFromApprovalId: "apr_1",
    taskId: null,
    createdAt: "2026-11-10T09:00:00Z",
    revokedAt: null,
  };
}

describe("Settings → Permissions: program grants", () => {
  it("names the program and folder, and Revoke revokes it", async () => {
    expect(grantSubject(programGrant())).toBe("rg in /Users/me/project, any arguments");
    expect(grantExecutable(programGrant())).toBe(OFFER.hostProgram.executable);
    expect(grantExecutable({ ...programGrant(), kind: "exec" })).toBeNull();
    const onRevoke = vi.fn();
    render(
      <UiSlotsProvider value={{}}>
        <PermissionsPanel
          values={{}}
          onChange={vi.fn()}
          connectors={[]}
          grants={[programGrant()]}
          onRevoke={onRevoke}
          now={NOW}
        />
      </UiSlotsProvider>,
    );
    // The Allowed list says it in plain words; the ledger under Details keeps the old row.
    expect(screen.getByText("Always · runs rg in /Users/me/project, any arguments")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove rg in /Users/me/project, any arguments" }),
    );
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });
});
