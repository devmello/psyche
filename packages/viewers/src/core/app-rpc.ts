/**
 * The host half of the MCP Apps JSON-RPC bridge (generative-ui-2026 P9). An MCP App page talks to
 * its host with JSON-RPC 2.0 over `postMessage`. Psyche answers only what the app contract needs
 * to be useful: `ui/initialize` (the handshake), `ui/notifications/initialized`,
 * `ui/notifications/size-changed` and `tools/call`. Every other method is refused.
 *
 * The caller (`ArtifactFrame`) has already checked that the message came from that exact frame's
 * window. This module checks the shape, the method, the size, and that the tool is a bare tool
 * name: an app never names a server (the Gateway ties the call to the server that showed the app),
 * so a `mcp__<server>__<tool>` name, or anything that is not a plain tool name, is refused here.
 */

/** The largest JSON-RPC message the host will look at, in characters (the page is untrusted). */
export const APP_RPC_MAX_CHARS = 64 * 1024;
/** What the handshake advertises. */
export const APP_RPC_PROTOCOL_VERSION = "2026-01-26";

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
/** A server-defined error: the call was refused or failed; the message says why. */
export const JSONRPC_REFUSED = -32000;

export type RpcId = string | number;

export interface AppToolOutcome {
  isError: boolean;
  output: unknown;
}

export interface AppRpcHost {
  /**
   * Runs one tool of the app's own server (bare name). Resolves with the tool's result, or throws
   * an Error whose message is plain text for the app (a refusal, a busy chat, a stopped server).
   */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<AppToolOutcome>;
  /** `ui/notifications/size-changed`: the app's wanted height in CSS pixels. */
  resize?: (height: number) => void;
  /**
   * Limits the page, not the owner: one `tools/call` at a time and a burst budget per frame, so a
   * looping page cannot drain the owner's request budget. Absent: no limit (tests only).
   */
  gate?: ToolCallGate;
}

export interface ToolCallGate {
  /** A release function when the call may go, or the plain refusal for the app. */
  enter(): (() => void) | string;
}

/** Burst of calls a page may make, then one more per second. */
export const APP_CALL_BURST = 5;
export const APP_CALL_REFILL_MS = 1000;

/** One frame's gate: one call in flight, a burst of 5, then 1 per second. */
export function createToolCallGate(now: () => number = Date.now): ToolCallGate {
  let inFlight = false;
  let tokens = APP_CALL_BURST;
  let last = now();
  return {
    enter() {
      if (inFlight) return "The app already has a tool call running; wait for its answer.";
      const t = now();
      tokens = Math.min(APP_CALL_BURST, tokens + (t - last) / APP_CALL_REFILL_MS);
      last = t;
      if (tokens < 1) return "The app is calling tools too fast; wait a moment and try again.";
      tokens -= 1;
      inFlight = true;
      return () => {
        inFlight = false;
      };
    },
  };
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId | null; error: { code: number; message: string } };

const fail = (id: RpcId | null, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a posted value is a JSON-RPC 2.0 message at all (anything else is ignored upstream). */
export function isJsonRpc(data: unknown): boolean {
  return isRecord(data) && data.jsonrpc === "2.0";
}

/** A tool result as an MCP `CallToolResult`. */
export function toCallToolResult(outcome: AppToolOutcome): Record<string, unknown> {
  const out = outcome.output;
  if (isRecord(out) && Array.isArray(out.blocks)) {
    return {
      content: out.blocks,
      ...(out.structured === undefined ? {} : { structuredContent: out.structured }),
      isError: outcome.isError,
    };
  }
  const text =
    isRecord(out) && typeof out.error === "string" ? out.error : (JSON.stringify(out) ?? "null");
  return { content: [{ type: "text", text }], isError: outcome.isError };
}

/**
 * Handles one message from the frame. Returns the response to post back, or `undefined` for a
 * notification, a response, or a message with no usable id (nothing can be answered).
 */
export async function handleAppRpc(
  data: unknown,
  host: AppRpcHost,
): Promise<RpcResponse | undefined> {
  if (!isRecord(data) || data.jsonrpc !== "2.0") return undefined;
  const rawId = data.id;
  const hasId = rawId !== undefined;
  const id: RpcId | null =
    typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId))
      ? rawId
      : null;
  // A response from the page (it answers nothing we asked) is ignored.
  if (typeof data.method !== "string") return undefined;
  let size: number;
  try {
    size = JSON.stringify(data).length;
  } catch {
    return hasId ? fail(id, JSONRPC_INVALID_REQUEST, "That message could not be read.") : undefined;
  }
  if (hasId && id === null)
    return fail(null, JSONRPC_INVALID_REQUEST, "The request id is invalid.");
  const reply = (r: RpcResponse): RpcResponse | undefined => (hasId ? r : undefined);
  if (size > APP_RPC_MAX_CHARS) {
    return reply(fail(id, JSONRPC_INVALID_REQUEST, "That message is too large."));
  }
  const params = data.params;
  switch (data.method) {
    case "ui/initialize":
      return reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: APP_RPC_PROTOCOL_VERSION,
          hostInfo: { name: "Psyche", version: "1" },
          hostCapabilities: host.callTool === undefined ? {} : { serverTools: {} },
          hostContext: {},
        },
      });
    case "ui/notifications/initialized":
      return undefined;
    case "ui/notifications/size-changed": {
      const h = isRecord(params) ? params.height : undefined;
      if (typeof h === "number" && Number.isFinite(h) && h >= 0) {
        host.resize?.(Math.min(Math.round(h), 20_000));
      }
      return undefined;
    }
    case "tools/call": {
      if (!hasId) return undefined;
      if (!isRecord(params) || typeof params.name !== "string") {
        return fail(id, JSONRPC_INVALID_PARAMS, "A tool call needs a tool name.");
      }
      const name = params.name;
      if (name.startsWith("mcp__") || !TOOL_NAME.test(name)) {
        return fail(
          id,
          JSONRPC_REFUSED,
          "An app can only call tools of its own connector, by the tool's own name.",
        );
      }
      const args = params.arguments;
      if (args !== undefined && !isRecord(args)) {
        return fail(id, JSONRPC_INVALID_PARAMS, "Tool arguments must be an object.");
      }
      if (host.callTool === undefined) {
        return fail(id, JSONRPC_REFUSED, "This app cannot call tools here.");
      }
      const admitted = host.gate?.enter() ?? (() => undefined);
      if (typeof admitted === "string") return fail(id, JSONRPC_REFUSED, admitted);
      try {
        const outcome = await host.callTool(name, args ?? {});
        return { jsonrpc: "2.0", id, result: toCallToolResult(outcome) };
      } catch (err) {
        const message =
          err instanceof Error && err.message !== "" ? err.message : "The call failed.";
        return fail(id, JSONRPC_REFUSED, message.slice(0, 500));
      } finally {
        admitted();
      }
    }
    default:
      return reply(fail(id, JSONRPC_METHOD_NOT_FOUND, "That method is not available to apps."));
  }
}
