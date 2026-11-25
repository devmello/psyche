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
import {
  NEVER_STAGED_KINDS,
  STAGEABLE_TOOLS,
  type StageCheckInput,
  stageVerdict,
} from "../src/staging.ts";
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
  start,
  turnInput,
  until,
} from "./harness.ts";

/**
 * Night shift W1 (docs/design/night-shift-2026.md §2.2, §2.3, §3.1): the staging branch of the
 * loop's gate. Two-way probe tables: every allowlisted tool stages, every near-miss that shares a
 * name, a word or a kind with one is refused, and a refusal runs nothing and raises no card.
 */

const NIGHT: Staging = { kind: "night", nightId: "night_1" };
const FORK: Staging = { kind: "fork", forkId: "fork_1", branchId: "br_1" };

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
  staging: Staging = NIGHT,
  text = "prepare the morning",
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
    args: { to: ["sam@example.org"], subject: "Notes", body: "The notes are attached." },
  },
  {
    id: "mail",
    bare: "mail_create_draft",
    action: "mail.draft",
    args: { to: ["sam@example.org"], subject: "Notes", body: "The notes." },
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

describe("staging gate: the allowlist", () => {
  it("lists exactly the tools the table below covers", () => {
    expect([...STAGEABLE_TOOLS.keys()].sort()).toEqual(ALLOWED.map((a) => a.bare).sort());
  });

  it.each(ALLOWED)("$id $bare stages and does not run", async (row) => {
    const h = harness({
      script: [call("c1", `mcp__${row.id}__${row.bare}`, row.args), say("done")],
    });
    const t = conn(h, row.id, row.bare, row.action, "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(1);
    const staged = sink.calls[0] as StagedCall;
    expect(staged).toMatchObject({
      staging: NIGHT,
      tool: t.name,
      connector: { id: row.id, action: row.action },
      sideEffect: "write",
      params: row.args,
      toolCallId: "c1",
      taint: false,
    });
    expect(staged.paramsHash).toMatch(/\S/);
    expect(staged.bindingHash).toMatch(/\S/);
    const result = resultOf(h, "c1");
    expect(result?.isError).toBeFalsy();
    expect(result?.output).toEqual({
      staged: true,
      stagedId: "stg_1",
      note: "recorded for the owner's morning review; it has not happened and returns no result",
    });
    // No approval card in a staging run, and the broker was asked about the call first.
    expect(h.broker.issued).toHaveLength(0);
    expect(h.broker.decisions).toHaveLength(1);
  });

  it("control: the same call outside a staging run raises its card or runs", async () => {
    const h = harness({
      script: [
        call("c1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("done"),
      ],
    });
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
    const run = start(h, "remind me", { mode: "attended" });
    await until(() => h.broker.issued.length === 1 || t.ran.length === 1, "card or run");
    run.done.catch(() => undefined);
    expect(h.broker.issued.length + t.ran.length).toBeGreaterThan(0);
  });

  it("a fork run stages through the same gate with the fork's notes", async () => {
    const h = harness({
      script: [
        calls(
          { id: "c1", name: "mcp__apple__reminders_create", input: { title: "Water the plants" } },
          { id: "c2", name: "mcp__apple__mail_send", input: { to: ["a@example.org"], body: "Hi" } },
        ),
        say("done"),
      ],
    });
    conn(h, "apple", "reminders_create", "reminders.write", "write");
    conn(h, "apple", "mail_send", "mail.send", "write", { kind: "send_email" });
    const sink = new FakeSink();
    await stagingTurn(h, sink, FORK);
    expect(sink.calls.map((c) => c.staging)).toEqual([FORK]);
    expect(JSON.stringify(resultOf(h, "c1")?.output)).toMatch(/plan's branch/);
    expect(resultOf(h, "c2")?.output).toEqual({
      staged: false,
      note: "not prepared in a plan; add it as a step",
    });
  });
});

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
    label: "money text in an allowlisted call",
    id: "apple",
    bare: "reminders_create",
    action: "reminders.write",
    sideEffect: "write",
    args: { title: "Send $50 to Sam" },
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

describe("staging gate: near-misses are refused", () => {
  it.each(NEAR_MISSES)("$label: nothing runs, nothing is staged, no card", async (row) => {
    const h = harness({
      script: [call("c1", `mcp__${row.id}__${row.bare}`, row.args), say("done")],
    });
    const t = conn(h, row.id, row.bare, row.action, row.sideEffect, row.opts);
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(0);
    expect(resultOf(h, "c1")?.output).toEqual({
      staged: false,
      note: "can't be prepared overnight",
    });
    expect(resultOf(h, "c1")?.isError).toBe(true);
    expect(h.broker.issued).toHaveLength(0);
  });

  it("a tool registered under a plain (non-connector) name is refused even when allowlisted", async () => {
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

/** The pure rule, two ways: what stages, and the near-misses that share a name or a word. */
describe("stageVerdict", () => {
  const base: StageCheckInput = {
    tool: "mcp__apple__reminders_create",
    sideEffect: "write",
    summary: "Created a reminder",
    args: { title: "Water the plants" },
    connectorRule: { id: "apple", action: "reminders.write" },
  };
  const yes = [
    { label: "plain reminder", input: base },
    {
      label: "a narrowed connector action",
      input: { ...base, connectorRule: { id: "apple", action: "reminders.write/list" } },
    },
    {
      label: "a calendar event on one's own",
      input: {
        ...base,
        tool: "mcp__apple__calendar_create_event",
        connectorRule: { id: "apple", action: "calendar.write" },
        args: { title: "Dentist" },
        kind: "calendar_write" as ApprovalKind,
      },
    },
    {
      label: "an ordinary word that shares a stem with money (checkout of a book)",
      input: { ...base, args: { title: "Return the library book" } },
    },
    {
      label: "a calendar event with an empty attendee list",
      input: {
        ...base,
        tool: "mcp__apple__calendar_create_event",
        connectorRule: { id: "apple", action: "calendar.write" },
        args: { title: "Dentist", attendees: [] },
      },
    },
    {
      label: "a connector id with a hyphen",
      input: {
        ...base,
        tool: "mcp__apple-2__reminders_create",
        connectorRule: { id: "apple-2", action: "reminders.write" },
      },
    },
  ];
  const no: { label: string; input: StageCheckInput }[] = [
    { label: "financial side effect", input: { ...base, sideEffect: "financial" } },
    { label: "destructive side effect", input: { ...base, sideEffect: "destructive" } },
    { label: "read side effect is not a stage", input: { ...base, sideEffect: "read" } },
    { label: "no connector rule", input: { ...base, connectorRule: undefined } },
    {
      label: "rule of another connector",
      input: { ...base, connectorRule: { id: "google", action: "reminders.write" } },
    },
    {
      label: "prefix trick on the action",
      input: { ...base, connectorRule: { id: "apple", action: "reminders.writeall" } },
    },
    { label: "bare tool name", input: { ...base, tool: "reminders_create" } },
    { label: "case trick on the tool", input: { ...base, tool: "mcp__apple__Reminders_Create" } },
    {
      label: "trailing space on the tool",
      input: { ...base, tool: "mcp__apple__reminders_create " },
    },
    { label: "money in the summary", input: { ...base, summary: "Send $50 to Sam" } },
    { label: "money in a key", input: { ...base, args: { "Send $50 to Sam": 1 } } },
    {
      label: "money in a deep string",
      input: { ...base, args: { a: { b: [{ c: "Pay $20 now" }] } } },
    },
    {
      label: "an over-deep argument tree",
      input: { ...base, args: JSON.parse(`${"[".repeat(40)}"x"${"]".repeat(40)}`) },
    },
    {
      label: "attendees",
      input: {
        ...base,
        tool: "mcp__apple__calendar_create_event",
        connectorRule: { id: "apple", action: "calendar.write" },
        args: { attendees: ["x@example.org"] },
      },
    },
    {
      label: "invitees",
      input: {
        ...base,
        tool: "mcp__apple__calendar_create_event",
        connectorRule: { id: "apple", action: "calendar.write" },
        args: { Invitees: ["x@example.org"] },
      },
    },
    {
      label: "a delete word in the tool",
      input: { ...base, tool: "mcp__apple__reminders_create_or_delete" },
    },
    {
      label: "approval kind from the broker is an AUTH kind",
      input: { ...base, approvalKind: "exec_host" },
    },
    { label: "the call's kind is a send", input: { ...base, kind: "send_email" } },
    { label: "a kind outside the stageable set", input: { ...base, kind: "exec" } },
  ];
  it.each(yes)("stages: $label", ({ input }) => {
    expect(stageVerdict(input)).toMatchObject({ stage: true });
  });
  it.each(no)("refuses: $label", ({ input }) => {
    expect(stageVerdict(input)).toMatchObject({ stage: false });
  });
});

describe("staging gate: what stays as it was", () => {
  it("a live always grant still stages and does not run", async () => {
    const h = harness({
      script: [
        call("a1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("added"),
        call("c1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("done"),
      ],
    });
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write", {
      grantKey: "reminders:default",
    });
    // The owner approved this action with "always" earlier.
    const first = start(h, "remind me", { mode: "attended" });
    await until(() => h.broker.issued.length === 1, "approval card");
    const issued = h.broker.issued[0];
    if (issued === undefined) throw new Error("no card");
    h.clock.advance(500);
    const surface = Object.keys(issued.answerTokens)[0] as string;
    await h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens[surface] as string,
      decision: "approve",
      scope: "always",
      decidedBy: { deviceId: "dev_owner", surface },
    });
    await first.done;
    expect(t.ran).toHaveLength(1);
    // Overnight the grant allows it at the broker, and the gate stages it anyway.
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(h.broker.decisions.at(-1)?.result.rule).toMatch(/^grant:/);
    expect(t.ran).toHaveLength(1);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.decisionRule).toMatch(/^grant:/);
    expect(resultOf(h, "c1", 3)?.output).toMatchObject({ staged: true });
    expect(h.broker.issued).toHaveLength(1);
  });

  it("an allow decision still stages", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__reminders_create: "allow" } },
      script: [
        call("c1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("done"),
      ],
    });
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(h.broker.decisions[0]?.result.decision).toBe("allow");
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(1);
  });

  it("deny is unchanged: the model gets the denial and the sink is not asked", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__reminders_create: "deny" } },
      script: [
        call("c1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("done"),
      ],
    });
    conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(sink.calls).toHaveLength(0);
    const out = resultOf(h, "c1");
    expect(JSON.stringify(out?.output)).toContain("denied");
    expect(out?.output).not.toHaveProperty("staged");
  });

  it("reads run, with taint as usual, and a later stage carries the taint", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__mail_search: "allow" } },
      script: [
        call("r1", "mcp__apple__mail_search", { query: "lunch" }),
        call("c1", "mcp__apple__reminders_create", { title: "Reply about lunch" }),
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
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ taint: true });
    expect(sink.calls[0]?.taintSources.length).toBeGreaterThan(0);
  });

  it("a read that would ask is refused with no card", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__mail_search: "ask" } },
      script: [call("r1", "mcp__apple__mail_search", { query: "lunch" }), say("done")],
    });
    const read = conn(h, "apple", "mail_search", "mail.read", "read");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(read.ran).toHaveLength(0);
    expect(h.broker.issued).toHaveLength(0);
    expect(resultOf(h, "r1")?.output).toMatchObject({ staged: false });
  });

  it("a before_tool_call hook can still block a stageable call", async () => {
    const h = harness({
      loop: { hooks: { before_tool_call: () => ({ action: "block", reason: "not tonight" }) } },
      script: [
        call("c1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("done"),
      ],
    });
    conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(sink.calls).toHaveLength(0);
    expect(JSON.stringify(resultOf(h, "c1")?.output)).toContain("not tonight");
    expect(h.broker.decisions).toHaveLength(0);
  });

  it("a hook that asks is a block in a staging run, not a wait", async () => {
    const h = harness({
      loop: { hooks: { before_tool_call: () => ({ action: "suspend", approvalId: "apr_hook" }) } },
      script: [
        call("c1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("done"),
      ],
    });
    conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(sink.calls).toHaveLength(0);
    expect(JSON.stringify(resultOf(h, "c1")?.output)).toContain("staging run");
  });

  it.each(["throw", "refuse"] as const)(
    "a sink that %ss means {staged:false} and nothing runs",
    async (mode) => {
      const h = harness({
        script: [
          call("c1", "mcp__apple__reminders_create", { title: "Water the plants" }),
          say("done"),
        ],
      });
      const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
      const sink = new FakeSink();
      sink.mode = mode;
      await stagingTurn(h, sink);
      expect(sink.calls).toHaveLength(1);
      expect(t.ran).toHaveLength(0);
      expect(resultOf(h, "c1")?.output).toEqual({
        staged: false,
        note: "can't be prepared overnight",
      });
      expect(JSON.stringify(resultOf(h, "c1")?.output)).not.toContain("disk full");
    },
  );

  it("a subagent of a staging run stages too", async () => {
    const h: Harness = harness({
      policy: { byTool: { mcp__apple__reminders_create: "allow" } },
      script: [
        call("s1", "subagent.spawn", {
          context: "fresh",
          title: "plan",
          brief: "Prepare reminders",
        }),
        call("k1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("Prepared one."),
        say("All prepared."),
      ],
    } satisfies HarnessOptions);
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
    const sink = new FakeSink();
    await stagingTurn(h, sink);
    expect(t.ran).toHaveLength(0);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.toolCallId).toBe("k1");
  });

  it("control: the same subagent write outside a staging run is allowed to run", async () => {
    const h = harness({
      policy: { byTool: { mcp__apple__reminders_create: "allow" } },
      script: [
        call("s1", "subagent.spawn", {
          context: "fresh",
          title: "plan",
          brief: "Prepare reminders",
        }),
        call("k1", "mcp__apple__reminders_create", { title: "Water the plants" }),
        say("Prepared one."),
        say("All prepared."),
      ],
    });
    const t = conn(h, "apple", "reminders_create", "reminders.write", "write");
    await runTurn(h, "prepare");
    expect(t.ran).toHaveLength(1);
  });

  it("the model cannot start a task that carries staging (or one that does not)", async () => {
    const h = harness({
      script: [
        call("t1", "task.start", {
          title: "t",
          goal: "g",
          staging: { kind: "night", nightId: "night_x" },
        }),
        say("done"),
      ],
    });
    await runTurn(h, "start a task");
    expect(JSON.stringify(resultOf(h, "t1", 1)?.output)).toContain("invalid params");
    expect(await h.tasks.list()).toHaveLength(0);
  });

  it("a staging run refuses task.start, schedule and notify, and an MCP tool of the same name", async () => {
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
});
