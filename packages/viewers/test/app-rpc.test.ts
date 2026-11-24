import { describe, expect, it, vi } from "vitest";
import {
  APP_CALL_BURST,
  APP_RPC_MAX_CHARS,
  type AppRpcHost,
  createToolCallGate,
  handleAppRpc,
  isJsonRpc,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_REFUSED,
  toCallToolResult,
} from "../src/core/app-rpc.ts";

const call = (params: unknown, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params,
});

function host(over: Partial<AppRpcHost> = {}) {
  const callTool = vi.fn(async (name: string) => ({
    isError: false,
    output: { blocks: [{ type: "text", text: `ran ${name}` }] },
  }));
  const resize = vi.fn();
  return { callTool, resize, h: { callTool, resize, ...over } as AppRpcHost };
}

describe("handleAppRpc: methods", () => {
  it("answers the handshake and advertises server tools only when the host can call them", async () => {
    const { h } = host();
    const r = await handleAppRpc({ jsonrpc: "2.0", id: "a", method: "ui/initialize" }, h);
    expect(r).toMatchObject({
      id: "a",
      result: { hostInfo: { name: "Psyche" }, hostCapabilities: { serverTools: {} } },
    });
    const none = await handleAppRpc(
      { jsonrpc: "2.0", id: 2, method: "ui/initialize" },
      { resize: () => undefined },
    );
    expect(none).toMatchObject({ result: { hostCapabilities: {} } });
  });

  it("takes initialized and size-changed as notifications: no answer, and the height is clamped", async () => {
    const { h, resize } = host();
    expect(
      await handleAppRpc({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, h),
    ).toBeUndefined();
    expect(
      await handleAppRpc(
        { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 99999 } },
        h,
      ),
    ).toBeUndefined();
    expect(resize).toHaveBeenCalledWith(20000);
    resize.mockClear();
    for (const bad of [{ height: "9" }, { height: -1 }, { height: Number.NaN }, null]) {
      await handleAppRpc(
        { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: bad },
        h,
      );
    }
    expect(resize).not.toHaveBeenCalled();
  });

  it.each([
    "resources/read",
    "prompts/list",
    "sampling/createMessage",
    "ui/open-link",
    "tools/list",
    "mcp.app.call",
    "widgets.act",
    "",
  ])("refuses the method %j", async (method) => {
    const { h, callTool } = host();
    const r = await handleAppRpc({ jsonrpc: "2.0", id: 7, method }, h);
    expect(r).toMatchObject({ id: 7, error: { code: JSONRPC_METHOD_NOT_FOUND } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("ignores what is not a JSON-RPC request: responses, other shapes, version 1", async () => {
    const { h, callTool } = host();
    for (const data of [
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "1.0", id: 1, method: "tools/call", params: { name: "x" } },
      { type: "tool-call", tool: "x" },
      "tools/call",
      null,
      [],
    ]) {
      expect(await handleAppRpc(data, h)).toBeUndefined();
    }
    expect(callTool).not.toHaveBeenCalled();
    expect(isJsonRpc({ jsonrpc: "2.0" })).toBe(true);
    expect(isJsonRpc({ type: "resize" })).toBe(false);
  });
});

describe("handleAppRpc: tools/call", () => {
  it("runs a bare tool name with its arguments and answers an MCP CallToolResult", async () => {
    const { h, callTool } = host();
    const r = await handleAppRpc(call({ name: "show_chart", arguments: { n: 3 } }, "r1"), h);
    expect(callTool).toHaveBeenCalledWith("show_chart", { n: 3 });
    expect(r).toEqual({
      jsonrpc: "2.0",
      id: "r1",
      result: { content: [{ type: "text", text: "ran show_chart" }], isError: false },
    });
  });

  // Positive control: a plain name runs (above); each of these names must not.
  it.each([
    "mcp__other__send_mail",
    "mcp__echo__show_chart",
    "other/tool",
    "../x",
    "a b",
    "x".repeat(65),
    "",
  ])("never calls the name %j", async (name) => {
    const { h, callTool } = host();
    const r = await handleAppRpc(call({ name }), h);
    expect(callTool).not.toHaveBeenCalled();
    expect(r).toMatchObject({ error: expect.objectContaining({ message: expect.any(String) }) });
  });

  it("refuses another server's tool with a plain message", async () => {
    const { h, callTool } = host();
    const r = await handleAppRpc(call({ name: "mcp__other__send_mail" }), h);
    expect(callTool).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      error: { code: JSONRPC_REFUSED, message: expect.stringMatching(/own connector/) },
    });
  });

  it("refuses bad parameters", async () => {
    const { h, callTool } = host();
    for (const params of [undefined, null, [], "x", {}, { name: 5 }]) {
      expect(await handleAppRpc(call(params), h)).toMatchObject({
        error: { code: JSONRPC_INVALID_PARAMS },
      });
    }
    for (const args of ["x", [1], 5, null]) {
      expect(await handleAppRpc(call({ name: "t", arguments: args }), h)).toMatchObject({
        error: { code: JSONRPC_INVALID_PARAMS },
      });
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses a message over the size cap without running anything", async () => {
    const { h, callTool } = host();
    const r = await handleAppRpc(
      call({ name: "t", arguments: { blob: "x".repeat(APP_RPC_MAX_CHARS) } }),
      h,
    );
    expect(r).toMatchObject({ error: { code: JSONRPC_INVALID_REQUEST } });
    expect(callTool).not.toHaveBeenCalled();
    // One just under the cap still runs (positive control).
    const ok = await handleAppRpc(
      call({ name: "t", arguments: { blob: "x".repeat(APP_RPC_MAX_CHARS - 200) } }),
      h,
    );
    expect(ok).toMatchObject({ result: { isError: false } });
  });

  it("refuses a request id that cannot be echoed, and a tools/call with no id answers nothing", async () => {
    const { h, callTool } = host();
    for (const id of [{}, [], true, Number.NaN]) {
      expect(await handleAppRpc(call({ name: "t" }, id), h)).toMatchObject({
        id: null,
        error: { code: JSONRPC_INVALID_REQUEST },
      });
    }
    expect(
      await handleAppRpc({ jsonrpc: "2.0", method: "tools/call", params: { name: "t" } }, h),
    ).toBeUndefined();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("turns a refusal into a JSON-RPC error with the host's plain message", async () => {
    const { h } = host({
      callTool: async () => {
        throw new Error("This chat is busy; try again when it is done.");
      },
    });
    expect(await handleAppRpc(call({ name: "t" }), h)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: JSONRPC_REFUSED, message: "This chat is busy; try again when it is done." },
    });
  });

  it("answers an error when the panel gave the frame no way to call tools", async () => {
    const r = await handleAppRpc(call({ name: "t" }), {});
    expect(r).toMatchObject({ error: { code: JSONRPC_REFUSED } });
  });
});

describe("toCallToolResult", () => {
  it("passes blocks and structured data through, and wraps anything else as text", () => {
    expect(
      toCallToolResult({
        isError: false,
        output: { blocks: [{ type: "text", text: "a" }], structured: { n: 1 } },
      }),
    ).toEqual({
      content: [{ type: "text", text: "a" }],
      structuredContent: { n: 1 },
      isError: false,
    });
    expect(toCallToolResult({ isError: true, output: { error: "denied" } })).toEqual({
      content: [{ type: "text", text: "denied" }],
      isError: true,
    });
    expect(toCallToolResult({ isError: false, output: 5 })).toEqual({
      content: [{ type: "text", text: "5" }],
      isError: false,
    });
  });
});

describe("the page's tool-call gate", () => {
  it("lets one call run at a time and answers the rest at once, without running them", async () => {
    const now = 0;
    const gate = createToolCallGate(() => now);
    let release: (() => void) | undefined;
    const callTool = vi.fn(
      () =>
        new Promise<{ isError: boolean; output: unknown }>((res) => {
          release = () => res({ isError: false, output: {} });
        }),
    );
    const h: AppRpcHost = { callTool, gate };
    const first = handleAppRpc(call({ name: "t" }, 1), h);
    const rest = await Promise.all(
      Array.from({ length: 9 }, (_, i) => handleAppRpc(call({ name: "t" }, i + 2), h)),
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    for (const r of rest) expect(r).toMatchObject({ error: { code: JSONRPC_REFUSED } });
    release?.();
    expect(await first).toMatchObject({ id: 1, result: { isError: false } });
    // Positive control: once the first is done, the next call runs.
    const next = handleAppRpc(call({ name: "t" }, 20), h);
    release?.();
    expect(await next).toMatchObject({ id: 20, result: { isError: false } });
  });

  it("allows a burst of 5, then one a second", async () => {
    let now = 0;
    const gate = createToolCallGate(() => now);
    const callTool = vi.fn(async () => ({ isError: false, output: {} }));
    const h: AppRpcHost = { callTool, gate };
    for (let i = 0; i < APP_CALL_BURST; i += 1) await handleAppRpc(call({ name: "t" }, i), h);
    expect(callTool).toHaveBeenCalledTimes(APP_CALL_BURST);
    expect(await handleAppRpc(call({ name: "t" }, 50), h)).toMatchObject({
      error: { code: JSONRPC_REFUSED },
    });
    now += 1000;
    expect(await handleAppRpc(call({ name: "t" }, 51), h)).toMatchObject({ result: {} });
    expect(callTool).toHaveBeenCalledTimes(APP_CALL_BURST + 1);
    expect(await handleAppRpc(call({ name: "t" }, 52), h)).toMatchObject({ error: {} });
  });

  it("a refused or invalid call does not spend the budget", async () => {
    const gate = createToolCallGate(() => 0);
    const h: AppRpcHost = { callTool: async () => ({ isError: false, output: {} }), gate };
    for (let i = 0; i < 20; i += 1) await handleAppRpc(call({ name: "mcp__x__y" }, i), h);
    for (let i = 0; i < APP_CALL_BURST; i += 1) {
      expect(await handleAppRpc(call({ name: "t" }, 100 + i), h)).toMatchObject({ result: {} });
    }
  });
});
