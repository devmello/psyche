import { randomUUID } from "node:crypto";
import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import { hashCanonical } from "@psyche/audit";
import {
  type FolderAccessEnv,
  type FolderGrantEntry,
  folderCovers,
  folderScopesOffered,
  resolveRequestedFolder,
} from "@psyche/permissions";
import {
  type PermissionBroker,
  PsycheError,
  type TaintSource,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";

/**
 * `request_folder_access` (security §3.5, "Folder access"): the agent asks for a folder its file
 * tools cannot reach. The owner answers an approval card, picks the folder with the native
 * picker (the pick is what is granted, never this tool's `path`) and chooses Allow once (this
 * conversation) or Always allow (kept in Settings → File access until revoked). In a Space's run
 * the broker also offers Allow in this Space (the folder joins that Space, for its runs only;
 * docs/design/spaces-2026.md §5.3). A tainted turn is offered Allow once only. The tool never touches the disk: the broker applies the grant
 * before this call returns, so the next file tool call in the same turn already sees the folder.
 */

export interface FolderAccessToolDeps {
  broker: PermissionBroker;
  surfaces: readonly string[];
  /** The sensitive-root environment the broker judges a folder by (defaults to this user's home). */
  folderEnv?: () => FolderAccessEnv;
  /**
   * The folders already granted for this conversation (Settings' list plus its own). A request
   * they cover is answered at once, so the owner is never asked for what they already gave.
   */
  grantedFolders?: (threadId: string, runId?: string) => readonly FolderGrantEntry[];
}

export function requestFolderAccessTool(deps: FolderAccessToolDeps): AgentToolRegistration {
  return defineTool({
    name: "request_folder_access",
    description:
      "Ask the owner for access to a folder your file tools cannot reach (read_file, list_dir, search_files, write_file say it is outside every granted folder). Give the folder you need as `path` (a hint: the owner picks the real folder), why you need it, and `read` or `read_write`. The call waits for the owner to answer on their card and returns in the same turn: `granted: true` with the folder, access and how long it lasts, after which you continue with the task right away (list or read the folder); or `granted: false`, after which you tell the owner briefly and do not ask again. Make this call by itself, before the file calls that need the folder. Ask only for the narrowest folder you need, never for the home folder, and do not ask again after a denial.",
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
  const mode = p.access === "read_write" ? "rw" : "ro";
  // The card pre-fills this resolved folder; the owner can replace it with the picker. What is
  // shown is what is granted, and the broker re-resolves it when the owner answers.
  const requested = await resolveRequestedFolder(p.path, deps.folderEnv?.() ?? {});
  // Never ask twice for the same scope: a granted folder that covers this request answers it.
  const covered = folderCovers(
    deps.grantedFolders?.(ctx.threadId, ctx.runId) ?? [],
    requested.status === "missing" ? p.path : requested.path,
    mode,
  );
  if (covered !== undefined && requested.status !== "blocked") {
    return {
      output: {
        granted: true,
        status: "already",
        path: covered.path,
        access: covered.mode === "rw" ? "read_write" : "read",
        next: "continue; this folder was already shared",
      },
      provenance: "trusted",
    };
  }
  const unattended = ctx.mode === "unattended";
  const resolved =
    requested.status === "missing"
      ? { folderStatus: "missing" }
      : {
          folderStatus: requested.status,
          resolvedPath: requested.path,
          ...(requested.status === "blocked" ? { blockedReason: requested.reason } : {}),
        };
  // An unattended run cannot wait: the card is queued in the inbox (once per folder) and the
  // run carries on without it. An answer of "Always" works from the next run on.
  if (unattended && requested.status !== "missing") {
    const waiting = (await deps.broker.list({ status: "pending" })).some(
      (a) =>
        a.kind === "folder_access" &&
        a.details.resolvedPath === requested.path &&
        (a.details.access === "rw" || mode === "ro"),
    );
    if (waiting) return queued(requested.path);
  }
  const issued = await issueFolderCard(deps, {
    path: p.path,
    reason: p.reason,
    mode,
    resolved,
    threadId: ctx.threadId,
    callId: ctx.callId,
    requestedBy: {
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      threadId: ctx.threadId,
      toolCallId: ctx.callId,
    },
    // Unattended: "this conversation" ends with the run, so only a lasting answer is useful.
    scopesOffered: unattended && !ctx.taint ? ["always"] : folderScopesOffered(ctx.taint),
    taint: ctx.taint,
    taintSources: ctx.taintSources,
  });
  if (unattended) return queued(requested.status === "missing" ? p.path : requested.path);
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
      until:
        done.scopeGranted === "always"
          ? "revoked"
          : typeof (granted as { spaceId?: unknown }).spaceId === "string"
            ? "removed from this Space (it works in this Space's chats and automations only)"
            : "end of this conversation",
    },
    provenance: "trusted",
  };
}

/** The one `folder_access` card, shared by the tool and the chat's share button. */
async function issueFolderCard(
  deps: Pick<FolderAccessToolDeps, "broker" | "surfaces">,
  c: {
    path: string;
    reason: string;
    /** Overrides the default card summary. */
    summary?: string;
    mode: "ro" | "rw";
    resolved: Record<string, unknown>;
    threadId: string;
    callId: string;
    requestedBy: {
      runId: string | null;
      taskId: string | null;
      threadId: string;
      toolCallId?: string;
    };
    scopesOffered: ("once" | "always")[];
    taint: boolean;
    taintSources?: readonly TaintSource[];
  },
) {
  const binding = hashCanonical({
    tool: "request_folder_access",
    path: c.path,
    reason: c.reason,
    access: c.mode,
    resolved: c.resolved,
    threadId: c.threadId,
    callId: c.callId,
  });
  return deps.broker.requestApproval({
    kind: "folder_access",
    summary: (c.summary ?? `Share a folder: ${c.path}`).slice(0, 300),
    details: { requestedPath: c.path, reason: c.reason, access: c.mode, ...c.resolved },
    bindingHash: binding,
    grantKey: `folder_access|${c.mode}`,
    requestedBy: c.requestedBy,
    sideEffect: c.mode === "rw" ? "write" : "read",
    surfaces: [...deps.surfaces],
    scopesOffered: c.scopesOffered,
    taint: c.taint,
    ...(c.taint && c.taintSources !== undefined ? { taintSources: [...c.taintSources] } : {}),
  });
}

/**
 * The chat's "Share this folder (read only)" button (`files.requestShare`): the same card as the
 * tool, raised for the owner's device outside an agent run. `path` is only the picker's hint;
 * a granted folder that covers it answers at once. Never grants anything itself.
 */
export async function requestFolderShare(
  deps: FolderAccessToolDeps,
  p: {
    threadId: string;
    path: string;
    taint: boolean;
    taintSources?: readonly TaintSource[];
    /** An automation thread has no "this conversation": it follows the tool's unattended rule. */
    unattended?: boolean;
  },
): Promise<{ status: "pending" | "already"; approvalId?: string }> {
  // Clicks racing on one thread and folder (a double click, two devices) share one card.
  const key = `${p.threadId}\0${p.path}`;
  const running = shareInFlight.get(key);
  if (running !== undefined) return running;
  const job = shareOnce(deps, p).finally(() => shareInFlight.delete(key));
  shareInFlight.set(key, job);
  return job;
}

const shareInFlight = new Map<
  string,
  Promise<{ status: "pending" | "already"; approvalId?: string }>
>();

async function shareOnce(
  deps: FolderAccessToolDeps,
  p: Parameters<typeof requestFolderShare>[1],
): Promise<{ status: "pending" | "already"; approvalId?: string }> {
  const requested = await resolveRequestedFolder(p.path, deps.folderEnv?.() ?? {});
  const covered = folderCovers(
    deps.grantedFolders?.(p.threadId) ?? [],
    requested.status === "missing" ? p.path : requested.path,
    "ro",
  );
  if (covered !== undefined && requested.status !== "blocked") return { status: "already" };
  // A card already waiting on this thread for this folder (one the agent raised, or an earlier
  // click) is the answer: never a second one. Only a read-only card is reused (this button
  // never hands the owner a read & write card), and an untainted one only while the thread is
  // still untainted (its scopes were offered for that state).
  const waiting = (await deps.broker.list({ status: "pending" })).find(
    (a) =>
      a.kind === "folder_access" &&
      a.requestedBy.threadId === p.threadId &&
      a.details.access === "ro" &&
      (a.taint || !p.taint) &&
      (requested.status === "missing"
        ? a.details.folderStatus === "missing" && a.details.requestedPath === p.path
        : a.details.resolvedPath === requested.path),
  );
  if (waiting !== undefined) return { status: "pending", approvalId: waiting.id };
  const resolved =
    requested.status === "missing"
      ? { folderStatus: "missing" }
      : {
          folderStatus: requested.status,
          resolvedPath: requested.path,
          ...(requested.status === "blocked" ? { blockedReason: requested.reason } : {}),
        };
  const issued = await issueFolderCard(deps, {
    path: p.path,
    // Gateway-written: the agent's path is shown as the place it tried, not as the owner's words.
    reason: "Share a folder for this chat",
    summary: `Share a folder for this chat (a file tool tried ${p.path})`,
    mode: "ro",
    resolved,
    threadId: p.threadId,
    callId: `share_${randomUUID()}`,
    requestedBy: { runId: null, taskId: null, threadId: p.threadId },
    scopesOffered: p.unattended === true && !p.taint ? ["always"] : folderScopesOffered(p.taint),
    taint: p.taint,
    taintSources: p.taintSources,
  });
  return { status: "pending", approvalId: issued.approval.id };
}

/** What an unattended run is told: the card waits for the owner; go on without the folder. */
function queued(path: string): ToolResult {
  return {
    output: {
      granted: false,
      status: "queued",
      why: `asked the owner for ${path}; the card is in their inbox. Continue without it and say in your report that you need that folder`,
    },
    provenance: "trusted",
  };
}

/**
 * `permissions.policy.folders` with `real` recorded for the entry at `path` that has none yet
 * (the broker's first look at an older grant), or undefined when there is nothing to record: no
 * such entry, or one that already has a real path (that one is never replaced).
 */
export function withRecordedReal<
  P extends { folders?: { path: string; mode: "ro" | "rw"; real?: string }[] },
>(policy: P, path: string, real: string): P | undefined {
  const folders = policy.folders ?? [];
  const at = folders.findIndex((f) => f.path === path && f.real === undefined);
  if (at === -1) return undefined;
  return { ...policy, folders: folders.map((f, i) => (i === at ? { ...f, real } : f)) };
}

type Ref = { dev: string; ino: string; birth: string };

/**
 * `permissions.policy.folders` with the identity `ref` recorded for the entry at `path`. An entry
 * that has none takes it; one that has a different one takes the new (a folder re-created at the
 * same path). Undefined when nothing changes.
 */
export function withRecordedRef<
  P extends { folders?: { path: string; mode: "ro" | "rw"; ref?: Ref }[] },
>(policy: P, path: string, ref: Ref): P | undefined {
  const folders = policy.folders ?? [];
  const at = folders.findIndex(
    (f) =>
      f.path === path &&
      (f.ref === undefined ||
        f.ref.dev !== ref.dev ||
        f.ref.ino !== ref.ino ||
        f.ref.birth !== ref.birth),
  );
  if (at === -1) return undefined;
  return { ...policy, folders: folders.map((f, i) => (i === at ? { ...f, ref } : f)) };
}

/**
 * `permissions.policy.folders` with each entry in `moves` re-pointed from `from` to `to` (a real
 * path judged by `checkReconnect`): same mode, same identity, same place in the list. All or
 * nothing: undefined when an entry is missing or a target is already another entry (a duplicate
 * row would shadow it).
 */
export function withRepointed<
  P extends { folders?: { path: string; mode: "ro" | "rw"; real?: string; ref?: Ref }[] },
>(policy: P, moves: readonly { from: string; to: string }[]): P | undefined {
  const folders = policy.folders ?? [];
  const taking = new Set(moves.map((m) => m.from));
  const targets = new Set<string>();
  for (const m of moves) {
    if (!folders.some((f) => f.path === m.from) || targets.has(m.to)) return undefined;
    if (folders.some((f) => f.path === m.to && !taking.has(f.path))) return undefined;
    targets.add(m.to);
  }
  const to = new Map(moves.map((m) => [m.from, m.to]));
  return {
    ...policy,
    folders: folders.map((f) => {
      const t = to.get(f.path);
      return t === undefined ? f : { ...f, path: t, real: t };
    }),
  };
}

/** What `repointFolders` needs from the Gateway (so the report and the write can be tested). */
export interface RepointDeps<P> {
  read: () => { value: unknown; policy: P | undefined };
  write: (next: P) => unknown;
  /** Applies the written policy to the broker and tells the clients. */
  applied: (next: P, saved: unknown) => void;
  /** The security setting change report (change record, setting listeners). */
  report: (change: { key: string; before: unknown; after: P; deviceId: string }) => void;
}

/** The owner's tap on "Reconnect <name>?": one write for the folder and what is under it. */
export function repointFolders<
  P extends { folders?: { path: string; mode: "ro" | "rw"; real?: string; ref?: Ref }[] },
>(
  deps: RepointDeps<P>,
  moves: readonly { from: string; to: string }[],
  by: { deviceId: string },
): boolean {
  // Read at the moment of writing, so a concurrent change is never undone.
  const { value: before, policy } = deps.read();
  const next = policy === undefined ? undefined : withRepointed(policy, moves);
  if (next === undefined) return false;
  const saved = deps.write(next);
  deps.applied(next, saved);
  try {
    deps.report({ key: "permissions.policy", before, after: next, deviceId: by.deviceId });
  } catch {
    // Reporting never fails the change.
  }
  return true;
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
