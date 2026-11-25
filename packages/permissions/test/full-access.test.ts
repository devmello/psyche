import { describe, expect, it } from "vitest";
import { fullAccessHold, type PolicyCall, type PolicyContext, sendWords } from "../src/index.ts";
import { CTX, call, makeBroker, origin, path, recipient } from "./helpers.ts";

/**
 * Full access (owner, 2026-11-25): "allows full web browsing, files, everything but payment".
 * Two-way table through the real broker and engine (`decide`), for a security reviewer to read
 * row by row. Every "runs" row also asks in Balanced (the control), so the row proves Full access
 * is what lets it through, not some other allowance.
 */

const HOME = "/Users/owner";
const FULL: PolicyContext = { ...CTX, permissionMode: "full" };
const BALANCED: PolicyContext = { ...CTX, permissionMode: "balanced" };

function broker() {
  return makeBroker({
    fullAccessRoots: () => [HOME],
    policy: {
      exec: { execHostEnabled: true },
      folders: [{ path: "/work", mode: "rw" }],
    },
  });
}

const account = (value: string) => ({ kind: "account" as const, value });

/** Must run without a card in Full access (and asks or is refused in Balanced). */
const RUNS: [string, PolicyCall][] = [
  ["browser navigation to a new site", call("browser.navigate", "read", origin("https://news.example.org"))],
  [
    "filling a non-payment form",
    call("browser.fill", "write", origin("https://forms.example.org"), {
      params: { selector: "#name", value: "Ada" },
    }),
  ],
  [
    "a file write outside the workspace and every granted folder",
    call("write_file", "write", path(`${HOME}/Documents/plan.md`), {
      kind: "file_write",
      params: { path: `${HOME}/Documents/plan.md`, content: "hi" },
    }),
  ],
  [
    "a delete to the Trash outside the workspace",
    call("node.files.trash", "destructive", path(`${HOME}/Downloads/old.zip`)),
  ],
  ["a sandboxed exec", call("exec", "write", undefined, { params: { argv: ["npm", "test"] } })],
  [
    "a host command",
    call("exec_host", "destructive", undefined, {
      params: { argv: ["/usr/bin/make", "build"], cwd: "/work" },
    }),
  ],
  [
    "a calendar event with nobody invited",
    call("calendar.create_event", "write", account("owner@example.com"), {
      kind: "calendar_write",
      params: { event: { summary: "Dentist" }, sendUpdates: "none" },
    }),
  ],
  ["a reminder (Apple app adapter, asks by default)", call("node.reminders.create", "write")],
  ["an MCP write on an unknown-tier server", call("mcp__notion__create_page", "write")],
  [
    "a protected memory file (USER.md)",
    call("memory", "write", path("USER.md"), { kind: "memory_protected_write" }),
  ],
  [
    "a computer-use click",
    call("computer.click", "write", { kind: "app", value: "com.apple.TextEdit" }, {
      meta: { app: "com.apple.TextEdit" },
    }),
  ],
  // Near-misses of the send words: must not be held.
  ["a Postgres query tool", call("mcp__db__postgres_query", "write")],
  ["a reply draft (stays in Drafts)", call("node.mail.reply_draft", "write")],
  ["a note in Notes", call("node.notes.create", "write")],
];

/** Must still ask, with one tap, in Full access: sends to other people. */
const SENDS: [string, PolicyCall][] = [
  [
    "an email send",
    call("gmail.send", "write", recipient("bob@example.com"), {
      kind: "send_email",
      params: { to: ["bob@example.com"], subject: "hi", body: "hello" },
    }),
  ],
  [
    "an iMessage send",
    call("messages.send", "write", recipient("+15555550123"), {
      params: { to: "+15555550123", text: "on my way" },
    }),
  ],
  [
    "a calendar invite with an external attendee (recipient target)",
    call("calendar.create_event", "write", recipient("bob@example.com"), {
      kind: "calendar_write",
      params: { event: { summary: "Sync", attendees: [{ email: "bob@example.com" }] } },
    }),
  ],
  [
    "a calendar invite named only in the event's attendees",
    call("calendar.create_event", "write", account("owner@example.com"), {
      kind: "calendar_write",
      params: { event: { summary: "Sync", attendees: [{ email: "bob@example.com" }] } },
    }),
  ],
  ["a Slack post", call("mcp__slack__chat.postMessage", "write")],
  ["a social post", call("mcp__x__create_post", "write")],
  ["an issue comment", call("mcp__github__create_issue_comment", "write")],
  ["sharing a file", call("mcp__drive__share_file", "write")],
  ["sending a mail draft", call("node.mail.send_draft", "write")],
  [
    "a notification to someone other than the owner",
    call("notify", "write", recipient("bob@example.com")),
  ],
  ["a git push", call("code.git", "write", undefined, { kind: "git_push" })],
  ["accepting terms", call("browser.accept_terms", "destructive", origin("https://x.example"))],
  ["an AppleScript", call("applescript.run", "write", undefined, { kind: "apple_script" })],
];

describe("Full access: runs without a card", () => {
  it.each(RUNS)("%s", async (_name, c) => {
    const h = broker();
    const full = await h.broker.decide(c, FULL);
    expect(full.decision, full.trace.join(" ")).toBe("allow");
    expect(full.rule).toMatch(/^mode:full\//);
    expect(full.via).toBe("full-access");
    // Control: Balanced does not let it through.
    const balanced = await broker().broker.decide(c, BALANCED);
    expect(balanced.decision).not.toBe("allow");
  });

  it("taint from the web does not bring the cards back", async () => {
    const h = broker();
    const tainted = { ...FULL, taint: true, taintSources: [{ sourceKind: "web" }] };
    for (const [, c] of RUNS) {
      const d = await h.broker.decide(c, tainted);
      // The protected persona files stay out of reach of a tainted turn in every mode.
      if (c.kind === "memory_protected_write") {
        expect(d.rule).toBe("prohibition:untrusted_memory_promotion");
        continue;
      }
      expect(d.decision, `${c.tool}: ${d.trace.join(" ")}`).toBe("allow");
    }
  });

  it("audits every Full-access allow with its rule and mode", async () => {
    const h = broker();
    await h.broker.decide(RUNS[2]?.[1] as PolicyCall, FULL);
    const rows = await h.audit.query({ kind: "tool_call.decided" });
    const row = rows.at(-1)?.data as { rule?: string; via?: string; mode?: string };
    expect(row.rule).toBe("mode:full/write");
    expect(row.via).toBe("full-access");
    expect(row.mode).toBe("full");
  });

  it("a path outside the home folder still needs a grant", async () => {
    const d = await broker().broker.decide(
      call("write_file", "write", path("/etc/hosts"), { kind: "file_write" }),
      FULL,
    );
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe("folder:not_granted");
  });

  it("a folder the owner granted read-only stays read-only", async () => {
    const h = makeBroker({
      fullAccessRoots: () => [HOME],
      policy: { folders: [{ path: `${HOME}/Archive`, mode: "ro" }] },
    });
    const d = await h.broker.decide(
      call("write_file", "write", path(`${HOME}/Archive/a.txt`), { kind: "file_write" }),
      FULL,
    );
    expect(d.rule).toBe("folder:read_only");
  });

  it("the owner's own ask rule still asks", async () => {
    const h = makeBroker({ policy: { ask: ["exec"] } });
    const d = await h.broker.decide(call("exec", "write"), FULL);
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("policy:ask:exec");
  });
});

describe("Full access: sends to other people still ask, once per send", () => {
  it.each(SENDS)("%s", async (_name, c) => {
    const d = await broker().broker.decide(c, FULL);
    expect(d.decision, d.trace.join(" ")).toBe("ask");
    expect(d.trace.some((t) => t.startsWith("full:held("))).toBe(true);
  });

  it("a send in a tainted Full-access turn asks for this send only", async () => {
    const d = await broker().broker.decide(SENDS[0]?.[1] as PolicyCall, { ...FULL, taint: true });
    expect(d.decision).toBe("ask");
    expect(d.scopesOffered).toEqual(["once"]);
  });

  it("a kind label never un-holds a send", async () => {
    const d = await broker().broker.decide(
      call("gmail.send", "write", recipient("bob@example.com"), { kind: "connector_action" }),
      FULL,
    );
    expect(d.decision).not.toBe("allow");
  });
});

describe("Full access: payments keep their presence step", () => {
  const presence = () =>
    makeBroker({ fullAccessRoots: () => [HOME], presence: { verify: async () => true } });

  for (const [name, c] of [
    ["a purchase", call("purchase.checkout", "financial", origin("https://shop.example"))],
    ["a payment transfer", call("payments.send", "financial", recipient("bob@example.com"))],
  ] as const) {
    it(`${name} asks, once only, and its card needs Touch ID or the password`, async () => {
      const h = presence();
      const d = await h.broker.decide(c, FULL);
      expect(d.decision).toBe("ask");
      expect(d.scopesOffered).toEqual(["once"]);
      const issued = await h.broker.requestApproval({
        kind: d.approvalKind ?? "connector_action",
        summary: name,
        details: { tool: c.tool },
        bindingHash: d.bindingHash ?? "",
        grantKey: d.grantKey ?? "",
        requestedBy: { runId: FULL.runId, taskId: FULL.taskId ?? null, threadId: FULL.threadId },
        sideEffect: c.sideEffect,
        ...(c.target === undefined ? {} : { target: c.target }),
        surfaces: ["desktop"],
        taint: false,
        context: FULL,
      });
      expect(issued.approval.requiresAuthentication).toBe(true);
    });
  }

  it("a bank wire is still refused outright", async () => {
    const d = await broker().broker.decide(call("bank.wire_transfer", "financial"), FULL);
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe("prohibition:financial_transfer");
  });
});

describe("Full access: hard prohibitions still refuse", () => {
  it.each([
    [
      "a CAPTCHA",
      call("browser.click", "write", origin("https://x.example"), { meta: { captcha: true } }),
      "prohibition:captcha",
    ],
    [
      "typing a password",
      call("browser.type", "write", origin("https://x.example"), {
        meta: { field: { type: "password" } },
        params: { text: "hunter2" },
      }),
      "prohibition:password_typing",
    ],
    [
      "a card number",
      call("browser.fill", "write", origin("https://x.example"), {
        params: { value: "4111 1111 1111 1111" },
      }),
      "prohibition:card_entry",
    ],
  ] as const)("%s", async (_name, c, rule) => {
    const d = await broker().broker.decide(c, FULL);
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe(rule);
  });

  it("filling a saved login still asks", async () => {
    const d = await broker().broker.decide(
      call("credentials.request", "write", origin("https://x.example"), {
        kind: "credential_fill",
      }),
      FULL,
    );
    expect(d.decision).not.toBe("allow");
  });
});

describe("Full access: only the owner's attended chat turn", () => {
  const exec = call("exec", "write", undefined, { params: { argv: ["npm", "test"] } });
  it.each([
    ["an automation (unattended) turn", { unattended: true }, "unattended"],
    [
      "the owner's own message through Telegram",
      { requester: { role: "owner" as const, channel: "telegram", senderId: "1" } },
      "channel",
    ],
    [
      "a designated person's turn",
      { requester: { role: "designated" as const, channel: "telegram", senderId: "2" } },
      "requester",
    ],
    ["an MCP App page's call", { initiator: "mcp_app" as const }, "initiator"],
    ["an automation initiator", { initiator: "automation" as const }, "initiator"],
  ])("%s is decided as Balanced", async (_name, extra, why) => {
    const d = await broker().broker.decide(exec, { ...FULL, ...extra });
    // Balanced: an exec asks (a designated person's persona may refuse it outright).
    expect(d.decision).not.toBe("allow");
    expect(d.trace).toContain(`full:ignored(${why})`);
    if (why === "unattended") expect(d.deferred).toBe(true);
  });

  it("control: the same call in the owner's own turn runs", async () => {
    expect((await broker().broker.decide(exec, FULL)).decision).toBe("allow");
    expect((await broker().broker.decide(exec, { ...FULL, initiator: "subagent" })).decision).toBe(
      "allow",
    );
  });
});

describe("fullAccessHold: send words both ways", () => {
  it.each([
    ["mcp__slack__chat.postMessage", "post"],
    ["mcp__x__createTweet", "post"],
    ["mcp__gh__add_comment", "post"],
    ["mcp__mail__forward_message", "post"],
    ["mcp__teams__send_chat_message", "post"],
    ["mcp__auth__grant_oauth_consent", "consent"],
  ])("%s is held (%s)", (tool, hold) => {
    expect(fullAccessHold(call(tool, "write"), "mcp_tool", "write")).toBe(hold);
  });
  it.each([
    "mcp__db__postgres_query",
    "mcp__notes__create_note",
    "node.mail.forward_draft",
    "mcp__screen__screenshare_status",
    "mcp__files__move_file",
  ])("%s is not held", (tool) => {
    expect(fullAccessHold(call(tool, "write"), "mcp_tool", "write")).toBeUndefined();
  });
  it("reads are never held by their name", () => {
    expect(fullAccessHold(call("mcp__slack__list_posts", "read"), "mcp_tool", "read")).toBe(
      undefined,
    );
  });
  it("splits names into words", () => {
    expect(sendWords("mcp__slack__chat.postMessage")).toEqual([
      "mcp",
      "slack",
      "chat",
      "post",
      "message",
    ]);
  });
});
