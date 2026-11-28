import type {
  AgentEvent,
  ApprovalKind,
  SideEffect,
  StagedCall,
  Staging,
  StagingSink,
  Target,
} from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { NEVER_STAGED_KINDS } from "../src/staging.ts";
import {
  call,
  calls,
  type Harness,
  type HarnessOptions,
  harness,
  recorder,
  resultsIn,
  runTurn,
  say,
  spec,
  turnInput,
} from "./harness.ts";

/**
 * Fork a plan F1 (docs/design/fork-a-plan-2026.md §3.1, §3.3, §12): a plan-fork branch is a staging
 * run whose origin is `{kind:"fork", forkId, branchId}`. This file runs the Night shift probe
 * tables of `staging.test.ts` again under the fork origin (the rows are copied from it, so the two
 * files stay in step by review; `staging.test.ts` is unchanged), then adds the fork-only rows:
 * a read that would ask, a hook that asks, `fork_report` and the one-report rule.
 */

const NIGHT: Staging = { kind: "night", nightId: "night_1" };
const FORK: Staging = { kind: "fork", forkId: "fork_1", branchId: "br_1" };
const REFUSED = { staged: false, note: "not prepared in a plan; add it as a step" };
const STAGED_NOTE = "recorded in the plan's branch; it has not happened and returns no result";

/** A test sink: records what it was handed and answers with `stg_<n>`. */
class FakeSink implements StagingSink {
  readonly calls: StagedCall[] = [];
  mode: "ok" | "refuse" | "throw" = "ok";
  async stage(call: StagedCall) {
    this.calls.push(structuredClone(call));
    if (this.mode === "throw") throw new Error("disk full");
    if (this.mode === "refuse") return { staged: false as const };
    return { staged: true as const, stagedId: `stg_${this.calls.length}` };
  }
}

interface ConnOptions {
  kind?: ApprovalKind;
  target?: Target;
  /** What `describeCall` adds on top of the spec's side effect. */
  descSideEffect?: SideEffect;
  /** An MCP server's tool: the same name and no connector rule. */
  noRule?: boolean;
  grantKey?: string;
  provenanceOut?: "trusted" | "untrusted";
}

/** A connector-shaped tool, registered as `mcp__<id>__<bare>` with the connector rule it carries. */
function conn(
  h: Harness,
  id: string,
  bare: string,
  action: string,
  sideEffect: SideEffect,
  o: ConnOptions = {},
) {
  const name = `mcp__${id}__${bare}`;
  const exec = recorder();
  h.loop.registry.register({
    spec: spec(
      name,
      sideEffect,
      o.provenanceOut === undefined ? {} : { provenanceOut: o.provenanceOut },
    ),
    describeCall: () => ({
      kind: o.kind ?? "connector_action",
      summary: `${bare} (test)`,
      ...(o.target === undefined ? {} : { target: o.target }),
      ...(o.descSideEffect === undefined ? {} : { sideEffect: o.descSideEffect }),
      ...(o.grantKey === undefined ? {} : { grantKey: o.grantKey }),
      ...(o.noRule === true ? {} : { connectorRule: { id, action } }),
    }),
    execute: exec.execute,
  });
  return { name, ran: exec.seen };
}

async function stagingTurn(
  h: Harness,
  sink: StagingSink,
  staging: Staging = FORK,
  text = "work out the plan",
) {
  const events: AgentEvent[] = [];
  const input = { ...turnInput(text, { mode: "unattended" }), staging: { staging, sink } };
  for await (const e of h.loop.startTurn(input)) events.push(e);
  return events;
}

const resultOf = (h: Harness, callId: string, request = 1) =>
  resultsIn(h.provider.requests[request]).get(callId);

/** Every allowlisted tool with the connector that registers it, its action and a plain call. */
const ALLOWED: {
  id: string;
  bare: string;
  action: string;
  args: Record<string, unknown>;
}[] = [
  {
    id: "apple",
    bare: "mail_reply_draft",
    action: "mail.draft",
    args: { id: "m1", body: "Tuesday works for me." },
  },
  {
    id: "apple",
    bare: "mail_draft",
    action: "mail.draft",
    args: {
      to: ["sam@example.org"],
      subject: "Re: Notes",
      body: "The notes are attached.",
      inReplyTo: "<m1@example.org>",
    },
  },
  {
    id: "mail",
    bare: "mail_create_draft",
    action: "mail.draft",
    args: { to: ["sam@example.org"], subject: "Re: Notes", body: "The notes.", threadId: "t1" },
  },
  {
    id: "google",
    bare: "gmail_create_draft",
    action: "gmail.draft",
    args: { to: ["sam@example.org"], subject: "Re: Notes", body: "Thanks.", threadId: "t1" },
  },
  {
    id: "apple",
    bare: "calendar_create_event",
    action: "calendar.write",
    args: { title: "Dentist", start: "2026-12-01T10:00:00Z", end: "2026-12-01T11:00:00Z" },
  },
  {
    id: "google",
    bare: "calendar_update_event",
    action: "calendar.write",
    args: { eventId: "e1", event: { summary: "Dentist visit" } },
  },
  {
    id: "apple",
    bare: "reminders_create",
    action: "reminders.write",
    args: { title: "Water the plants" },
  },
  {
    id: "apple",
    bare: "reminders_update",
    action: "reminders.write",
    args: { id: "r1", title: "Water the ferns" },
  },
  { id: "apple", bare: "reminders_complete", action: "reminders.write", args: { id: "r1" } },
  {
    id: "apple",
    bare: "files_move",
    action: "files.organize",
    args: { path: "/Users/me/a.txt", destination: "/Users/me/Docs" },
  },
  {
    id: "apple",
    bare: "files_rename",
    action: "files.organize",
    args: { path: "/Users/me/a.txt", name: "b.txt" },
  },
];

interface NearMiss {
  label: string;
  id: string;
  bare: string;
  action: string;
  sideEffect: SideEffect;
  args: Record<string, unknown>;
  opts?: ConnOptions;
}

const NEAR_MISSES: NearMiss[] = [
  {
    label: "mail_send",
    id: "apple",
    bare: "mail_send",
    action: "mail.send",
    sideEffect: "destructive",
    args: { to: ["a@example.org"], subject: "s", body: "b" },
    opts: { kind: "send_email" },
  },
  {
    label: "mail_send as a write",
    id: "apple",
    bare: "mail_send",
    action: "mail.send",
    sideEffect: "write",
    args: { to: ["a@example.org"], subject: "s", body: "b" },
  },
  {
    label: "mail_send_draft",
    id: "apple",
    bare: "mail_send_draft",
    action: "mail.send",
    sideEffect: "write",
    args: { id: "d1" },
    opts: { kind: "send_email" },
  },
  {
    label: "gmail_send",
    id: "google",
    bare: "gmail_send",
    action: "gmail.send",
    sideEffect: "write",
    args: { to: ["a@example.org"], body: "b" },
  },
  {
    label: "calendar_delete_event",
    id: "apple",
    bare: "calendar_delete_event",
    action: "calendar.delete",
    sideEffect: "destructive",
    args: { id: "e1" },
  },
  {
    label: "calendar_delete_event as a write",
    id: "apple",
    bare: "calendar_delete_event",
    action: "calendar.write",
    sideEffect: "write",
    args: { id: "e1" },
  },
  {
    label: "reminders_delete",
    id: "apple",
    bare: "reminders_delete",
    action: "reminders.delete",
    sideEffect: "destructive",
    args: { id: "r1" },
  },
  {
    label: "files_trash",
    id: "apple",
    bare: "files_trash",
    action: "files.trash",
    sideEffect: "write",
    args: { path: "/Users/me/a.txt" },
  },
  {
    label: "a forward draft",
    id: "apple",
    bare: "mail_forward_draft",
    action: "mail.draft",
    sideEffect: "write",
    args: { id: "m1", to: ["x@example.org"] },
  },
  {
    label: "a reply draft adding cc",
    id: "apple",
    bare: "mail_reply_draft",
    action: "mail.draft",
    sideEffect: "write",
    args: { id: "m1", body: "ok", cc: ["boss@example.org"] },
  },
  {
    label: "a reply draft adding to",
    id: "apple",
    bare: "mail_reply_draft",
    action: "mail.draft",
    sideEffect: "write",
    args: { id: "m1", body: "ok", to: ["x@example.org"] },
  },
  {
    label: "a new mail draft to anyone, no thread",
    id: "apple",
    bare: "mail_draft",
    action: "mail.draft",
    sideEffect: "write",
    args: { to: ["x@example.org"], subject: "Hello", body: "Hi" },
  },
  {
    label: "a new draft with only bcc",
    id: "mail",
    bare: "mail_create_draft",
    action: "mail.draft",
    sideEffect: "write",
    args: { bcc: ["x@example.org"], subject: "Hello", body: "Hi" },
  },
  {
    label: "a gmail draft with cc and no thread",
    id: "google",
    bare: "gmail_create_draft",
    action: "gmail.draft",
    sideEffect: "write",
    args: { to: ["a@example.org"], cc: ["x@example.org"], subject: "Hello", body: "Hi" },
  },
  {
    label: "a gmail draft whose thread id is empty",
    id: "google",
    bare: "gmail_create_draft",
    action: "gmail.draft",
    sideEffect: "write",
    args: { to: ["a@example.org"], subject: "Hello", body: "Hi", threadId: "" },
  },
  {
    label: "a calendar event with attendees",
    id: "google",
    bare: "calendar_create_event",
    action: "calendar.write",
    sideEffect: "write",
    args: { event: { summary: "Lunch", attendees: [{ email: "x@example.org" }] } },
  },
  {
    label: "a calendar update that notifies",
    id: "google",
    bare: "calendar_update_event",
    action: "calendar.write",
    sideEffect: "write",
    args: { eventId: "e1", sendUpdates: "all", event: { summary: "Lunch" } },
  },
  {
    label: "a calendar event the description says invites",
    id: "apple",
    bare: "calendar_update_event",
    action: "calendar.write",
    sideEffect: "write",
    args: { id: "e1", title: "Lunch" },
    opts: { target: { kind: "recipient", value: "x@example.org" } },
  },
  {
    label: "an MCP tool with an allowlisted name",
    id: "apple",
    bare: "reminders_create",
    action: "reminders.write",
    sideEffect: "write",
    args: { title: "Water the plants" },
    opts: { noRule: true },
  },
  {
    label: "an MCP tool with an unlisted name",
    id: "notes",
    bare: "append_note",
    action: "notes.write",
    sideEffect: "write",
    args: { text: "hello" },
    opts: { noRule: true },
  },
  {
    label: "an allowlisted name under the wrong action",
    id: "apple",
    bare: "reminders_create",
    action: "mail.send",
    sideEffect: "write",
    args: { title: "Water the plants" },
  },
  {
    label: "an allowlisted name described as destructive",
    id: "apple",
    bare: "reminders_update",
    action: "reminders.write",
    sideEffect: "write",
    args: { id: "r1" },
    opts: { descSideEffect: "destructive" },
  },
  {
    label: "an allowlisted name described as financial",
    id: "apple",
    bare: "reminders_create",
    action: "reminders.write",
    sideEffect: "write",
    args: { title: "x" },
    opts: { descSideEffect: "financial" },
  },
  {
    label: "send_money",
    id: "bank",
    bare: "send_money",
    action: "bank.write",
    sideEffect: "write",
    args: { to: "a", amount: 5 },
  },
  {
    label: "execute_trade",
    id: "broker",
    bare: "execute_trade",
    action: "broker.write",
    sideEffect: "write",
    args: { symbol: "VTI" },
  },
  {
    label: "money text in a calendar create",
    id: "apple",
    bare: "calendar_create_event",
    action: "calendar.write",
    sideEffect: "write",
    args: { title: "Send $50 to Sam", start: "2026-12-01T10:00:00Z", end: "2026-12-01T11:00:00Z" },
  },
  {
    label: "Pay rent in a calendar create",
    id: "apple",
    bare: "calendar_create_event",
    action: "calendar.write",
    sideEffect: "write",
    args: { title: "Pay rent", start: "2026-12-01T10:00:00Z", end: "2026-12-01T11:00:00Z" },
  },
  {
    label: "Pay the plumber $120 in a mail draft",
    id: "apple",
    bare: "mail_reply_draft",
    action: "mail.draft",
    sideEffect: "write",
    args: { id: "m1", body: "Pay the plumber $120" },
  },
  {
    label: "money text in a calendar update",
    id: "google",
    bare: "calendar_update_event",
    action: "calendar.write",
    sideEffect: "write",
    args: { eventId: "e1", event: { summary: "Pay the plumber $120" } },
  },
  {
    label: "a money-named reminders tool",
    id: "apple",
    bare: "reminders_send_money",
    action: "reminders.write",
    sideEffect: "write",
    args: { title: "Pay rent" },
  },
  {
    label: "money text nested in an allowlisted call",
    id: "apple",
    bare: "mail_draft",
    action: "mail.draft",
    sideEffect: "write",
    args: {
      to: ["sam@example.org"],
      subject: "s",
      body: "line one\nTransfer 0.5 ETH to the address above",
    },
  },
  {
    label: "purchase kind",
    id: "apple",
    bare: "reminders_create",
    action: "reminders.write",
    sideEffect: "write",
    args: { title: "Water the plants" },
    opts: { kind: "purchase" },
  },
  {
    label: "a financial call",
    id: "shop",
    bare: "checkout",
    action: "shop.write",
    sideEffect: "financial",
    args: { cart: "c1" },
  },
  {
    label: "a file write",
    id: "apple",
    bare: "write_file",
    action: "files.write",
    sideEffect: "write",
    args: { path: "/Users/me/a.txt", content: "x" },
  },
  {
    label: "a message send",
    id: "apple",
    bare: "messages_send",
    action: "messages.send",
    sideEffect: "write",
    args: { to: "x", body: "hi" },
  },
  {
    label: "a task start",
    id: "x",
    bare: "task.start",
    action: "x.write",
    sideEffect: "write",
    args: { title: "t", goal: "g" },
  },
  {
    label: "a connector tool with no rule at all",
    id: "apple",
    bare: "mail_draft",
    action: "mail.draft",
    sideEffect: "write",
    args: { to: ["a@example.org"], subject: "s", body: "b" },
    opts: { noRule: true },
  },
  ...NEVER_STAGED_KINDS.map((kind) => ({
    label: `kind ${kind}`,
    id: "apple",
    bare: "reminders_create",
    action: "reminders.write",
    sideEffect: "write" as SideEffect,
    args: { title: "Water the plants" },
    opts: { kind },
  })),
];

/**
 * Review round 1: `sideEffect: "none"` is not read-only. Each refused tool sits next to a control
 * showing the same call runs outside a staging run, so the refusal is the gate's doing.
 */
interface PlainTool {
  label: string;
  name: string;
  sideEffect: SideEffect;
  args: Record<string, unknown>;
  /** A connector rule, when the tool carries one. */
  rule?: { id: string; action: string };
}

const NONE_REFUSED: PlainTool[] = [
  ...[
    "connector_create",
    "connector_write_file",
    "connector_register",
    "connector_update",
    "connector_propose_remote",
    "connectors_propose_custom",
    "request_permission",
    "request_folder_access",
    "artifact.create",
    "artifact.update",
    "install_capability",
    "messages_send",
    "run_script",
    "render_ui",
    "specialist.status",
    "some_future_none_tool",
  ].map((name) => ({
    label: `none tool ${name}`,
    name,
    sideEffect: "none" as SideEffect,
    args: { x: 1 },
  })),
  {
    label: "an allowlisted none name with a suffix",
    name: "skills_search_all",
    sideEffect: "none",
    args: {},
  },
  {
    label: "web_fetch",
    name: "mcp__web__web_fetch",
    sideEffect: "read",
    args: { url: "https://example.org" },
    rule: { id: "web", action: "fetch.get" },
  },
  {
    label: "web_search",
    name: "mcp__web__web_search",
    sideEffect: "read",
    args: { query: "x" },
    rule: { id: "web", action: "search.query" },
  },
  // Not here any more: under a fork the built-in `web.search` runs and `web.fetch` is held to the
  // branch's own search results (F2, `fork-f2.test.ts`). The Night shift table keeps both refused.
  {
    label: "machine_files",
    name: "machine_files",
    sideEffect: "read",
    args: { machine: "m1", path: "/" },
  },
  { label: "location_current", name: "location_current", sideEffect: "read", args: {} },
  {
    label: "a connector-form machine_files",
    name: "mcp__apple__machine_files",
    sideEffect: "read",
    args: {},
    rule: { id: "apple", action: "files.read" },
  },
  { label: "a dotted web tool of another name", name: "web.extract", sideEffect: "read", args: {} },
  { label: "a browser read", name: "browser.read_page", sideEffect: "read", args: {} },
  { label: "a browser none tool", name: "browser.tabs", sideEffect: "none", args: {} },
  { label: "a computer snapshot", name: "computer.snapshot", sideEffect: "read", args: {} },
  { label: "an exec read", name: "exec.session.read", sideEffect: "read", args: {} },
  {
    label: "an MCP server read",
    name: "mcp__notes__search_notes",
    sideEffect: "read",
    args: { q: "x" },
  },
];

const NONE_RUNS: PlainTool[] = [
  ...["skills_search", "skills_read", "artifact.read", "find_capability"].map((name) => ({
    label: `none tool ${name}`,
    name,
    sideEffect: "none" as SideEffect,
    args: { x: 1 },
  })),
  {
    label: "a connector read",
    name: "mcp__apple__mail_search",
    sideEffect: "read",
    args: { query: "lunch" },
    rule: { id: "apple", action: "mail.read" },
  },
  {
    label: "a plain local read",
    name: "read_file",
    sideEffect: "read",
    args: { path: "/Users/me/a.txt" },
  },
];

function plain(h: Harness, t: PlainTool) {
  const exec = recorder();
  h.loop.registry.register({
    spec: spec(t.name, t.sideEffect),
    ...(t.rule === undefined ? {} : { describeCall: () => ({ connectorRule: t.rule }) }),
    execute: exec.execute,
  });
  return exec.seen;
}

describe("fork origin: the allowlist stages with the fork's note", () => {
  it.each(ALLOWED)("$id $bare stages under the fork origin and does not run", async (row) => {
    const h = harness({
      script: [call("c1", `mcp__${row.id}__${row.bare}`, row.args), say("done")],
    });
    const t = conn(h, row.id, row.bare, row.action, "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({
      staging: FORK,
      tool: t.name,
      connector: { id: row.id, action: row.action },
      sideEffect: "write",
      params: row.args,
      taint: false,
    });
    expect(resultOf(h, "c1")?.output).toEqual({
      staged: true,
      stagedId: "stg_1",
      note: STAGED_NOTE,
    });
    expect(h.broker.issued).toHaveLength(0);
  });

  it.each(["Pay rent", "Pay the plumber $120"])(
    "a reminder titled %j stages under a fork (money words are allowed in reminders only)",
    async (title) => {
      const h = harness({
        script: [call("c1", "mcp__apple__reminders_create", { title }), say("done")],
      });
      const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
      const sink = new FakeSink();
      await stagingTurn(h, sink);
      expect(t.ran).toHaveLength(0);
      expect(sink.calls).toHaveLength(1);
    },
  );

  it.each([
    { bare: "mail_reply_draft", action: "mail.draft", args: { id: "m1", body: "Pay $120 to Sam" } },
    {
      bare: "calendar_create_event",
      action: "calendar.write",
      args: { title: "Pay the landlord $900", start: "2026-12-01T09:00:00Z" },
    },
  ])("the money-text block still holds for $bare under a fork", async (row) => {
    const h = harness({
      script: [call("c1", `mcp__apple__${row.bare}`, row.args), say("done")],
    });
    const t = conn(h, "apple", row.bare, row.action, "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(0);
    expect(resultOf(h, "c1")?.output).toEqual(REFUSED);
  });
});

describe("fork origin: near-misses are refused", () => {
  it.each(NEAR_MISSES)("$label: nothing runs, nothing is staged, no card", async (row) => {
    const h = harness({
      script: [call("c1", `mcp__${row.id}__${row.bare}`, row.args), say("done")],
    });
    const t = conn(h, row.id, row.bare, row.action, row.sideEffect, row.opts);
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(0);
    expect(resultOf(h, "c1")?.output).toEqual(REFUSED);
    expect(resultOf(h, "c1")?.isError).toBe(true);
    expect(h.broker.issued).toHaveLength(0);
  });

  it("a tool registered under a plain (non-connector) name is refused", async () => {
    const h = harness({ script: [call("c1", "reminders_create", { title: "x" }), say("done")] });
    const exec = recorder();
    h.loop.registry.register({
      spec: spec("reminders_create", "write"),
      describeCall: () => ({ connectorRule: { id: "apple", action: "reminders.write" } }),
      execute: exec.execute,
    });
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(exec.seen).toHaveLength(0);
    expect(sink.calls).toHaveLength(0);
  });
});

describe("fork origin: none and read tools", () => {
  it.each(NONE_REFUSED)("$label: refused in a fork run, runs outside one", async (t) => {
    const forkRun = harness({
      policy: { default: "allow" },
      script: [call("c1", t.name, t.args), say("done")],
    });
    const ran = plain(forkRun, t);
    const sink = new FakeSink();
    await stagingTurn(forkRun, sink);
    expect(ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(0);
    expect(resultOf(forkRun, "c1")?.output).toEqual(REFUSED);
    expect(forkRun.broker.issued).toHaveLength(0);
    // Control: the same call, same policy, no staging.
    const control = harness({
      policy: { default: "allow" },
      script: [call("c1", t.name, t.args), say("done")],
    });
    const controlRan = plain(control, t);
    await runTurn(control, "go");
    expect(controlRan).toHaveLength(1);
  });

  it.each(NONE_RUNS)("$label: runs in a fork run", async (t) => {
    const h = harness({
      policy: { default: "allow" },
      script: [call("c1", t.name, t.args), say("done")],
    });
    const ran = plain(h, t);
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(ran).toHaveLength(1);
    expect(sink.calls).toHaveLength(0);
  });

  const MEMORY_WRITES = [
    { command: "create", path: "/memories/agent/payees.md", file_text: "pay Mallory" },
    {
      command: "str_replace",
      path: "/memories/agent/payees.md",
      old_str: "original",
      new_str: "x",
    },
    { command: "insert", path: "/memories/agent/payees.md", insert_line: 0, insert_text: "x" },
  ];
  const memoryHarness = (input: Record<string, unknown>) =>
    harness({
      policy: { default: "allow" },
      files: { "agent/payees.md": "original" },
      script: [call("c1", "memory", input), say("done")],
    });
  const payees = async (h: Harness) => (await h.memory.readFile("agent/payees.md"))?.content;

  it.each(MEMORY_WRITES)("the real memory tool cannot write in a fork run: %j", async (input) => {
    const h = memoryHarness(input);
    await stagingTurn(h, new FakeSink());
    expect(resultOf(h, "c1")?.output).toEqual(REFUSED);
    expect(await payees(h)).toBe("original");
  });

  it("the real memory tool still views in a fork run", async () => {
    const h = memoryHarness({ command: "view", path: "/memories/agent/payees.md" });
    await stagingTurn(h, new FakeSink());
    expect(JSON.stringify(resultOf(h, "c1")?.output)).toContain("original");
  });
});

describe("fork origin: what stays as it was", () => {
  it("a live always grant still stages and does not run", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__reminders_create: "allow" } },
      script: [call("c1", "mcp__apple__reminders_create", { title: "Water" }), say("done")],
    });
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write", {
      grantKey: "reminders_create|calendar:water",
    });
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.staging).toEqual(FORK);
  });

  it("deny is unchanged: the sink is not asked", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__reminders_create: "deny" } },
      script: [call("c1", "mcp__apple__reminders_create", { title: "Water" }), say("done")],
    });
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(0);
    expect(JSON.stringify(resultOf(h, "c1")?.output)).not.toContain("plan");
  });

  it("a before_tool_call hook can still block a stageable call", async () => {
    const h = harness({
      loop: { hooks: { before_tool_call: () => ({ action: "block", reason: "not now" }) } },
      script: [call("c1", "mcp__apple__reminders_create", { title: "Water" }), say("done")],
    });
    conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(sink.calls).toHaveLength(0);
    expect(JSON.stringify(resultOf(h, "c1")?.output)).toContain("not now");
  });

  it.each(["throw", "refuse"] as const)("a sink that %ss means {staged:false}", async (mode) => {
    const h = harness({
      script: [call("c1", "mcp__apple__reminders_create", { title: "Water" }), say("done")],
    });
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    sink.mode = mode;
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(resultOf(h, "c1")?.output).toEqual(REFUSED);
    expect(JSON.stringify(resultOf(h, "c1")?.output)).not.toContain("disk full");
  });

  it("a read runs with taint as usual, and a later stage carries the taint and the fork origin", async () => {
    const h = harness({
      script: [
        call("r1", "mcp__apple__mail_search", { query: "lunch" }),
        call("c1", "mcp__apple__reminders_create", { title: "Water" }),
        say("done"),
      ],
    });
    const read = conn(h, "apple", "mail_search", "mail.read", "read", {
      provenanceOut: "untrusted",
    });
    conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(read.ran).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ taint: true, staging: FORK });
  });

  it("a subagent of a fork run stages under the same origin", async () => {
    const h: Harness = harness({
      policy: { byTool: { mcp__apple__reminders_create: "allow" } },
      script: [
        call("s1", "subagent.spawn", { context: "fresh", title: "plan", brief: "Prepare" }),
        call("k1", "mcp__apple__reminders_create", { title: "Water" }),
        say("Prepared one."),
        say("All prepared."),
      ],
    } satisfies HarnessOptions);
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ toolCallId: "k1", staging: FORK });
  });

  it("a fork run refuses task.start, schedule and notify", async () => {
    const h = harness({
      script: [
        calls(
          { id: "t1", name: "task.start", input: { title: "t", goal: "g" } },
          { id: "t2", name: "schedule", input: { prompt: "x", cron: "0 9 * * *" } },
        ),
        say("done"),
      ],
    });
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(sink.calls).toHaveLength(0);
    expect(await h.tasks.list()).toHaveLength(0);
  });

  it("the model cannot start a task that carries a fork staging block", async () => {
    const h = harness({
      script: [
        call("t1", "task.start", {
          title: "t",
          goal: "g",
          staging: { kind: "fork", forkId: "fork_x", branchId: "br_x" },
        }),
        say("done"),
      ],
    });
    await runTurn(h, "start a task");
    expect(JSON.stringify(resultOf(h, "t1", 1)?.output)).toContain("invalid params");
    expect(await h.tasks.list()).toHaveLength(0);
  });
});

describe("fork origin: a read that decides ask is refused and raises no card", () => {
  const readAsk = () =>
    harness({
      policy: { byTool: { mcp__apple__mail_search: "ask" } },
      script: [call("r1", "mcp__apple__mail_search", { query: "lunch" }), say("done")],
    });

  it("the model is told to list it as an open question; no approval is issued", async () => {
    const h = readAsk();
    const read = conn(h, "apple", "mail_search", "mail.read", "read");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(read.ran).toHaveLength(0);
    expect(h.broker.issued).toHaveLength(0);
    expect(await h.broker.list({ status: "pending" })).toHaveLength(0);
    expect(resultOf(h, "r1")?.output).toEqual({
      staged: false,
      note: "needs the owner's OK; list it under open questions",
    });
    expect(resultOf(h, "r1")?.isError).toBe(true);
  });

  it("control: the same read runs when the broker allows it", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__mail_search: "allow" } },
      script: [call("r1", "mcp__apple__mail_search", { query: "lunch" }), say("done")],
    });
    const read = conn(h, "apple", "mail_search", "mail.read", "read");
    await stagingTurn(h, new FakeSink());
    expect(read.ran).toHaveLength(1);
  });

  it("a night run keeps its own note for the same call (the two notes stay apart)", async () => {
    const h = readAsk();
    const read = conn(h, "apple", "mail_search", "mail.read", "read");
    await stagingTurn(h, new FakeSink(), NIGHT);
    expect(read.ran).toHaveLength(0);
    expect(resultOf(h, "r1")?.output).toEqual({
      staged: false,
      note: "can't be prepared overnight",
    });
  });

  it("a write that decides ask under a fork is staged, not asked", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__reminders_create: "ask" } },
      script: [call("c1", "mcp__apple__reminders_create", { title: "Water" }), say("done")],
    });
    conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(sink.calls).toHaveLength(1);
    expect(h.broker.issued).toHaveLength(0);
  });
});

describe("fork origin: a hook that asks is a block, and its card is withdrawn", () => {
  async function hookAsk(tool: string, bare: string, sideEffect: SideEffect, args: object) {
    let issuedId: string | undefined;
    const holder: { h?: Harness } = {};
    const h = harness({
      loop: {
        hooks: {
          before_tool_call: async (ctx) => {
            const issued = await (holder.h as Harness).broker.requestApproval({
              kind: "connector_action",
              summary: "hook card",
              details: {},
              bindingHash: "bh",
              grantKey: "gk",
              requestedBy: {
                runId: ctx.runId,
                taskId: null,
                threadId: ctx.threadId,
                toolCallId: ctx.toolCallId,
              },
              sideEffect: "write",
              surfaces: ["desktop"],
              taint: false,
            });
            issuedId = issued.approval.id;
            return { action: "suspend", approvalId: issued.approval.id };
          },
        },
      },
      script: [call("c1", tool, args), say("done")],
    });
    holder.h = h;
    const t = conn(
      h,
      "apple",
      bare,
      bare.startsWith("mail_search") ? "mail.read" : "reminders.write",
      sideEffect,
    );
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    return { h, t, sink, issuedId };
  }

  it.each([
    {
      label: "a write",
      bare: "reminders_create",
      sideEffect: "write" as const,
      args: { title: "Water" },
    },
    { label: "a read", bare: "mail_search", sideEffect: "read" as const, args: { query: "lunch" } },
  ])("$label: nothing runs, nothing is staged, the card is invalidated", async (row) => {
    const { h, t, sink, issuedId } = await hookAsk(
      `mcp__apple__${row.bare}`,
      row.bare,
      row.sideEffect,
      row.args,
    );
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(0);
    expect(JSON.stringify(resultOf(h, "c1")?.output)).toContain("staging run");
    expect(issuedId).toBeDefined();
    expect((await h.broker.get(issuedId as string))?.status).toBe("invalidated");
    expect(await h.broker.list({ status: "pending" })).toHaveLength(0);
  });
});
