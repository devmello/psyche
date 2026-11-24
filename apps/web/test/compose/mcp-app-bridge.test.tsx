// @vitest-environment happy-dom

import type { McpApp } from "@psyche/protocol";
import { GatewayProvider, McpAppPanel, UiSlotsProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
