import type { ApprovalRequest, Grant, GrantScope } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentSheet, AgentSheetPanel } from "../src/agent/AgentSheet.tsx";
import { ApprovalsPanel } from "../src/agent/ApprovalsPanel.tsx";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import {
  answerFor,
  buildChoices,
  type ChoiceOptions,
  cardChoices,
  cardOffered,
  defaultAllow,
  inlineChoices,
  isPaymentCard,
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
  /** The origin the card is about (the card derives it from its target). */
  site?: string;
  /** Options the card passes (a folder card's own words, a window that can approve once only). */
  opts?: Partial<ChoiceOptions>;
  /** The scope Allow sends. */
  allow: GrantScope;
  /** The one second choice: its scope value and exact label, or null for none. */
  second: { value: string; label: string } | null;
  /** The values under More options, in order. */
  more: string[];
  /** Not rendered through the card in this file (a folder pick needs its own slots). */
  skipRender?: true;
}

const SITE = "docs.example.org";
const ACCOUNT_KEY = "send_email:me@x.com:bob@x.com";
const sendCard = (over: Partial<ApprovalRequest> = {}) =>
  card({
    kind: "send_email",
    grantKey: ACCOUNT_KEY,
    target: { kind: "recipient", value: "bob@x.com" },
    details: { tool: "gmail_send", params: {} },
    ...over,
  });
const fileCard = (details: Record<string, unknown>) =>
  card({
    kind: "file_write",
    target: { kind: "path", value: "/Users/me/p/a.md" } as never,
    details,
    scopesOffered: ["once", "always"],
  });

const TABLE: Row[] = [
  {
    name: "a card that offers only once shows Deny and Allow only",
    approval: card({ scopesOffered: ["once"] }),
    allow: "once",
    second: null,
    more: [],
  },
  {
    name: "the chat scope wins, and every label names its reach",
    approval: site(),
    site: SITE,
    allow: "once",
    second: {
      value: "session",
      label: "Allow opening docs.example.org for the rest of this chat",
    },
    more: ["task", "site", "always"],
  },
  {
    name: "an MCP tool's always names the tool and says any arguments",
    approval: card({}),
    allow: "once",
    second: { value: "always", label: "Always allow Notion › create page, with any arguments" },
    more: [],
  },
  {
    name: "an MCP tool's session says the tool and any arguments too",
    approval: card({ scopesOffered: ["once", "session"] }),
    allow: "once",
    second: {
      value: "session",
      label: "Allow Notion › create page, with any arguments for the rest of this chat",
    },
    more: [],
  },
  {
    name: "an MCP card with no tool name has no second choice: session stays under More options",
    approval: card({ scopesOffered: ["once", "session"], details: { params: {} } }),
    allow: "once",
    second: null,
    more: ["session"],
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
    name: "an email send names the whole to, cc and bcc set and the account",
    approval: sendCard({
      grantKey: "send_email:me@x.com:a@x.com,bob@x.com,c@x.com",
      target: { kind: "recipient", value: "a@x.com,bob@x.com,c@x.com" },
    }),
    allow: "once",
    second: {
      value: "always",
      label: "Always allow sending to a@x.com, bob@x.com, c@x.com from me@x.com",
    },
    more: [],
  },
  {
    name: "an email send's session names the recipients too",
    approval: sendCard({ scopesOffered: ["once", "session", "always"] }),
    allow: "once",
    second: {
      value: "session",
      label: "Allow sending to bob@x.com from me@x.com for the rest of this chat",
    },
    more: ["always"],
  },
  {
    name: "an email send with no recipient set gets no second choice, never a label without them",
    approval: sendCard({ target: undefined, scopesOffered: ["once", "session", "always"] }),
    allow: "once",
    second: null,
    more: ["session", "always"],
  },
  {
    name: "a command card's always says the exact command",
    approval: card({ kind: "exec", details: { argv: ["pnpm", "test"] } }),
    allow: "once",
    second: { value: "always", label: "Always allow this exact command" },
    more: [],
  },
  {
    name: "a file write's always says any content at that path, not 'this change'",
    approval: fileCard({ root: "/Users/me/p/a.md" }),
    allow: "once",
    second: { value: "always", label: "Always allow writing to /Users/me/p/a.md, any content" },
    more: [],
  },
  {
    name: "a file write whose grant root is a folder uses folder wording",
    approval: fileCard({ root: "/Users/me/p", operation: "edit" }),
    allow: "once",
    second: { value: "always", label: "Always allow edit in /Users/me/p" },
    more: [],
  },
  {
    name: "a file write that does not carry its root says files in the target's folder",
    approval: fileCard({}),
    allow: "once",
    second: {
      value: "always",
      label: "Always allow writing to files in /Users/me/p, any content",
    },
    more: [],
  },
  {
    name: "a message send names the recipient on that channel",
    approval: card({
      kind: "message_send",
      details: { channel: "imessage", recipient: "bob" },
    }),
    allow: "once",
    second: { value: "always", label: "Always allow messages to bob on imessage" },
    more: [],
  },
  {
    name: "a message send with no recipient data gets no second choice",
    approval: card({ kind: "message_send", details: {} }),
    allow: "once",
    second: null,
    more: ["always"],
  },
  {
    name: "a calendar write names the calendar and the operation",
    approval: card({
      kind: "calendar_write",
      details: { calendar: "Work", operation: "create" },
    }),
    allow: "once",
    second: { value: "always", label: "Always allow create in calendar Work" },
    more: [],
  },
  {
    name: "a computer action names the app and says any action at that level",
    approval: card({ kind: "computer_action", details: { app: "Notes" } }),
    allow: "once",
    second: { value: "always", label: "Always allow Notes, any action at this level" },
    more: [],
  },
  {
    name: "a separate-desktop share never offers an always",
    approval: card({ kind: "separate_desktop_share", scopesOffered: ["once", "always"] }),
    opts: { folderWords: true, sdShare: true },
    allow: "once",
    second: null,
    more: [],
    skipRender: true,
  },
  {
    name: "a card that needs presence never shows a lasting choice",
    approval: card({ requiresAuthentication: true, scopesOffered: ["once", "session", "always"] }),
    allow: "once",
    second: null,
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
    name: "a tainted floored card offers once only",
    approval: sendCard({ taint: true, scopesOffered: ["once", "session", "always"] }),
    allow: "once",
    second: null,
    more: [],
  },
  {
    name: "a window that can approve once only offers no lasting choice",
    approval: site(),
    site: SITE,
    opts: { onceOnly: true },
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
  {
    name: "a folder card: Always is the second choice, the Space sits under More options",
    approval: card({
      kind: "folder_access",
      sideEffect: "write",
      details: { space: { id: "spc_1", name: "Kitchen" } },
      scopesOffered: ["once", "always"],
    }),
    opts: { folderWords: true },
    allow: "once",
    second: { value: "always", label: "Always, this folder and below" },
    more: ["space"],
    skipRender: true,
  },
];

describe("the second choice: offered scopes → the scope sent and its label", () => {
  it.each(TABLE)("$name", ({ approval, allow, second, more, site: origin, opts }) => {
    const options = { site: origin ?? null, ...opts };
    // Path one: the card's own helper.
    const viaCard = cardChoices(approval, options);
    // Path two: the parts, with the real payment predicate.
    const parts = splitChoices(
      buildChoices(approval, cardOffered(approval), options),
      defaultAllow(approval),
      isPaymentCard(approval) || options.onceOnly === true,
    );
    expect(defaultAllow(approval)).toBe(allow);
    for (const got of [viaCard, parts]) {
      expect(
        got.second === null ? null : { value: got.second.value, label: got.second.label },
      ).toEqual(second);
      expect(got.more.map((c) => c.value)).toEqual(more);
    }
    // A label names its reach: nothing under More options claims "this change" or "this same kind".
    for (const c of [...(viaCard.second ? [viaCard.second] : []), ...viaCard.more]) {
      expect(c.label).not.toMatch(/this change|this same kind of action/);
    }
  });

  it("the second choice is never a vague one", () => {
    for (const row of TABLE) {
      const got = cardChoices(row.approval, { site: row.site ?? null, ...row.opts });
      expect(got.second?.vague ?? false).toBe(false);
    }
  });

  it.each(TABLE.filter((r) => r.second !== null && r.skipRender !== true))(
    "$name: the button sends the scope its label describes",
    async ({ approval, second }) => {
      const onAnswer = vi.fn();
      render(
        <UiSlotsProvider value={{}}>
          <ApprovalCard
            approval={{ ...approval, details: { sandbox: "srt", ...approval.details } }}
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

  it.each(TABLE.filter((r) => r.skipRender !== true && r.opts === undefined))(
    "$name: plain Allow is once when once is offered, and ⌘↩ sends defaultAllow",
    async ({ approval, allow }) => {
      const onAnswer = vi.fn();
      render(
        <UiSlotsProvider value={{}}>
          <ApprovalCard
            approval={{ ...approval, details: { sandbox: "srt", ...approval.details } }}
            canAnswer
            now={NOW}
            armDelayMs={0}
            onAnswer={onAnswer}
          />
        </UiSlotsProvider>,
      );
      if (approval.scopesOffered.includes("once")) expect(allow).toBe("once");
      (
        document.querySelector('[aria-keyshortcuts="Meta+Enter Control+Enter"]') as HTMLElement
      ).focus();
      await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
      await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
      expect(onAnswer.mock.calls[0]?.[1]).toBe(allow);
      expect(onAnswer.mock.calls[0]?.[2]).toBeUndefined();
    },
  );

  it("sending More options → Space is once plus inSpace", () => {
    expect(answerFor("space")).toEqual({ scope: "once" });
    expect(answerFor("program")).toEqual({ scope: "once", extras: { hostProgram: true } });
  });

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
    await userEvent.click(
      screen.getByRole("button", { name: "Allow opening docs.example.org for this task" }),
    );
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

  it("inline: a send, a payment or a presence card gets plain Allow only", () => {
    const send = sendCard({ scopesOffered: ["once", "site", "session", "always"] });
    expect(inlineChoices(send).all).toEqual([]);
    expect(
      inlineChoices(
        card({ requiresAuthentication: true, scopesOffered: ["once", "session", "always"] }),
      ).all,
    ).toEqual([]);
    expect(
      inlineChoices(
        card({ kind: "purchase", sideEffect: "financial", scopesOffered: ["once", "always"] }),
      ).all,
    ).toEqual([]);
    expect(
      inlineChoices(card({ sideEffect: "destructive", scopesOffered: ["once", "task", "always"] }))
        .all,
    ).toEqual([]);
  });

  it("inline: other cards keep reach-labelled lasting choices (control), never a Space or a program", () => {
    const mcp = inlineChoices(card({ scopesOffered: ["once", "session", "always"] }));
    expect(mcp.all.map((c) => c.label)).toEqual([
      "Allow Notion › create page, with any arguments for the rest of this chat",
      "Always allow Notion › create page, with any arguments",
    ]);
    const program = card({
      kind: "exec_host",
      sideEffect: "write",
      details: { hostProgram: { program: "pnpm", folder: "/x", argv: null } },
    });
    const space = card({
      kind: "folder_access",
      details: { space: { id: "s", name: "Kitchen" } },
      scopesOffered: ["once", "always"],
    });
    for (const c of [program, space]) {
      const values = inlineChoices(c).all.map((x) => x.value);
      expect(values).not.toContain("program");
      expect(values).not.toContain("space");
    }
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
    // A missing side effect is a neutral line, never nothing.
    expect(plainEffect({ kind: "connector_action", sideEffect: undefined })).toBe("Needs your OK");
    expect(plainEffect({ kind: "git_push", sideEffect: "write" })).toBe("Publishes your commits");
    // A host command: the stronger line when it can reach the network.
    const host = { kind: "exec_host" as const, sideEffect: "write" as const };
    expect(plainEffect({ ...host, details: { allowedDomains: ["example.com"] } })).toBe(
      "Can reach the internet",
    );
    expect(plainEffect({ ...host, details: { allowedDomains: [], network: "none" } })).toBe(
      "Runs on this computer",
    );
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
    expect(screen.getByText("Expired · nothing was done")).toBeTruthy();
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

describe("Show in chat on the modal sheet", () => {
  const dentist = { currentThreadId: IDS.threads.dentist };

  it("closes the overlay sheet so the card is in view", async () => {
    const onOpenChange = vi.fn();
    const { props } = worldWith();
    render(
      <StoryWorld {...props}>
        <AgentSheet
          open
          onOpenChange={onOpenChange}
          tab="approvals"
          onTabChange={() => {}}
          now={STORY_NOW}
          {...dentist}
        />
      </StoryWorld>,
    );
    const link = (await screen.findAllByText("Show in chat"))[0] as HTMLElement;
    await userEvent.click(link);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("leaves the docked panel open (control)", async () => {
    const onClose = vi.fn();
    const { props } = worldWith();
    render(
      <StoryWorld {...props}>
        <AgentSheetPanel
          tab="approvals"
          onTabChange={() => {}}
          now={STORY_NOW}
          onClose={onClose}
          {...dentist}
        />
      </StoryWorld>,
    );
    const link = (await screen.findAllByText("Show in chat"))[0] as HTMLElement;
    await userEvent.click(link);
    expect(onClose).not.toHaveBeenCalled();
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
    await user.click(
      await screen.findByRole("menuitem", {
        name: "Allow Notion › create page, with any arguments for the rest of this chat",
      }),
    );
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

  it("the Approve label says what plain Approve sends", async () => {
    const { props } = worldWith((w) => {
      edit(w);
      const a = w.approvals.find((x) => x.id === IDS.approvals.sendEmail);
      if (a) a.scopesOffered = ["task", "session"];
    });
    render(
      <StoryWorld {...props}>
        <InboxScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const row = (
      await screen.findByRole("heading", { name: "Send email to jane.ortiz@example.com" })
    ).closest("article") as HTMLElement;
    // No once on this card: Approve sends the task scope, and its label says so (not "once").
    const approve = await within(row).findByRole("button", { name: /^Approve, Allow Notion/ });
    expect(approve.getAttribute("aria-label")).toContain("for this task");
    expect(within(row).queryByRole("button", { name: /^Approve once:/ })).toBeNull();
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

  it("shows a failed Remove next to the rows (control: no error, no notice)", () => {
    const { unmount } = render(
      <UiSlotsProvider value={{}}>
        <AllowedList grants={grants} now={NOW} onRevoke={vi.fn()} />
      </UiSlotsProvider>,
    );
    expect(screen.queryByText(/Couldn't remove docs\.example\.org/)).toBeNull();
    unmount();
    render(
      <UiSlotsProvider value={{}}>
        <AllowedList
          grants={grants}
          now={NOW}
          onRevoke={vi.fn()}
          error="Couldn't remove docs.example.org (offline)"
        />
      </UiSlotsProvider>,
    );
    expect(screen.getByText(/Couldn't remove docs\.example\.org/)).toBeTruthy();
    expect(screen.getByTestId("allowed-list")).toBeTruthy();
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
