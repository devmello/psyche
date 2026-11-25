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
  [
    "browser navigation to a new site",
    call("browser.navigate", "read", origin("https://news.example.org")),
  ],
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
    call(
      "computer.click",
      "write",
      { kind: "app", value: "com.apple.TextEdit" },
      {
        meta: { app: "com.apple.TextEdit" },
      },
    ),
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

  it.each(
    SENDS.filter(([name]) => !["a git push", "accepting terms", "an AppleScript"].includes(name)),
  )("%s: the card offers this send only, no standing grant", async (_name, c) => {
    expect((await broker().broker.decide(c, FULL)).scopesOffered).toEqual(["once"]);
  });

  it("control: the same email card in Balanced offers more than once", async () => {
    const d = await broker().broker.decide(SENDS[0]?.[1] as PolicyCall, BALANCED);
    expect(d.scopesOffered?.length ?? 0).toBeGreaterThan(1);
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

/**
 * Security review round 1 (#1689): each probe through the real broker and engine. "asks" rows ask
 * in Full access with a `full:held(…)` trace; "runs" rows run in Full access and ask in Balanced.
 */
describe("review r1 probes: held in Full access", () => {
  const w = (tool: string, extra: Partial<PolicyCall> = {}) =>
    call(tool, "write", undefined, extra);
  const file = (p: string) =>
    call("write_file", "write", path(p), { kind: "file_write", params: { path: p, content: "x" } });
  const ASKS: [string, PolicyCall, string][] = [
    // 2. Commerce through badly named tools (the money floor may not see them).
    ["mcp__shop__checkout", w("mcp__shop__checkout"), "commerce|payment"],
    ["mcp__doordash__create_order", w("mcp__doordash__create_order"), "commerce"],
    ["mcp__duffel__book_flight", w("mcp__duffel__book_flight"), "commerce"],
    ["request_ride", w("request_ride"), "commerce"],
    ["subscribe", w("subscribe"), "commerce"],
    ["upgrade_plan", w("upgrade_plan"), "commerce"],
    ["rent_car", w("rent_car"), "commerce"],
    ["tip_driver", w("tip_driver"), "commerce"],
    // 3. Shortcuts, whatever names them.
    ["shortcuts_run", w("shortcuts_run"), "script"],
    ["node.shortcuts.run", w("node.shortcuts.run"), "script"],
    [
      "mcp__apple_shortcuts__shortcuts_run (connectorRule shortcuts.run/S2)",
      w("mcp__apple_shortcuts__shortcuts_run", {
        connectorRule: { id: "apple-shortcuts", action: "shortcuts.run/S2" },
      }),
      "script",
    ],
    // 4. Send words, matched on whole word segments.
    ...(
      [
        "create_message",
        "create_email",
        "create_chat_message",
        "notify",
        "dispatch",
        "deliver",
        "submit_form",
        "respond",
        "ping_user",
        "email_user",
        "message_user",
        "mail",
        "sms__text",
        "chat.scheduleMessage",
        "chat_update",
        "create_issue",
        "create_pull_request",
        "permissions_create",
        "create_shared_link",
        "create_status",
      ] as const
    ).map((t): [string, PolicyCall, string] => [t, w(t), "post|send|invite"]),
    // 5. Calendar changes the attendees hear about.
    [
      "MS calendar_update_event {eventId, event:{start}}",
      w("mcp__outlook__calendar_update_event", {
        params: { eventId: "e1", event: { start: { dateTime: "2026-11-26T10:00" } } },
      }),
      "invite",
    ],
    [
      "node.calendar.delete_event with attendees",
      call("node.calendar.delete_event", "destructive", undefined, {
        params: { eventId: "e1", attendees: ["bob@example.com"] },
      }),
      "invite",
    ],
    [
      "node.calendar.delete_event, attendees unknown",
      call("node.calendar.delete_event", "destructive", undefined, { params: { eventId: "e1" } }),
      "invite",
    ],
    [
      'send_updates: "all"',
      w("calendar.create_event", {
        kind: "calendar_write",
        params: { event: { summary: "Sync" }, send_updates: "all" },
      }),
      "invite",
    ],
    [
      "attendee_emails",
      w("calendar.create_event", {
        kind: "calendar_write",
        params: { summary: "Sync", attendee_emails: ["bob@example.com"] },
      }),
      "invite",
    ],
    [
      "requiredAttendees",
      w("mcp__outlook__create_event", {
        params: { subject: "Sync", requiredAttendees: ["bob@example.com"] },
      }),
      "invite",
    ],
    // 6. Writes that run later.
    ["/work/repo/.git/hooks/pre-commit", file("/work/repo/.git/hooks/pre-commit"), "runs_later"],
    ["/work/.envrc", file("/work/.envrc"), "runs_later"],
    ["~/proj/.vscode/tasks.json", file(`${HOME}/proj/.vscode/tasks.json`), "runs_later"],
    // 8. A click on a send control, tainted or not.
    [
      "browser.click on a Send button",
      call("browser.click", "write", origin("https://mail.example.org"), {
        meta: { control: { labels: ["Send"] } },
      }),
      "ui_send",
    ],
    [
      "computer.click on a Post reply button",
      call(
        "computer.click",
        "write",
        { kind: "app", value: "com.example.Chat" },
        { meta: { app: "com.example.Chat", control: { labels: ["Post reply", "Thread"] } } },
      ),
      "ui_send",
    ],
  ];

  it.each(ASKS)("%s asks", async (_name, c, holds) => {
    const d = await broker().broker.decide(c, FULL);
    expect(d.decision, d.trace.join(" ")).not.toBe("allow");
    const held = d.trace.find((t) => t.startsWith("full:held("));
    expect(held, d.trace.join(" ")).toMatch(new RegExp(`^full:held\\((${holds})\\)$`));
    // Control: Balanced asks (or refuses) the same call.
    expect((await broker().broker.decide(c, BALANCED)).decision).not.toBe("allow");
  });

  const RUNS_TOO: [string, PolicyCall][] = [
    ["mcp__notion__create_page", w("mcp__notion__create_page")],
    ["mcp__db__postgres_query", w("mcp__db__postgres_query")],
    ["postgres_query", w("postgres_query")],
    ["forward_draft", w("forward_draft")],
    ["create_note", w("create_note")],
    ["move_file", w("move_file")],
    [
      'Google create_event, sendUpdates "none", nobody invited',
      w("calendar.create_event", {
        kind: "calendar_write",
        params: { event: { summary: "Focus" }, sendUpdates: "none" },
      }),
    ],
    ["~/Documents/plan.md", file(`${HOME}/Documents/plan.md`)],
    [
      "browser.click on an Open button",
      call("browser.click", "write", origin("https://mail.example.org"), {
        meta: { control: { labels: ["Open"] } },
      }),
    ],
    [
      "browser.click on a long paragraph that mentions share",
      call("browser.click", "write", origin("https://news.example.org"), {
        meta: { control: { labels: ["Read how to share your feedback with the team today"] } },
      }),
    ],
  ];

  it.each(RUNS_TOO)("%s runs", async (_name, c) => {
    const d = await broker().broker.decide(c, FULL);
    expect(d.decision, d.trace.join(" ")).toBe("allow");
    expect(d.rule).toMatch(/^mode:full\//);
    expect((await broker().broker.decide(c, BALANCED)).decision).not.toBe("allow");
  });
});

describe("review r1 probes: a Shortcut the owner set to allow", () => {
  const run = (id: string) =>
    call("shortcuts_run", "destructive", undefined, {
      kind: "connector_action",
      connectorRule: { id: "apple-shortcuts", action: `shortcuts.run/${id}` },
    });
  const owner = () =>
    makeBroker({
      fullAccessRoots: () => [HOME],
      policy: { connectors: { "apple-shortcuts": { "shortcuts.run/S1": "allow" } } },
    });

  it("runs in Full access (Balanced keeps its destructive floor)", async () => {
    const d = await owner().broker.decide(run("S1"), FULL);
    expect(d.decision, d.trace.join(" ")).toBe("allow");
    expect((await owner().broker.decide(run("S1"), BALANCED)).decision).toBe("ask");
  });

  it("control: a shortcut the owner didn't allow asks", async () => {
    const d = await owner().broker.decide(run("S2"), FULL);
    expect(d.decision).toBe("ask");
    expect(d.trace).toContain("full:held(script)");
  });
});

describe("review r1 probes: reach-out after untrusted content", () => {
  const TAINTED: PolicyContext = { ...FULL, taint: true, taintSources: [{ sourceKind: "web" }] };
  // exec_host as the Mac sends it: its only network is the hosts named in `allowedDomains`.
  const host = (allowedDomains: string[]) =>
    call("exec_host", "destructive", undefined, {
      params: { argv: ["curl", "https://x.example"], cwd: "/work", allowedDomains },
    });
  const submit = call("browser.submit", "write", origin("https://forms.example.org"));

  it("R2 must-refuse: a tainted host command with allowedDomains asks, this run only", async () => {
    const d = await broker().broker.decide(host(["x.example"]), TAINTED);
    expect(d.decision, d.trace.join(" ")).toBe("ask");
    expect(d.trace).toContain("full:held(taint_egress)");
    expect(d.scopesOffered).toEqual(["once"]);
  });

  it.each([
    ["the same call untainted", host(["x.example"]), FULL],
    ["tainted, with allowedDomains: []", host([]), TAINTED],
  ] as const)("R2 must-pass: %s runs", async (_name, c, context) => {
    const d = await broker().broker.decide(c, context);
    expect(d.decision, d.trace.join(" ")).toBe("allow");
    expect(d.rule).toMatch(/^mode:full\//);
  });

  it("a form submitted to a new origin asks in a tainted turn", async () => {
    const d = await broker().broker.decide(submit, TAINTED);
    expect(d.decision).toBe("ask");
    expect(d.trace).toContain("full:held(taint_submit)");
    // Controls: untainted it runs; tainted, to a target already approved this task, it runs.
    expect((await broker().broker.decide(submit, FULL)).decision).toBe("allow");
    expect((await broker().broker.decide(submit, { ...TAINTED, newTarget: false })).decision).toBe(
      "allow",
    );
  });

  it("a click on a Send button asks in a tainted turn too", async () => {
    const c = call("browser.click", "write", origin("https://mail.example.org"), {
      meta: { control: { labels: ["Send"] } },
    });
    const d = await broker().broker.decide(c, TAINTED);
    expect(d.decision).toBe("ask");
    expect(d.trace).toContain("full:held(ui_send)");
    expect(d.scopesOffered).toEqual(["once"]);
  });
});

describe("review r1 probes: turning Full access off mid-run", () => {
  const exec = call("exec", "write", undefined, { params: { argv: ["npm", "test"] } });
  const live = (on: boolean | undefined) => {
    const asked: string[] = [];
    const h = makeBroker({
      fullAccessRoots: () => [HOME],
      threadFullAccess: (id) => {
        asked.push(id);
        return on;
      },
    });
    return { h, asked };
  };

  it("the next call after threads.update to balanced is decided as Balanced", async () => {
    const { h } = live(false);
    const d = await h.broker.decide(exec, FULL);
    expect(d.decision).toBe("ask");
    expect(d.trace).toContain("full:ignored(turned_off)");
  });

  it("a subagent of the thread is turned off with it", async () => {
    const { h, asked } = live(false);
    const d = await h.broker.decide(exec, { ...FULL, threadId: "thr_main:sub:sub_1" });
    expect(d.decision).toBe("ask");
    expect(asked).toEqual(["thr_main"]);
  });

  it("controls: still on, or an unknown thread, runs (the check only downgrades)", async () => {
    expect((await live(true).h.broker.decide(exec, FULL)).decision).toBe("allow");
    expect((await live(undefined).h.broker.decide(exec, FULL)).decision).toBe("allow");
    // A Balanced turn never asks the live check for more.
    expect((await live(true).h.broker.decide(exec, BALANCED)).decision).toBe("ask");
  });
});

describe("review r1 probes: subagents and other contexts", () => {
  const exec = call("exec", "write", undefined, { params: { argv: ["npm", "test"] } });
  it.each([
    [
      "a subagent of the owner's Telegram turn",
      {
        threadId: "thr_main:sub:sub_1",
        initiator: "subagent" as const,
        requester: { role: "owner" as const, channel: "telegram", senderId: "1" },
      },
    ],
    [
      "a subagent under an MCP App's page",
      { threadId: "thr_main:sub:sub_1", initiator: "mcp_app" as const },
    ],
  ])("%s calling exec is decided as Balanced", async (_name, extra) => {
    expect((await broker().broker.decide(exec, { ...FULL, ...extra })).decision).not.toBe("allow");
  });

  it("control: a subagent of the owner's desktop turn runs", async () => {
    const d = await broker().broker.decide(exec, {
      ...FULL,
      threadId: "thr_main:sub:sub_1",
      initiator: "subagent",
    });
    expect(d.decision).toBe("allow");
  });
});

/**
 * Security review round 2 (#1689). Calls shaped as production sends them: a first-party connector
 * tool is `mcp__<instance>__<tool>` with its `connectorRule`, an Apple adapter is `node.<app>.*`.
 */
describe("review r2: calendar un-holds trust only Google's sendUpdates", () => {
  const google = (tool: string, sideEffect: "write" | "destructive", params: object) =>
    call(`mcp__google-k3x1__${tool}`, sideEffect, account("owner@example.com"), {
      kind: "calendar_write",
      connectorRule: {
        id: "google-k3x1",
        action: sideEffect === "write" ? "calendar.write" : "calendar.delete",
      },
      params,
    });
  const microsoft = (params: object) =>
    call("mcp__microsoft-m9__calendar_update_event", "write", account("owner@example.com"), {
      kind: "calendar_write",
      connectorRule: { id: "microsoft-m9", action: "calendar.write" },
      params,
    });

  it.each([
    [
      'Microsoft calendar_update_event with sendUpdates: "none" (Graph ignores it)',
      microsoft({
        eventId: "e1",
        event: { start: { dateTime: "2026-11-26T10:00" } },
        sendUpdates: "none",
      }),
    ],
    [
      "node.calendar.delete_event with notifyAttendees: false (never believed)",
      call("node.calendar.delete_event", "destructive", undefined, {
        params: { eventId: "e1", notifyAttendees: false },
      }),
    ],
    [
      'an MCP server calling itself google, with sendUpdates: "none"',
      call("mcp__google__calendar_update_event", "write", undefined, {
        meta: { mcpTier: "unknown" },
        params: { eventId: "e1", event: { summary: "x" }, sendUpdates: "none" },
      }),
    ],
    [
      "Google update_event with sendNotifications: false (not Google's key)",
      google("calendar_update_event", "write", {
        eventId: "e1",
        event: { summary: "x" },
        sendNotifications: false,
      }),
    ],
  ])("must-refuse: %s", async (_name, c) => {
    const d = await broker().broker.decide(c, FULL);
    expect(d.decision, d.trace.join(" ")).toBe("ask");
    expect(d.trace).toContain("full:held(invite)");
    expect(d.scopesOffered).toEqual(["once"]);
  });

  it.each([
    [
      'Google calendar_update_event with sendUpdates: "none"',
      google("calendar_update_event", "write", {
        eventId: "e1",
        event: { start: { dateTime: "2026-11-26T10:00" } },
        sendUpdates: "none",
      }),
    ],
    [
      'Google calendar_delete_event with sendUpdates: "none"',
      google("calendar_delete_event", "destructive", { eventId: "e1", sendUpdates: "none" }),
    ],
  ])("must-pass: %s", async (_name, c) => {
    const d = await broker().broker.decide(c, FULL);
    expect(d.decision, d.trace.join(" ")).toBe("allow");
    expect(d.rule).toMatch(/^mode:full\//);
  });

  it('control: Google update with sendUpdates: "all" asks', async () => {
    const d = await broker().broker.decide(
      google("calendar_update_event", "write", { eventId: "e1", event: {}, sendUpdates: "all" }),
      FULL,
    );
    expect(d.decision).toBe("ask");
  });
});

describe("review r2: only a control's own label holds a click", () => {
  const click = (labels: string[]) =>
    call(
      "computer.act",
      "write",
      { kind: "app", value: "com.apple.TextEdit" },
      { meta: { app: "com.apple.TextEdit", action: "click", control: { labels } } },
    );

  it("must-refuse: its own label is Send", async () => {
    const d = await broker().broker.decide(click(["Send", "Compose"]), FULL);
    expect(d.trace).toContain("full:held(ui_send)");
    expect(d.decision).toBe("ask");
  });

  it('must-pass: a click inside a window titled "Share"', async () => {
    const d = await broker().broker.decide(click(["Bold", "Share"]), FULL);
    expect(d.decision, d.trace.join(" ")).toBe("allow");
  });

  it("must-refuse: the executor's sends fact, whatever the label", async () => {
    const d = await broker().broker.decide(
      call(
        "computer.act",
        "write",
        { kind: "app", value: "com.apple.MobileSMS" },
        {
          meta: { app: "com.apple.MobileSMS", action: "key", control: { labels: [], sends: true } },
        },
      ),
      FULL,
    );
    expect(d.trace).toContain("full:held(ui_send)");
    expect(d.scopesOffered).toEqual(["once"]);
  });

  it("must-refuse: Enter in a web message box; must-pass: Enter in a search box", async () => {
    const press = (label: string) =>
      call("browser.press", "write", origin("https://app.slack.com"), {
        params: { tabId: "t1", keys: "Enter", ref: "e4" },
        meta: { control: { labels: [label] } },
      });
    expect((await broker().broker.decide(press("Message #general"), FULL)).trace).toContain(
      "full:held(ui_send)",
    );
    expect((await broker().broker.decide(press("Search"), FULL)).decision).toBe("allow");
  });
});
