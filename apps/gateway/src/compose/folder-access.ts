import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import { hashCanonical } from "@psyche/audit";
import { type FolderGrantEntry, folderScopesOffered } from "@psyche/permissions";
import { type PermissionBroker, PsycheError, type ToolResult } from "@psyche/protocol";
import { Type } from "@sinclair/typebox";

/**
 * `request_folder_access` (security §3.5, "Folder access"): the agent asks for a folder its file
 * tools cannot reach. The owner answers an approval card, picks the folder with the native
 * picker (the pick is what is granted, never this tool's `path`) and chooses Allow once (this
 * conversation) or Always allow (kept in Settings → File access until revoked). A tainted turn
 * is offered Allow once only. The tool never touches the disk: the broker applies the grant
 * before this call returns, so the next file tool call in the same turn already sees the folder.
 */

export interface FolderAccessToolDeps {
  broker: PermissionBroker;
  surfaces: readonly string[];
}

export function requestFolderAccessTool(deps: FolderAccessToolDeps): AgentToolRegistration {
  return defineTool({
    name: "request_folder_access",
    description:
      "Ask the owner for access to a folder your file tools cannot reach (read_file, list_dir, search_files, write_file say it is outside every granted folder). Give the folder you need as `path` (a hint: the owner picks the real folder), why you need it, and `read` or `read_write`. The owner decides; the reply says whether a folder was granted and which one. Ask only for the narrowest folder you need, never for the home folder, and do not ask again after a denial.",
    input: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024, description: "The folder you need" }),
      reason: Type.String({ minLength: 1, maxLength: 500, description: "Why, in a sentence" }),
      access: Type.Union([Type.Literal("read"), Type.Literal("read_write")], {
        description: "read_write only when you must change files there",
      }),
    }),
    sideEffect: "none",
    run: (p, ctx) => askForFolder(deps, ctx, p),
  });
}

/** One folder request card; the reply says whether, and which, folder was granted. */
export async function askForFolder(
  deps: FolderAccessToolDeps,
  ctx: ToolRunContext,
  p: { path: string; reason: string; access: "read" | "read_write" },
): Promise<ToolResult> {
  if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
    throw new PsycheError("forbidden", "only the owner can share a folder");
  }
  if (ctx.mode === "unattended") {
    throw new PsycheError(
      "approval_required",
      "sharing a folder needs the owner; ask again in a chat turn",
    );
  }
  const mode = p.access === "read_write" ? "rw" : "ro";
  const binding = hashCanonical({
    tool: "request_folder_access",
    path: p.path,
    reason: p.reason,
    access: mode,
    threadId: ctx.threadId,
    callId: ctx.callId,
  });
  const issued = await deps.broker.requestApproval({
    kind: "folder_access",
    summary: `Share a folder: ${p.path}`.slice(0, 300),
    details: { requestedPath: p.path, reason: p.reason, access: mode },
    bindingHash: binding,
    grantKey: `folder_access|${mode}`,
    requestedBy: {
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      threadId: ctx.threadId,
      toolCallId: ctx.callId,
    },
    sideEffect: mode === "rw" ? "write" : "read",
    surfaces: [...deps.surfaces],
    scopesOffered: folderScopesOffered(ctx.taint),
    taint: ctx.taint,
    ...(ctx.taint && ctx.taintSources !== undefined
      ? { taintSources: [...ctx.taintSources] }
      : {}),
  });
  const done = await deps.broker.awaitDecision(issued.approval.id, ctx.signal);
  const granted = done.details.granted as FolderGrantEntry | undefined;
  if (done.status !== "approved" || granted === undefined) {
    return { output: { granted: false, status: done.status }, provenance: "trusted" };
  }
  return {
    output: {
      granted: true,
      path: granted.path,
      access: granted.mode === "rw" ? "read_write" : "read",
      until: done.scopeGranted === "always" ? "revoked" : "end of this conversation",
    },
    provenance: "trusted",
  };
}

/** `permissions.policy.folders` with `entry` added (a wider mode replaces a narrower one). */
export function withFolder<P extends { folders?: { path: string; mode: "ro" | "rw" }[] }>(
  policy: P,
  entry: FolderGrantEntry,
): P {
  const folders = [...(policy.folders ?? [])];
  const at = folders.findIndex((f) => f.path === entry.path);
  if (at === -1) folders.push({ ...entry });
  else if (entry.mode === "rw") folders[at] = { ...entry };
  return { ...policy, folders };
}
