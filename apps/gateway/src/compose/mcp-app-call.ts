import { getRun, getToolCall } from "@psyche/db";
import { mcpToolName, parseMcpToolName } from "@psyche/mcp-host";
import {
  type MethodParams,
  type MethodResult,
  type ProposedCall,
  PsycheError,
  type TaintSource,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/**
 * `mcp.app.call` (generative-ui-2026 P9): a tool call an MCP App panel makes for its page. The
 * caller never names a server. It names the transcript tool call that showed the app, and the
 * server is that call's own: an app can only reach its own server's tools, never another server's
 * and never a Psyche tool. The call then goes through the same turn path as a widget button's
 * proposal and a model's call (the broker, rules, approval card, money checks, receipts), tainted
 * because the app's arguments are untrusted. The result comes back to the panel; no model runs.
 */

/** The largest arguments object an app may send (the frame is capped lower still). */
export const APP_CALL_MAX_ARGS_BYTES = 64 * 1024;
/** The largest result handed back to the page. */
export const APP_CALL_MAX_RESULT_BYTES = 256 * 1024;

export interface McpAppCallDeps {
  running(serverId: string): boolean;
  withheld(serverId: string, tool: string): boolean;
  host: {
    appResources(serverId: string): { tool: string; resourceUri: string }[];
    listTools(serverId: string): Promise<{ tools: { name: string }[] }>;
  };
  /** The tool and chat of a transcript tool call; `undefined` for an unknown one. */
  origin(call: Call, toolCallId: string): { tool: string; threadId: string } | undefined;
}

export function dbOrigin(call: Call, toolCallId: string) {
  const tc = getToolCall(call.ctx.db, toolCallId);
  if (tc === undefined) return undefined;
  const run = getRun(call.ctx.db, tc.runId);
  return run === undefined ? undefined : { tool: tc.tool, threadId: run.threadId };
}

type Result = MethodResult<"mcp.app.call">;

function shown(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text === "{}" ? "" : ` with ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`;
}

export function mcpAppCallHandler(deps: McpAppCallDeps): HandlerDef {
  return {
    async run(call: Call, p: MethodParams<"mcp.app.call">): Promise<Result> {
      const origin = deps.origin(call, p.toolCallId);
      const parsed = origin === undefined ? undefined : parseMcpToolName(origin.tool);
      if (origin === undefined || parsed === undefined) {
        throw new PsycheError("not_found", "That app is not in this chat.");
      }
      const { serverId } = parsed;
      const decl = deps.host
        .appResources(serverId)
        .find((a) => mcpToolName(serverId, a.tool) === origin.tool);
      if (!deps.running(serverId) || decl === undefined || deps.withheld(serverId, decl.tool)) {
        throw new PsycheError("unavailable", "This app's server is not running.");
      }
      const args = p.arguments ?? {};
      if (Buffer.byteLength(JSON.stringify(args), "utf8") > APP_CALL_MAX_ARGS_BYTES) {
        throw new PsycheError("invalid_params", "The app sent too much data in one call.");
      }
      // The target is built from the origin's server and the bare name: no other namespace exists.
      const target = mcpToolName(serverId, p.name);
      const listed = (await deps.host.listTools(serverId)).tools.find((t) => t.name === target);
      if (listed === undefined) {
        throw new PsycheError("not_found", `${serverId} has no tool ${p.name}.`);
      }
      if (deps.withheld(serverId, p.name)) {
        throw new PsycheError("forbidden", `${p.name} is turned off for ${serverId}.`);
      }

      let settle!: (r: { isError: boolean; output: unknown }) => void;
      const done = new Promise<{ isError: boolean; output: unknown }>((res) => {
        settle = res;
      });
      let settled = false;
      const proposed: ProposedCall = {
        tool: target,
        input: structuredClone(args),
        only: true,
        initiator: "mcp_app",
        onResult: (r) => {
          if (settled) return;
          settled = true;
          settle(r);
        },
      };
      const taintSources: TaintSource[] = [
        { sourceKind: "mcp_app", origin: serverId, toolCallId: p.toolCallId },
      ];
      // The owner reads the tool and every argument in the chat; the text is the app's, so it
      // names no targets (§7.3).
      const content = `Run ${target}${shown(args)}`;
      const events: Array<() => void> = [];
      const after: Array<() => void> = [];
      call.ctx.db.sqlite.transaction(() => {
        call.ctx.sessions.send(
          {
            threadId: origin.threadId,
            content,
            deviceId: call.identity.deviceId,
            via: "widget",
            ownerWords: false,
            proposedCall: proposed,
            taintSources,
          },
          {
            emit: (event, payload, threadId) =>
              events.push(() => call.ctx.bus.publish(event, payload, threadId)),
            afterCommit: (fn) => after.push(fn),
          },
        );
      })();
      for (const publish of events) publish();
      for (const fn of after) fn();

      const r = await done;
      let text: string;
      try {
        text = JSON.stringify(r.output ?? null);
      } catch {
        text = "null";
      }
      if (Buffer.byteLength(text, "utf8") > APP_CALL_MAX_RESULT_BYTES) {
        return { isError: true, output: { error: "The result is too large to hand to the app." } };
      }
      return { isError: r.isError, output: r.output ?? null };
    },
  };
}
