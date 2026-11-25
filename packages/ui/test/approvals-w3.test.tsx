import type { ApprovalRequest, Grant, GrantScope } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalsPanel } from "../src/agent/ApprovalsPanel.tsx";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import {
  answerFor,
  buildChoices,
  defaultAllow,
  inlineChoices,
  splitChoices,
} from "../src/blocks/approval-choice.ts";
import { plainEffect, voidedText } from "../src/blocks/approval-plain.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, type FixtureWorld, IDS } from "../src/fixtures/index.ts";
import { InboxScreen } from "../src/screens/inbox/InboxScreen.tsx";
import { AllowedList, allowedGroupOf } from "../src/screens/settings/AllowedList.tsx";
import { PermissionsPanel } from "../src/screens/settings/PermissionsSection.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Approvals wave W3 (desktop): the one second choice, the plain header and sentences, shown once,
 * the Allowed list and Undo. Each absence is paired with a case where the thing does show.
 */

const NOW = Date.parse(FIXTURE_NOW);

function card(over: Partial<ApprovalRequest>): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "connector_action",
    sideEffect: "write",
    summary: "Create the page “Plan” in Notion",
    details: { tool: "mcp__notion__create_page", params: {}, target: "Plan" },
    target: undefined,
    deviceOnly: false,
    requiresAuthentication: false,
    taint: false,
    scopesOffered: ["once", "always"],
    status: "pending",
    ...over,
  } as ApprovalRequest;
}

const site = (over: Partial<ApprovalRequest> = {}) =>
  card({
    kind: "new_origin",
    sideEffect: "read",
    summary: "Open docs.example.org",
    details: {},
    target: { kind: "origin", value: "https://docs.example.org", display: "docs.example.org" },
    scopesOffered: ["once", "task", "site", "session", "always"],
    ...over,
  });

interface Row {
  name: string;
  approval: ApprovalRequest;
  /** The scope Allow sends. */
  allow: GrantScope;
  /** The one second choice: its scope value and exact label, or null for none. */
  second: { value: string; label: string } | null;
  /** The values under More options. */
  more: string[];
}

const TABLE: Row[] = [
  {
    name: "a card that offers only once shows Deny and Allow only",
    approval: card({ scopesOffered: ["once"] }),
    allow: "once",
    second: null,
    more: [],
  },
  {
    name: "the chat scope wins over every always",
    approval: site(),
    allow: "once",
    second: { value: "session", label: "For the rest of this chat" },
    more: ["task", "always"],
  },
  {
    name: "an MCP tool's always names the tool and says any arguments",
    approval: card({}),
    allow: "once",
    second: {
      value: "always",
      label: "Always allow Notion › create page, with any arguments",
    },
    more: [],
  },
  {
    name: "a host program in a folder is the narrowest always",
    approval: card({
      kind: "exec_host",
      sideEffect: "write",
      details: {
        sandbox: "srt",
        hostProgram: { program: "pnpm", folder: "/Users/me/x", argv: null },
      },
    }),
    allow: "once",
    second: { value: "program", label: "Always allow pnpm in /Users/me/x" },
    more: ["always"],
  },
  {
    name: "an email send names the whole recipient set and the account",
    approval: card({
      kind: "send_email",
      grantKey: "send_email:me@x.com:bob@x.com",
      target: { kind: "recipient", value: "bob@x.com" },
      details: { tool: "gmail_send", params: {} },
    }),
    allow: "once",
    second: { value: "always", label: "Always allow sending to bob@x.com from me@x.com" },
    more: [],
  },
  {
    name: "a command card's always says the exact command",
    approval: card({ kind: "exec", details: { argv: ["pnpm", "test"] } }),
    allow: "once",
    second: { value: "always", label: "Always allow this exact command" },
    more: [],
  },
  {
    name: "a purchase never shows an always, even if the card offered one",
    approval: card({
      kind: "purchase",
      sideEffect: "financial",
      scopesOffered: ["once", "session", "always"],
    }),
    allow: "once",
    second: null,
    more: [],
  },
  {
    name: "a financial call never shows an always either",
    approval: card({ sideEffect: "financial", scopesOffered: ["once", "task", "always"] }),
    allow: "once",
    second: null,
    more: [],
  },
  {
    name: "a card without once sends its narrowest scope on Allow",
    approval: card({ scopesOffered: ["task", "always"], details: { tool: "gmail.archive" } }),
    allow: "task",
    second: { value: "always", label: "Always allow Gmail › archive, with any arguments" },
    more: [],
  },
];

describe("the second choice: offered scopes → the scope sent and its label", () => {
  it.each(TABLE)("$name", ({ approval, allow, second, more }) => {
    const choices = buildChoices(approval, approval.scopesOffered, { site: null });
    const parts = splitChoices(
      choices,
      defaultAllow(approval),
      approval.kind === "purchase" || approval.sideEffect === "financial",
    );
    expect(defaultAllow(approval)).toBe(allow);
    expect(
      parts.second === null ? null : { value: parts.second.value, label: parts.second.label },
    ).toEqual(second);
    expect(parts.more.map((c) => c.value)).toEqual(more);
  });

  it.each(TABLE.filter((r) => r.second !== null))(
    "$name: the button sends the scope its label describes",
    async ({ approval, second }) => {
      const onAnswer = vi.fn();
      render(
        <UiSlotsProvider value={{}}>
          <ApprovalCard
            approval={approval}
            canAnswer
            now={NOW}
            armDelayMs={0}
            onAnswer={onAnswer}
          />
        </UiSlotsProvider>,
      );
      const button = screen.getByTestId("approval-second-choice");
      expect(button.textContent).toBe(second?.label);
      await userEvent.click(button);
      // A floored kind (a send) asks to confirm an always first; the answer follows it.
      const confirm = screen.queryByRole("alertdialog");
      if (confirm)
        await userEvent.click(within(confirm).getByRole("button", { name: "Always allow" }));
      const sent = answerFor(second?.value as never);
      await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
      expect(onAnswer.mock.calls[0]?.[0]).toBe("approve");
      expect(onAnswer.mock.calls[0]?.[1]).toBe(sent.scope);
      expect(onAnswer.mock.calls[0]?.[2]).toEqual(sent.extras);
    },
  );

  it("a once-only card has no second button and no More options (control: a lasting card has both)", () => {
    const { unmount } = render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard approval={site()} canAnswer now={NOW} armDelayMs={0} onAnswer={vi.fn()} />
      </UiSlotsProvider>,
    );
    expect(screen.getByTestId("approval-second-choice")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More options…" })).toBeTruthy();
    unmount();
    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={site({ scopesOffered: ["once"] })}
          canAnswer
          now={NOW}
          armDelayMs={0}
          onAnswer={vi.fn()}
        />
      </UiSlotsProvider>,
    );
    expect(screen.queryByTestId("approval-second-choice")).toBeNull();
    expect(screen.queryByRole("button", { name: "More options…" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^(Deny|Allow)$/ })).toHaveLength(2);
  });

  it("More options lists the demoted scopes, each sending its own", async () => {
    const onAnswer = vi.fn();
    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard approval={site()} canAnswer now={NOW} armDelayMs={0} onAnswer={onAnswer} />
      </UiSlotsProvider>,
    );
    expect(screen.queryByTestId("approval-more-task")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More options…" }));
    await userEvent.click(screen.getByRole("button", { name: "For this task" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "task", undefined));
  });

  it("a payment card on screen shows Deny and Allow only, whatever it was sent", () => {
    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={card({
            kind: "purchase",
            sideEffect: "financial",
            requiresAuthentication: true,
            scopesOffered: ["once", "session", "always"],
          })}
          canAnswer
          now={NOW}
          armDelayMs={0}
          onAnswer={vi.fn()}
        />
      </UiSlotsProvider>,
    );
    expect(screen.queryByRole("button", { name: /always|chat|task/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "More options…" })).toBeNull();
  });

  it("the inline choices leave out an always that lifts a floor", () => {
    const send = card({
      kind: "send_email",
      grantKey: "send_email:me@x.com:bob@x.com",
      target: { kind: "recipient", value: "bob@x.com" },
      scopesOffered: ["once", "session", "always"],
    });
    expect(inlineChoices(send).all.map((c) => c.value)).toEqual(["session"]);
    // Control: a card that is not floored keeps its always.
    expect(
      inlineChoices(card({ scopesOffered: ["once", "session", "always"] })).all.map((c) => c.value),
    ).toEqual(["session", "always"]);
  });
});

describe("plain words on the card", () => {
  it("says what the card does instead of the raw side-effect word", () => {
    expect(plainEffect({ kind: "file_write", sideEffect: "write" })).toBe("Changes files");
    expect(plainEffect({ kind: "send_email", sideEffect: "write" })).toBe("Sends to someone");
    expect(plainEffect({ kind: "connector_action", sideEffect: "destructive" })).toBe(
      "Can't be undone",
    );
    expect(plainEffect({ kind: "purchase", sideEffect: "financial" })).toBe("Moves money");
    expect(plainEffect({ kind: "connector_action", sideEffect: undefined })).toBeNull();
  });

  it("shows no raw word in the header", () => {
    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={card({ kind: "file_write", sideEffect: "write" })}
          canAnswer
          now={NOW}
          armDelayMs={0}
          onAnswer={vi.fn()}
        />
      </UiSlotsProvider>,
    );
    const header = document.querySelector("[data-card-header]")?.textContent ?? "";
    expect(header).toContain("Changes files");
    expect(header).not.toMatch(/\bwrite\b/);
  });

  it("turns void codes into sentences, never the raw code", () => {
    for (const reason of ["run_cancelled", "gateway_restart", "owner_replied", undefined, "x_y"]) {
      expect(voidedText(reason)).not.toMatch(/_/);
      expect(voidedText(reason)).toMatch(/Nothing was done\.$/);
    }
    expect(voidedText("run_cancelled")).toBe(
      "Cancelled because the task stopped. Nothing was done.",
    );
    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={card({ status: "invalidated", invalidatedReason: "run_cancelled" })}
          canAnswer
          now={NOW}
          onAnswer={vi.fn()}
        />
      </UiSlotsProvider>,
    );
    expect(screen.getByText(/Cancelled because the task stopped/)).toBeTruthy();
    expect(screen.queryByText(/Voided: run_cancelled/)).toBeNull();
  });

  it("an expired card says so and offers nothing that cannot work", () => {
    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={card({ expiresAt: new Date(NOW - 60_000).toISOString() })}
          canAnswer
          now={NOW}
          armDelayMs={0}
          onAnswer={vi.fn()}
        />
      </UiSlotsProvider>,
    );
    expect(screen.getByText(/Expired\. Nothing was done\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Allow|Deny)$/ })).toBeNull();
    expect(screen.queryByTestId("approval-second-choice")).toBeNull();
    expect(screen.queryByRole("button", { name: "More options…" })).toBeNull();
  });
});

function worldWith(edit?: (w: FixtureWorld) => void) {
  const ref: { gateway?: MockGateway } = {};
  return {
    ref,
    props: {
      ...(edit ? { edit } : {}),
      onGateway: (g: MockGateway) => {
        ref.gateway = g;
      },
    },
  };
}

describe("Undo on an answered card", () => {
  const answered = (over: Partial<ApprovalRequest> = {}) =>
    card({
      status: "approved",
      scopeGranted: "always",
      grantId: IDS.grants.acmeSite,
      decidedAt: FIXTURE_NOW,
      decidedBy: { deviceId: "dev_1", surface: "desktop" },
      ...over,
    });

  it("shows Always allowed · Undo and revokes that grant", async () => {
    const { ref, props } = worldWith();
    render(
      <StoryWorld {...props}>
        <ApprovalCard approval={answered()} canAnswer={false} now={NOW} />
      </StoryWorld>,
    );
    expect(screen.getByText(/Always allowed/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(ref.gateway?.calls.filter((c) => c.method === "grants.revoke")).toHaveLength(1),
    );
    expect(ref.gateway?.calls.find((c) => c.method === "grants.revoke")?.params).toEqual({
      grantId: IDS.grants.acmeSite,
    });
    expect(await screen.findByText("Undone. Psyche will ask again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("offers no Undo after a one-time Allow, or when no grant was made", () => {
    const { props } = worldWith();
    const { unmount } = render(
      <StoryWorld {...props}>
        <ApprovalCard approval={answered({ scopeGranted: "once" })} canAnswer={false} now={NOW} />
      </StoryWorld>,
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    unmount();
    render(
      <StoryWorld {...props}>
        <ApprovalCard approval={answered({ grantId: null })} canAnswer={false} now={NOW} />
      </StoryWorld>,
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("one approval, shown once", () => {
  it("the Agent sheet lists the current chat's card as a link, not a second answerable card", async () => {
    const { props } = worldWith();
    render(
      <StoryWorld {...props}>
        <ApprovalsPanel now={STORY_NOW} currentThreadId={IDS.threads.dentist} />
      </StoryWorld>,
    );
    const list = await screen.findByTestId("approvals-in-this-chat");
    const inThread = createFixtureWorld().approvals.filter(
      (x) => x.status === "pending" && x.requestedBy.threadId === IDS.threads.dentist,
    );
    expect(inThread.length).toBeGreaterThan(0);
    expect(within(list).getAllByText("Show in chat")).toHaveLength(inThread.length);
    // None of them is an answerable card here: the card is on the chat.
    for (const x of inThread) {
      expect(document.querySelector(`fieldset[data-approval-id="${x.id}"]`)).toBeNull();
    }
  });

  it("control: with no current chat the same card is answerable here", async () => {
    const { props } = worldWith();
    render(
      <StoryWorld {...props}>
        <ApprovalsPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    const groups = await screen.findAllByRole("group");
    expect(groups.find((g) => /jane\.ortiz/.test(g.textContent ?? ""))).toBeTruthy();
    expect(screen.queryByTestId("approvals-in-this-chat")).toBeNull();
    expect(
      document.querySelector(`fieldset[data-approval-id="${IDS.approvals.sendEmail}"]`),
    ).toBeTruthy();
  });

  it("another chat's card stays answerable when a chat is open", async () => {
    const { props } = worldWith();
    render(
      <StoryWorld {...props}>
        <ApprovalsPanel now={STORY_NOW} currentThreadId="thr_somewhere_else" />
      </StoryWorld>,
    );
    const groups = await screen.findAllByRole("group");
    expect(groups.find((g) => /jane\.ortiz/.test(g.textContent ?? ""))).toBeTruthy();
  });
});

describe("Inbox Allow menu", () => {
  const edit = (w: FixtureWorld) => {
    const a = w.approvals.find((x) => x.id === IDS.approvals.sendEmail);
    if (a) {
      a.taint = false;
      a.kind = "mcp_tool";
      a.grantKey = "k";
      a.scopesOffered = ["once", "session", "always"];
      a.details = { tool: "mcp__notion__create_page", params: {} };
    }
  };

  it("sends the scope chosen, not a hard-coded once", async () => {
    const { ref, props } = worldWith(edit);
    const user = userEvent.setup();
    render(
      <StoryWorld {...props}>
        <InboxScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const row = (
      await screen.findByRole("heading", { name: "Send email to jane.ortiz@example.com" })
    ).closest("article") as HTMLElement;
    const menu = await within(row).findByRole("button", { name: /^More ways to allow/ });
    await waitFor(() => expect((menu as HTMLButtonElement).disabled).toBe(false));
    await user.click(menu);
    await user.click(await screen.findByRole("menuitem", { name: "For the rest of this chat" }));
    await waitFor(() =>
      expect(ref.gateway?.calls.find((c) => c.method === "approvals.answer")?.params).toMatchObject(
        {
          approvalId: IDS.approvals.sendEmail,
          decision: "approve",
          scope: "session",
        },
      ),
    );
  });

  it("plain Approve still sends once (control: a once-only card has no menu)", async () => {
    const { ref, props } = worldWith(edit);
    const user = userEvent.setup();
    render(
      <StoryWorld {...props}>
        <InboxScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const row = (
      await screen.findByRole("heading", { name: "Send email to jane.ortiz@example.com" })
    ).closest("article") as HTMLElement;
    const approve = await within(row).findByRole("button", { name: /^Approve once:/ });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    await user.click(approve);
    await waitFor(() =>
      expect(ref.gateway?.calls.find((c) => c.method === "approvals.answer")?.params).toMatchObject(
        {
          scope: "once",
        },
      ),
    );
  });

  it("a once-only card has no Allow menu", async () => {
    const { props } = worldWith();
    render(
      <StoryWorld {...props}>
        <InboxScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const row = (
      await screen.findByRole("heading", { name: "Send email to jane.ortiz@example.com" })
    ).closest("article") as HTMLElement;
    await within(row).findByRole("button", { name: /^Approve once:/ });
    expect(within(row).queryByRole("button", { name: /^More ways to allow/ })).toBeNull();
  });
});

function grant(over: Partial<Grant>): Grant {
  return {
    id: "grt_1",
    kind: "exec_host",
    scope: "always",
    grantKey: "k",
    subject: {},
    binding: null,
    expiresAt: "2027-06-01T00:00:00Z",
    useCount: 0,
    lastUsedAt: null,
    createdFromApprovalId: null,
    taskId: null,
    createdAt: "2026-11-10T09:00:00Z",
    revokedAt: null,
    ...over,
  };
}

describe("Settings → Permissions → Allowed", () => {
  const grants = [
    grant({
      id: "g_cmd",
      kind: "exec_host",
      subject: { hostProgram: { executable: "/usr/bin/pnpm", folder: "~/Projects/x", argv: null } },
      useCount: 12,
      lastUsedAt: new Date(NOW - 3_600_000).toISOString(),
    }),
    grant({
      id: "g_site",
      kind: "new_origin",
      subject: { trustedSite: { origin: "https://docs.example.org", subdomains: false } },
    }),
    grant({
      id: "g_mail",
      kind: "send_email",
      grantKey: "send_email:me@x.com:bob@x.com",
      subject: { target: { kind: "recipient", value: "bob@x.com" }, account: "me@x.com" },
    }),
    grant({
      id: "g_tool",
      kind: "mcp_tool",
      scope: "session",
      subject: { tool: "mcp__notion__create_page" },
    }),
    grant({ id: "g_gone", kind: "exec", revokedAt: "2026-11-11T00:00:00Z" }),
    grant({ id: "g_once", kind: "exec", scope: "once" }),
  ];

  it("groups rows by kind, in plain words, with what the data has", () => {
    render(
      <UiSlotsProvider value={{}}>
        <AllowedList grants={grants} now={NOW} onRevoke={vi.fn()} />
      </UiSlotsProvider>,
    );
    const list = screen.getByTestId("allowed-list");
    const names = within(list)
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(names).toEqual(["Sites", "Commands", "Sends", "Apps and tools"]);
    expect(within(list).getByText(/^Always · runs pnpm in ~\/Projects\/x/)).toBeTruthy();
    expect(
      within(list).getByText(/used 12 times · last 1 h ago|used 12 times · last/),
    ).toBeTruthy();
    expect(within(list).getByText(/^Always · docs\.example\.org$/)).toBeTruthy();
    expect(within(list).getByText(/^This chat · /)).toBeTruthy();
    // A revoked grant and a once grant are not listed.
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  });

  it("Remove calls revoke for that grant", async () => {
    const onRevoke = vi.fn();
    render(
      <UiSlotsProvider value={{}}>
        <AllowedList grants={grants} now={NOW} onRevoke={onRevoke} />
      </UiSlotsProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove docs.example.org" }));
    expect(onRevoke).toHaveBeenCalledWith(expect.objectContaining({ id: "g_site" }));
  });

  it("says so when nothing is allowed (control: the list above shows rows)", () => {
    render(
      <UiSlotsProvider value={{}}>
        <AllowedList grants={[]} now={NOW} />
      </UiSlotsProvider>,
    );
    expect(screen.getByText(/Nothing is allowed for good yet/)).toBeTruthy();
    expect(screen.queryByTestId("allowed-list")).toBeNull();
  });

  it("classifies each kind into its group", () => {
    expect(allowedGroupOf(grant({ kind: "new_origin" }))).toBe("sites");
    expect(allowedGroupOf(grant({ kind: "file_write" }))).toBe("folders");
    expect(allowedGroupOf(grant({ kind: "exec" }))).toBe("commands");
    expect(allowedGroupOf(grant({ kind: "send_email" }))).toBe("sends");
    expect(allowedGroupOf(grant({ kind: "connector_action" }))).toBe("tools");
    expect(allowedGroupOf(grant({ kind: "exec", subject: { space: { id: "s" } } }))).toBe("spaces");
  });

  it("sits in Settings with the older lists under Details", () => {
    render(
      <UiSlotsProvider value={{}}>
        <PermissionsPanel
          values={{}}
          onChange={vi.fn()}
          connectors={[]}
          grants={grants}
          onRevoke={vi.fn()}
          now={NOW}
        />
      </UiSlotsProvider>,
    );
    expect(screen.getByRole("heading", { name: "Allowed" })).toBeTruthy();
    const details = screen.getByText("Details").closest("details");
    expect(details).toBeTruthy();
    // The old ledger is still there, demoted inside Details, not deleted.
    expect(
      within(details as HTMLElement).getByRole("table", { name: "Grants ledger" }),
    ).toBeTruthy();
  });
});
