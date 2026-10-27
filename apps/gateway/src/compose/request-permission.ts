import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import { hashCanonical } from "@psyche/audit";
import {
  MissingPermission,
  type PermissionBroker,
  PsycheError,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { askForFolder } from "./folder-access.ts";

/**
 * `request_permission` (security §3.13): the agent asks for a permission a denial or tool error
 * named as missing, instead of giving up. Each request is one inline card, and the owner decides:
 *
 * - `folder`: the folder card (pick, Allow once / Always allow / Deny; tainted turns once only);
 * - `capability` (`exec_host`) and `connector_action` (a group set to deny): an Enable card on
 *   the Mac with fresh presence. Enabling a capability turns it on in Settings, and loosening a
 *   connector group sets it from deny to ask, so every call still asks. A turn that read untrusted
 *   content cannot change settings (§3.6, no exception): the owner is pointed at Settings;
 * - `connector` (not connected), `macos_access` (TCC) and `sandbox` (srt): a card with the way
 *   to fix it (Connectors, the System Settings pane, the sandbox setup), then "Check again".
 *
 * Nothing is granted by this tool's own arguments, and revoking stays in Settings.
 */

export interface RequestPermissionDeps {
  broker: PermissionBroker;
  surfaces: readonly string[];
  /** Whether `exec_host` is on now. */
  execHostEnabled(): boolean;
  /** Turns `exec_host` on in `permissions.policy` (after the owner's Enable). */
  enableExecHost(): Promise<void>;
  /**
   * Sets one action group from deny to ask (after the owner's Enable) on the connector the key
   * names: a connector id, or the broker's `apple.<app>` for that app's records. False when no
   * connector matches.
   */
  allowConnectorAsk(connector: string, group: string): Promise<boolean>;
  /** Whether the connector is connected now (re-check after the owner's "Check again"). */
  connectorConnected(connector: string): Promise<boolean>;
  /** Whether srt is installed now. */
  sandboxReady(): boolean | Promise<boolean>;
}

function cardText(need: MissingPermission): { summary: string; sideEffect: "write" | "none" } {
  switch (need.need) {
    case "capability":
      return { summary: "Turn on: run commands on this Mac", sideEffect: "write" };
    case "connector_action":
      return {
        summary: `Let ${need.connector} ask before ${need.group}`,
        sideEffect: "write",
      };
    case "connector":
      return { summary: `Connect ${need.connector}`, sideEffect: "none" };
    case "macos_access":
      return { summary: `Give ${need.connector} access in System Settings`, sideEffect: "none" };
    case "sandbox":
      return { summary: "Set up the sandbox", sideEffect: "none" };
    case "folder":
      return { summary: `Share a folder: ${need.path}`, sideEffect: "none" };
  }
}

async function alreadyThere(
  deps: RequestPermissionDeps,
  need: MissingPermission,
): Promise<boolean> {
  if (need.need === "capability") return deps.execHostEnabled();
  if (need.need === "connector") return deps.connectorConnected(need.connector);
  if (need.need === "sandbox") return deps.sandboxReady();
  return false;
}

async function apply(deps: RequestPermissionDeps, need: MissingPermission): Promise<boolean> {
  switch (need.need) {
    case "capability":
      await deps.enableExecHost();
      return true;
    case "connector_action":
      return deps.allowConnectorAsk(need.connector, need.group);
    case "connector":
    case "macos_access":
      return deps.connectorConnected(need.connector);
    case "sandbox":
      return deps.sandboxReady();
    case "folder":
      return false;
  }
}

async function ask(
  deps: RequestPermissionDeps,
  ctx: ToolRunContext,
  need: Exclude<MissingPermission, { need: "folder" }>,
  reason: string,
): Promise<ToolResult> {
  const { summary, sideEffect } = cardText(need);
  if (sideEffect === "write" && ctx.taint) {
    // §3.6: a tainted turn never changes settings, whatever the owner would answer.
    return {
      output: {
        granted: false,
        status: "refused",
        why: "this conversation read untrusted content, so it cannot change settings; tell the owner they can turn it on in Settings",
      },
      provenance: "trusted",
    };
  }
  const binding = hashCanonical({
    tool: "request_permission",
    need,
    reason,
    threadId: ctx.threadId,
    callId: ctx.callId,
  } as never);
  const issued = await deps.broker.requestApproval({
    kind: "permission_request",
    summary: summary.slice(0, 300),
    details: { need, reason },
    bindingHash: binding,
    grantKey: `permission_request|${need.need}`,
    requestedBy: {
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      threadId: ctx.threadId,
      toolCallId: ctx.callId,
    },
    sideEffect,
    surfaces: [...deps.surfaces],
    scopesOffered: ["once"],
    taint: ctx.taint,
    ...(ctx.taint && ctx.taintSources !== undefined ? { taintSources: [...ctx.taintSources] } : {}),
  });
  const done = await deps.broker.awaitDecision(issued.approval.id, ctx.signal);
  if (done.status !== "approved") {
    return { output: { granted: false, status: done.status }, provenance: "trusted" };
  }
  const granted = await apply(deps, need);
  return {
    output: granted
      ? { granted: true, status: "approved", next: "retry the call that was denied" }
      : {
          granted: false,
          status: "still_missing",
          why: "the owner answered, but it is still missing; tell the owner what to do instead of asking again",
        },
    provenance: "trusted",
  };
}

/** `MissingPermission` without the nested `$id`s, which tool schemas sent to models must not carry. */
const Need = Type.Union(MissingPermission.anyOf.map((v) => Type.Object(v.properties)));

export function requestPermissionTool(deps: RequestPermissionDeps): AgentToolRegistration {
  return defineTool({
    name: "request_permission",
    description:
      'Ask the owner for a permission you are missing. When a tool is denied or fails with `Missing permission: {...}` (a folder outside the granted ones, run-commands-on-this-Mac turned off, a connector action set to deny, a connector not connected, macOS access, the sandbox), pass that object as `need` with a one-sentence `reason`. For a folder you may also ask directly: {"need": "folder", "path", "access": "read" | "read_write"} (the owner picks the real folder). The owner decides on a card; retry the denied call only when the reply says `granted: true`, and never ask again after a denial.',
    input: Type.Object({
      need: Need,
      reason: Type.String({ minLength: 1, maxLength: 500, description: "Why, in a sentence" }),
    }),
    sideEffect: "none",
    async run(p, ctx) {
      if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
        throw new PsycheError("forbidden", "only the owner can grant permissions");
      }
      if (ctx.mode === "unattended") {
        throw new PsycheError(
          "approval_required",
          "a permission needs the owner; ask again in a chat turn",
        );
      }
      const need = p.need as MissingPermission;
      if (need.need === "folder") {
        return askForFolder(deps, ctx, { path: need.path, reason: p.reason, access: need.access });
      }
      if (await alreadyThere(deps, need)) {
        return {
          output: { granted: true, status: "already", next: "retry the call" },
          provenance: "trusted",
        };
      }
      return ask(deps, ctx, need, p.reason);
    },
  });
}
