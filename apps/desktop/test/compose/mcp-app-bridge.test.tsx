// @vitest-environment happy-dom

import { APPROVAL_TTL_MS, type McpApp } from "@psyche/protocol";
import { GatewayProvider, McpAppPanel, UiSlotsProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMcpApp } from "../../src/compose/mcp-app.tsx";

afterEach(cleanup);

const TOOL = "mcp__echo__show_chart";
const APP: McpApp = {
  serverId: "echo",
  uri: "ui://echo/chart.html",
  html: "<h1>Chart</h1>",
  csp: {},
  permissions: {},
  provenance: "untrusted",
};

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

async function open(toolCallId: string | undefined) {
  const gateway = new MockGateway({}, { now: () => "2026-11-02T10:00:00.000Z" });
  gateway.mcpApps = { [TOOL]: APP };
  render(
    <GatewayProvider client={gateway}>
      <UiSlotsProvider value={{ renderMcpApp }}>
        <McpAppPanel tool={TOOL} {...(toolCallId === undefined ? {} : { toolCallId })} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  fireEvent.click(await screen.findByTestId("mcp-app-run"));
  // The sandbox frame loads lazily (the viewers stay out of the startup bundle).
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  const frame = document.querySelector("iframe") as HTMLIFrameElement;
  const posted = vi.spyOn(frame.contentWindow as Window, "postMessage");
  const send = (data: unknown, over: { origin?: string; source?: Window } = {}) =>
    act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: over.origin ?? "null",
          source: over.source ?? (frame.contentWindow as Window),
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
  return { gateway, frame, posted, send };
}

/** The MCP Apps JSON-RPC bridge: the panel's one channel from the page to a tool. */
describe("MCP App JSON-RPC bridge", () => {
  it("runs a tool of the app's own server through mcp.app.call and answers the frame", async () => {
    const { send, posted, gateway } = await open("tc_1");
    await send(rpc("tools/call", { name: "show_chart", arguments: { n: 3 } }, "r1"));
    expect(gateway.mcpAppCalls).toEqual([
      { toolCallId: "tc_1", name: "show_chart", arguments: { n: 3 } },
    ]);
    expect(posted).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        id: "r1",
        result: { content: [{ type: "text", text: "ran show_chart" }], isError: false },
      },
      "*",
    );
  });

  it("answers the handshake without calling the Gateway", async () => {
    const { send, posted, gateway } = await open("tc_1");
    await send(rpc("ui/initialize", { protocolVersion: "2026-01-26" }, 5));
    expect(posted.mock.calls[0]?.[0]).toMatchObject({
      id: 5,
      result: { hostInfo: { name: "Psyche" } },
    });
    expect(gateway.mcpAppCalls).toEqual([]);
  });

  it("ignores a message from another window or another origin (positive control: the frame's runs)", async () => {
    const { send, posted, gateway } = await open("tc_1");
    const call = rpc("tools/call", { name: "show_chart" });
    await send(call, { source: window });
    await send(call, { origin: "https://evil.test" });
    expect(gateway.mcpAppCalls).toEqual([]);
    expect(posted).not.toHaveBeenCalled();
    await send(call);
    expect(gateway.mcpAppCalls).toHaveLength(1);
  });

  it("refuses another server's tool, an unknown method and an oversized message", async () => {
    const { send, posted, gateway } = await open("tc_1");
    await send(rpc("tools/call", { name: "mcp__mail__send_mail" }, 1));
    await send(rpc("resources/read", { uri: "file:///private" }, 2));
    await send(rpc("tools/call", { name: "t", arguments: { x: "y".repeat(70_000) } }, 3));
    expect(gateway.mcpAppCalls).toEqual([]);
    const answers = posted.mock.calls.map(
      (c) => c[0] as { id: number; error?: { message: string } },
    );
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3]);
    for (const a of answers) expect(a.error?.message.length ?? 0).toBeGreaterThan(5);
  });

  it("answers a plain JSON-RPC error when the Gateway refuses the call", async () => {
    const { send, posted, gateway } = await open("tc_1");
    const original = gateway.request.bind(gateway);
    gateway.request = ((method: string, params: unknown, options: unknown) =>
      method === "mcp.app.call"
        ? Promise.reject(new Error("This chat is busy; try again when it is done."))
        : (original as (...a: unknown[]) => unknown)(
            method,
            params,
            options,
          )) as typeof gateway.request;
    await send(rpc("tools/call", { name: "show_chart" }, 9));
    expect(posted).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        id: 9,
        error: { code: -32000, message: "This chat is busy; try again when it is done." },
      },
      "*",
    );
  });

  it("gives an app with no transcript tool call no way to call a tool", async () => {
    const { send, posted, gateway } = await open(undefined);
    await send(rpc("tools/call", { name: "show_chart" }));
    expect(gateway.mcpAppCalls).toEqual([]);
    expect(posted.mock.calls[0]?.[0]).toMatchObject({ id: 1, error: { code: -32000 } });
  });

  // The page is untrusted: it must not drain the owner's request budget (rate_limited on
  // chat.send and approvals.answer), so its tool calls are limited in the frame.
  describe("limits on the page", () => {
    const post = (frame: HTMLIFrameElement, data: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: "null",
          source: frame.contentWindow as Window,
        }),
      );
    const answers = (posted: { mock: { calls: unknown[][] } }) =>
      posted.mock.calls.map((c) => c[0] as { id: number; error?: { code: number } });

    it("2000 synchronous posts reach the Gateway at most 5 times", async () => {
      const { frame, posted, gateway } = await open("tc_1");
      await act(async () => {
        for (let i = 0; i < 2000; i += 1) post(frame, rpc("tools/call", { name: "t" }, i));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(gateway.mcpAppCalls.length).toBeLessThanOrEqual(5);
      expect(gateway.mcpAppCalls.length).toBeGreaterThan(0);
      expect(answers(posted).length).toBe(2000);
    });

    it("10 concurrent posts: one request, nine immediate -32000 answers", async () => {
      const { frame, posted, gateway } = await open("tc_1");
      await act(async () => {
        for (let i = 0; i < 10; i += 1) post(frame, rpc("tools/call", { name: "t" }, i));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(gateway.mcpAppCalls).toHaveLength(1);
      const refused = answers(posted).filter((a) => a.error?.code === -32000);
      expect(refused).toHaveLength(9);
    });

    it("an app that awaits each result can make 5 calls in a row, and a 6th at once is slowed", async () => {
      const { send, gateway, posted } = await open("tc_1");
      for (let i = 0; i < 5; i += 1) await send(rpc("tools/call", { name: "t" }, i));
      expect(gateway.mcpAppCalls).toHaveLength(5);
      await send(rpc("tools/call", { name: "t" }, 99));
      expect(gateway.mcpAppCalls).toHaveLength(5);
      expect(answers(posted).at(-1)).toMatchObject({ id: 99, error: { code: -32000 } });
    });
  });

  describe("waiting on the owner", () => {
    it("asks for a timeout as long as an approval card lives", async () => {
      const { send, gateway } = await open("tc_1");
      const seen: unknown[] = [];
      const original = gateway.request.bind(gateway);
      gateway.request = ((method: string, params: unknown, options: unknown) => {
        if (method === "mcp.app.call") seen.push(options);
        return (original as (...a: unknown[]) => unknown)(method, params, options);
      }) as typeof gateway.request;
      await send(rpc("tools/call", { name: "t" }));
      expect(seen).toHaveLength(1);
      expect((seen[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThanOrEqual(APPROVAL_TTL_MS);
    });

    it("a reply 31 seconds later still reaches the frame", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { send, gateway, posted } = await open("tc_1");
        gateway.request = ((method: string) =>
          method === "mcp.app.call"
            ? new Promise<unknown>((resolve) =>
                setTimeout(() => resolve({ isError: false, output: { blocks: [] } }), 31_000),
              )
            : Promise.resolve({})) as unknown as typeof gateway.request;
        await send(rpc("tools/call", { name: "t" }, 4));
        expect(posted).not.toHaveBeenCalled();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
        expect(posted).toHaveBeenCalledWith(
          { jsonrpc: "2.0", id: 4, result: { content: [], isError: false } },
          "*",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
