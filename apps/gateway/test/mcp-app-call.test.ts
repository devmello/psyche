import { PsycheError } from "@psyche/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  APP_CALL_MAX_ARGS_BYTES,
  APP_CALL_MAX_RESULT_BYTES,
  type McpAppCallDeps,
  mcpAppCallHandler,
} from "../src/compose/mcp-app-call.ts";
import type { Call } from "../src/context.ts";

const TC = "tc_app1";

interface Sent {
  threadId: string;
  content: string;
  via?: string;
  ownerWords?: boolean;
  taintSources?: { sourceKind: string; origin?: string; toolCallId?: string }[];
  proposedCall: {
    tool: string;
    input: Record<string, unknown>;
    only?: boolean;
    initiator?: string;
    onResult: (r: { isError: boolean; output: unknown }) => void;
  };
}

function setup(
  over: {
    running?: boolean;
    withheld?: (id: string, tool: string) => boolean;
    origin?: { tool: string; threadId: string } | undefined;
    tools?: string[];
    sendThrows?: Error;
    onSend?: (s: Sent) => void;
  } = {},
) {
  const sent: Sent[] = [];
  const published: string[] = [];
  const deps: McpAppCallDeps = {
    running: (id) => id === "echo" && over.running !== false,
    withheld: over.withheld ?? (() => false),
    host: {
      appResources: (id) =>
        id === "echo" ? [{ tool: "show_chart", resourceUri: "ui://echo/chart.html" }] : [],
      pinnedTools: () => ({
        tools: (over.tools ?? ["mcp__echo__send", "mcp__echo__lookup"]).map((name) => ({ name })),
      }),
    },
    origin: (_c, id) =>
      id === TC
        ? "origin" in over
          ? over.origin
          : { tool: "mcp__echo__show_chart", threadId: "thr_1" }
        : undefined,
  };
  const call = {
    identity: { deviceId: "dev_mac" },
    ctx: {
      db: { sqlite: { transaction: (fn: () => void) => () => fn() } },
      bus: { publish: (e: string) => published.push(e) },
      sessions: {
        send: (
          input: Sent,
          hooks: { emit: (e: string, p: unknown) => void; afterCommit: (f: () => void) => void },
        ) => {
          if (over.sendThrows !== undefined) throw over.sendThrows;
          sent.push(input);
          hooks.emit("chat.message", {});
          hooks.afterCommit(() => over.onSend?.(input));
          return { messageId: "msg_1", runId: "run_1", queued: false };
        },
      },
    },
  } as unknown as Call;
  const handler = mcpAppCallHandler(deps);
  const run = (p: { toolCallId?: string; name: string; arguments?: Record<string, unknown> }) =>
    (handler.run as (c: Call, p: unknown) => Promise<{ isError: boolean; output: unknown }>)(call, {
      toolCallId: TC,
      ...p,
    });
  return { run, sent, published };
}

const ok = { isError: false, output: { blocks: [{ type: "text", text: "done" }] } };

describe("mcp.app.call", () => {
  it("proposes the call as a tainted, from-widget turn on its own server and returns the result", async () => {
    const t = setup({ onSend: (s) => s.proposedCall.onResult(ok) });
    const r = await t.run({ name: "send", arguments: { to: "a@b.c" } });
    expect(r).toEqual(ok);
    expect(t.sent).toHaveLength(1);
    const s = t.sent[0] as Sent;
    expect(s).toMatchObject({
      threadId: "thr_1",
      via: "widget",
      ownerWords: false,
      taintSources: [{ sourceKind: "mcp_app", origin: "echo", toolCallId: TC }],
      proposedCall: {
        tool: "mcp__echo__send",
        input: { to: "a@b.c" },
        only: true,
        initiator: "mcp_app",
      },
    });
    // The owner reads the tool and every argument in the chat.
    expect(s.content).toBe('Run mcp__echo__send with {"to":"a@b.c"}');
    expect(t.published).toEqual(["chat.message"]);
  });

  it("waits for the owner: the result arrives after the approval, not before", async () => {
    let finish: (() => void) | undefined;
    const t = setup({
      onSend: (s) => {
        finish = () => s.proposedCall.onResult(ok);
      },
    });
    let settled = false;
    const p = t.run({ name: "send" }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    finish?.();
    expect(await p).toEqual(ok);
  });

  it("answers the first result only (a turn that ends later cannot change it)", async () => {
    const t = setup({
      onSend: (s) => {
        s.proposedCall.onResult(ok);
        s.proposedCall.onResult({ isError: true, output: { error: "the request ended" } });
      },
    });
    expect(await t.run({ name: "send" })).toEqual(ok);
  });

  it("a refusal from the turn comes back as isError", async () => {
    const t = setup({
      onSend: (s) =>
        s.proposedCall.onResult({ isError: true, output: { error: "denied by your rules" } }),
    });
    expect(await t.run({ name: "send" })).toEqual({
      isError: true,
      output: { error: "denied by your rules" },
    });
  });

  // The server is the origin tool call's, never the caller's: every other namespace fails before a
  // turn is proposed. Positive control above: `send` on echo runs.
  it.each([
    ["a full name of another server", "mcp__other__send"],
    ["a full name of this server", "mcp__echo__send"],
    ["a Psyche tool", "email_send"],
    ["a name this server does not list", "delete_all"],
  ])("refuses %s without proposing anything", async (_label, name) => {
    const t = setup();
    await expect(t.run({ name })).rejects.toMatchObject({ code: "not_found" });
    expect(t.sent).toHaveLength(0);
  });

  it("refuses a tool call that is not in this Gateway, or that is not an app's", async () => {
    const unknown = setup({ origin: undefined });
    await expect(unknown.run({ name: "send" })).rejects.toMatchObject({ code: "not_found" });
    const notApp = setup({ origin: { tool: "mcp__echo__send", threadId: "thr_1" } });
    await expect(notApp.run({ name: "send" })).rejects.toMatchObject({ code: "unavailable" });
    const notMcp = setup({ origin: { tool: "web_fetch", threadId: "thr_1" } });
    await expect(notMcp.run({ name: "send" })).rejects.toMatchObject({ code: "not_found" });
    const otherServer = setup({ origin: { tool: "mcp__ghost__show_chart", threadId: "thr_1" } });
    await expect(otherServer.run({ name: "send" })).rejects.toMatchObject({
      code: "unavailable",
    });
    for (const t of [unknown, notApp, notMcp, otherServer]) expect(t.sent).toHaveLength(0);
  });

  it("refuses when the server stopped, the app's tool is off, or the called tool is off", async () => {
    const stopped = setup({ running: false });
    await expect(stopped.run({ name: "send" })).rejects.toMatchObject({ code: "unavailable" });
    const appOff = setup({ withheld: (_id, tool) => tool === "show_chart" });
    await expect(appOff.run({ name: "send" })).rejects.toMatchObject({ code: "unavailable" });
    const toolOff = setup({ withheld: (_id, tool) => tool === "send" });
    await expect(toolOff.run({ name: "send" })).rejects.toMatchObject({ code: "forbidden" });
    expect(toolOff.sent).toHaveLength(0);
    expect(stopped.sent).toHaveLength(0);
    expect(appOff.sent).toHaveLength(0);
  });

  it("caps the arguments, with a positive control just under the cap", async () => {
    const big = setup();
    await expect(
      big.run({ name: "send", arguments: { x: "y".repeat(APP_CALL_MAX_ARGS_BYTES) } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(big.sent).toHaveLength(0);
    const fits = setup({ onSend: (s) => s.proposedCall.onResult(ok) });
    await fits.run({ name: "send", arguments: { x: "y".repeat(APP_CALL_MAX_ARGS_BYTES - 100) } });
    expect(fits.sent).toHaveLength(1);
  });

  it("does not hand the page a result over the cap", async () => {
    const t = setup({
      onSend: (s) =>
        s.proposedCall.onResult({
          isError: false,
          output: { blocks: [{ type: "text", text: "z".repeat(APP_CALL_MAX_RESULT_BYTES) }] },
        }),
    });
    const r = await t.run({ name: "send" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("zzzz");
  });

  it("passes a busy chat on as a conflict and never queues the call", async () => {
    const t = setup({
      sendThrows: new PsycheError("conflict", "this chat is busy; ask in a new chat"),
    });
    await expect(t.run({ name: "send" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("clones the arguments, so the page cannot change them after the call is proposed", async () => {
    const args = { to: "a@b.c" };
    const spy = vi.fn();
    const t = setup({
      onSend: (s) => {
        spy(s.proposedCall.input);
        s.proposedCall.onResult(ok);
      },
    });
    await t.run({ name: "send", arguments: args });
    args.to = "evil@x.y";
    expect(spy).toHaveBeenCalledWith({ to: "a@b.c" });
  });
});
