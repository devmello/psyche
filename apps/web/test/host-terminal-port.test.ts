import { describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "../src/client/connection.ts";
import { hostTerminalPort } from "../src/shell/host-terminal-port.ts";

/** The Host terminal port: a session over the Gateway socket, nothing run locally. */

function fakeGateway(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const listeners = new Set<(e: GatewayEvent) => void>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const gateway = {
    call: vi.fn(async (method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      calls.push({ method, params: p });
      return handler(method, p);
    }),
    onEvent: (cb: (e: GatewayEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  let seq = 0;
  const emit = (event: string, payload: unknown) => {
    for (const cb of listeners) cb({ event, payload, seq: ++seq, stateVersion: 0 });
  };
  return { gateway, calls, emit, listeners };
}

const opened = { sessionId: "term_1", target: "host", label: "zsh · ~" };
const flush = () => new Promise((r) => setTimeout(r, 15));

describe("hostTerminalPort", () => {
  it("opens a Host session and marks it as the Host's", async () => {
    const g = fakeGateway(() => opened);
    const port = hostTerminalPort({ gateway: g.gateway, hostName: "studio-mac" });
    const res = await port.open({ cols: 80, rows: 24, cwd: "/Users/me/code", threadId: "th_1" });
    expect(res).toEqual({ sessionId: "term_1", target: "host", label: "zsh · ~" });
    // Only the window size and folder go to the Host; no program, argv or environment.
    expect(g.calls).toEqual([
      { method: "terminal.session.open", params: { cols: 80, rows: 24, cwd: "/Users/me/code" } },
    ]);
  });

  it("batches keystrokes in order and splits large pastes", async () => {
    const g = fakeGateway(() => ({}));
    const port = hostTerminalPort({ gateway: g.gateway, hostName: "h", writeBatchMs: 1 });
    port.write("term_1", "l");
    port.write("term_1", "s");
    port.write("term_1", "\r");
    await flush();
    expect(g.calls).toEqual([
      { method: "terminal.session.write", params: { sessionId: "term_1", data: "ls\r" } },
    ]);
    g.calls.length = 0;
    port.write("term_1", "x".repeat(40 * 1024));
    await flush();
    const writes = g.calls.map((c) => (c.params.data as string).length);
    expect(writes).toEqual([16 * 1024, 16 * 1024, 8 * 1024]);
  });

  it("hands output to the pane and acks once it is rendered", async () => {
    const g = fakeGateway(() => ({}));
    const port = hostTerminalPort({ gateway: g.gateway, hostName: "h" });
    let render: () => void = () => undefined;
    const seen: string[] = [];
    port.onData((_id, data) => {
      seen.push(data);
      return new Promise<void>((r) => {
        render = r;
      });
    });
    g.emit("terminal.output", { sessionId: "term_1", data: "hello", end: 5 });
    await flush();
    expect(seen).toEqual(["hello"]);
    expect(g.calls).toEqual([]); // not rendered yet: no ack, so the Host stays paused
    render();
    await flush();
    expect(g.calls).toEqual([
      { method: "terminal.session.ack", params: { sessionId: "term_1", end: 5 } },
    ]);
  });

  it("reports the exit, and -1 when the session was ended rather than the shell exiting", async () => {
    const g = fakeGateway(() => ({}));
    const port = hostTerminalPort({ gateway: g.gateway, hostName: "h" });
    const exits: Array<[string, number]> = [];
    port.onExit((id, code) => exits.push([id, code]));
    g.emit("terminal.exit", { sessionId: "a", exitCode: 2, reason: "exited" });
    g.emit("terminal.exit", { sessionId: "b", exitCode: null, reason: "device_revoked" });
    expect(exits).toEqual([
      ["a", 2],
      ["b", -1],
    ]);
  });

  it("closes through the Gateway and stops listening for nothing else", async () => {
    const g = fakeGateway(() => ({ closed: true }));
    const port = hostTerminalPort({ gateway: g.gateway, hostName: "h" });
    port.close("term_1");
    await flush();
    expect(g.calls).toEqual([
      { method: "terminal.session.close", params: { sessionId: "term_1" } },
    ]);
  });

  it("explains a refusal that needs the Host, and a full house, in the window's language", async () => {
    let reason = "host_terminal_needs_presence";
    const g = fakeGateway(() => {
      throw Object.assign(new Error("Open the terminal on studio-mac"), {
        code: reason === "terminal_limit" ? "rate_limited" : "forbidden",
        details: { reason },
      });
    });
    const port = hostTerminalPort({ gateway: g.gateway, hostName: "studio-mac" });
    expect(await port.open({ cols: 80, rows: 24 })).toEqual({
      unavailable: "Open the terminal on studio-mac.",
    });
    reason = "terminal_limit";
    expect(await port.open({ cols: 80, rows: 24 })).toEqual({
      unavailable: "Too many terminals are open on studio-mac. Close one to open another.",
    });
  });

  it("waits for the owner's approval, then opens with it", async () => {
    let first = true;
    const g = fakeGateway((method, params) => {
      if (method === "terminal.session.open") {
        if (first) {
          first = false;
          throw Object.assign(new Error("needs approval"), {
            code: "approval_required",
            details: { approvalId: "ap_1" },
          });
        }
        expect(params.approvalId).toBe("ap_1");
        return opened;
      }
      return { approval: { id: "ap_1", status: "pending" } };
    });
    const port = hostTerminalPort({ gateway: g.gateway, hostName: "studio-mac" });
    const waiting = vi.fn();
    const pending = port.open({ cols: 80, rows: 24, onWaiting: waiting });
    await flush();
    expect(waiting).toHaveBeenCalledTimes(1);
    g.emit("approval.updated", { approval: { id: "other", status: "approved" } });
    g.emit("approval.updated", { approval: { id: "ap_1", status: "approved" } });
    expect(await pending).toEqual({ sessionId: "term_1", target: "host", label: "zsh · ~" });
  });

  it("stops with a message when the approval is denied or never comes", async () => {
    const g = fakeGateway((method) => {
      if (method === "terminal.session.open") {
        throw Object.assign(new Error("needs approval"), {
          code: "approval_required",
          details: { approvalId: "ap_2" },
        });
      }
      return { approval: { id: "ap_2", status: "denied" } };
    });
    const port = hostTerminalPort({ gateway: g.gateway, hostName: "h" });
    expect(await port.open({ cols: 80, rows: 24 })).toEqual({
      unavailable: "The terminal wasn't approved.",
    });
    const slow = fakeGateway((method) => {
      if (method === "terminal.session.open") {
        throw Object.assign(new Error("needs approval"), {
          code: "approval_required",
          details: { approvalId: "ap_3" },
        });
      }
      return { approval: { id: "ap_3", status: "pending" } };
    });
    const timed = hostTerminalPort({ gateway: slow.gateway, hostName: "h", approvalTimeoutMs: 20 });
    expect(await timed.open({ cols: 80, rows: 24 })).toEqual({
      unavailable: "The approval didn't come in time. Open the terminal again.",
    });
  });
});
