import type { AgentEvent, SideEffect, StagingSink } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { STAGING_DOMAIN_READS, stagingToolVisible } from "../src/staging.ts";
import {
  call,
  type Harness,
  harness,
  recorder,
  resultsIn,
  say,
  spec,
  turnInput,
} from "./harness.ts";

/**
 * Night shift W4 (docs/design/night-shift-2026.md §3.1): the per-job toolset. A staging task's
 * registry holds only its own domains' tools; browser, computer use, exec, MCP, `web.*`,
 * `machine_files`, `location_current` and the connector-authoring tools are not registered at all.
 * The W1 gate stays the second layer (staging.test.ts).
 */

const TYPES: Record<string, string> = {
  apple: "apple",
  google: "google",
  evil: "custom",
  shop: "shopping",
};
const ALL = new Set(["mail", "calendar", "reminders", "files"]);

const visible = (tool: string, sideEffect: SideEffect, domains: ReadonlySet<string> = ALL) => {
  const id = /^mcp__([a-z0-9-]+)__/.exec(tool)?.[1];
  return stagingToolVisible({
    tool,
    sideEffect,
    connectorType: id === undefined ? undefined : TYPES[id],
    domains,
  });
};

// [tool, side effect, expected]
const TABLE: [string, SideEffect, boolean][] = [
  // The job's own domains: exact reads and exact stageable writes.
  ["mcp__apple__mail_read", "read", true],
  ["mcp__apple__mail_search", "read", true],
  ["mcp__google__gmail_read_thread", "read", true],
  ["mcp__apple__mail_reply_draft", "write", true],
  ["mcp__apple__calendar_list_events", "read", true],
  ["mcp__apple__calendar_update_event", "write", true],
  ["mcp__apple__reminders_create", "write", true],
  ["mcp__apple__files_move", "write", true],
  ["mcp__apple__files_recent", "read", true],
  ["read_file", "read", true],
  ["update_plan", "none", true],
  // Out of scope overnight, whatever their side effect says.
  ["web.fetch", "read", false],
  ["web.search", "read", false],
  ["web_fetch", "read", false],
  ["mcp__apple__web_fetch", "read", false],
  ["machine_files", "read", false],
  ["location_current", "read", false],
  ["browser.navigate", "read", false],
  ["browser.click", "write", false],
  ["computer.click", "write", false],
  ["computer.screenshot", "read", false],
  ["exec", "write", false],
  ["exec_host", "write", false],
  ["connector_write_file", "none", false],
  ["connector.author", "write", false],
  ["task.start", "write", false],
  ["specialist.spawn", "write", false],
  ["schedule", "write", false],
  // MCP servers and other connector types: unknown semantics.
  ["mcp__evil__mail_read", "read", false],
  ["mcp__evil__mail_reply_draft", "write", false],
  ["mcp__shop__mail_read", "read", false],
  ["mcp__unknown__files_move", "write", false],
  // Near-misses inside a stageable connector: not in the exact lists.
  ["mcp__apple__messages_read", "read", false],
  ["mcp__apple__contacts_search", "read", false],
  ["mcp__apple__mail_selected", "read", false],
  ["mcp__apple__mail_send", "destructive", false],
  ["mcp__apple__mail_send_draft", "write", false],
  ["mcp__apple__mail_forward_draft", "write", false],
  ["mcp__apple__calendar_delete_event", "destructive", false],
  ["mcp__apple__files_trash", "destructive", false],
  ["mcp__apple__notes_create", "write", false],
  // A stageable name that is not a write is not offered as one.
  ["mcp__apple__reminders_create", "read", false],
];

describe("stagingToolVisible: the per-job toolset", () => {
  it.each(TABLE)("%s (%s) -> %s", (tool, effect, expected) => {
    expect(visible(tool, effect)).toBe(expected);
  });

  it("an off domain takes its tools with it (positive control: on)", () => {
    const noMail = new Set(["calendar", "reminders", "files"]);
    const onlyMail = new Set(["mail"]);
    expect(visible("mcp__apple__mail_read", "read", ALL)).toBe(true);
    expect(visible("mcp__apple__mail_read", "read", noMail)).toBe(false);
    expect(visible("mcp__apple__mail_reply_draft", "write", noMail)).toBe(false);
    expect(visible("mcp__apple__reminders_create", "write", noMail)).toBe(true);
    expect(visible("mcp__apple__reminders_create", "write", onlyMail)).toBe(false);
    expect(visible("read_file", "read", onlyMail)).toBe(false);
    expect(visible("read_file", "read", ALL)).toBe(true);
  });

  it("no read in the per-domain lists is a write-capable or non-domain tool", () => {
    for (const reads of Object.values(STAGING_DOMAIN_READS)) {
      for (const r of reads) expect(r).not.toMatch(/send|delete|trash|forward|draft|create|update/);
    }
  });
});

const NAMES: [string, SideEffect][] = [
  ["web.fetch", "read"],
  ["machine_files", "read"],
  ["location_current", "read"],
  ["browser.navigate", "read"],
  ["computer.click", "write"],
  ["exec_host", "write"],
  ["connector_write_file", "none"],
  ["mcp__evil__mail_read", "read"],
  ["mcp__apple__messages_read", "read"],
  ["mcp__apple__mail_read", "read"],
  ["mcp__apple__mail_reply_draft", "write"],
];

function setup() {
  const h = harness({ script: [call("c1", "web.fetch", { url: "https://x.test" }), say("done")] });
  const ran: Record<string, ReturnType<typeof recorder>> = {};
  for (const [name, effect] of NAMES) {
    const r = recorder();
    ran[name] = r;
    h.loop.registry.register({
      spec: spec(name, effect),
      describeCall: () => ({
        kind: "connector_action",
        summary: name,
        ...(name.startsWith("mcp__apple__")
          ? { connectorRule: { id: "apple", action: "mail.read" } }
          : {}),
      }),
      execute: r.execute,
    });
  }
  return { h, ran };
}

const sink: StagingSink = { stage: async () => ({ staged: false as const }) };
const toolAllowed = (h: Harness) => (tool: string) => {
  const reg = h.loop.registry.get(tool);
  const id = /^mcp__([a-z0-9-]+)__/.exec(tool)?.[1];
  return (
    reg !== undefined &&
    stagingToolVisible({
      tool,
      sideEffect: reg.spec.sideEffect,
      connectorType: id === undefined ? undefined : TYPES[id],
      domains: ALL,
    })
  );
};

async function turn(h: Harness, allowed?: (t: string) => boolean) {
  const events: AgentEvent[] = [];
  const input = {
    ...turnInput("prepare", { mode: "unattended" }),
    staging: {
      staging: { kind: "night" as const, nightId: "n1" },
      sink,
      ...(allowed === undefined ? {} : { toolAllowed: allowed }),
    },
  };
  for await (const e of h.loop.startTurn(input)) events.push(e);
  return events;
}

const offered = (h: Harness) => new Set((h.provider.requests[0]?.tools ?? []).map((t) => t.name));

describe("a staging run's registry", () => {
  it("does not offer browser, computer use, exec, MCP, web, machine_files or location tools", async () => {
    const { h } = setup();
    await turn(h, toolAllowed(h));
    const names = offered(h);
    for (const gone of [
      "web.fetch",
      "machine_files",
      "location_current",
      "browser.navigate",
      "computer.click",
      "exec_host",
      "connector_write_file",
      "mcp__evil__mail_read",
      "mcp__apple__messages_read",
    ]) {
      expect(names.has(gone), gone).toBe(false);
    }
    // Positive control: its own domain's tools are there.
    expect(names.has("mcp__apple__mail_read")).toBe(true);
    expect(names.has("mcp__apple__mail_reply_draft")).toBe(true);
  });

  it("offers them without the toolset (the control that the absence above is the toolset's doing)", async () => {
    const { h } = setup();
    await turn(h);
    const names = offered(h);
    expect(names.has("web.fetch")).toBe(true);
    expect(names.has("machine_files")).toBe(true);
  });

  it("a call to an absent tool by name runs nothing", async () => {
    const { h, ran } = setup();
    await turn(h, toolAllowed(h));
    expect(ran["web.fetch"]?.seen).toHaveLength(0);
    const r = resultsIn(h.provider.requests[1]).get("c1");
    expect(r?.isError).toBe(true);
  });
});
