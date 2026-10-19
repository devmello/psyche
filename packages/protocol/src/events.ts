import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, Provenance, StringEnum } from "./common.ts";
import { PsycheError } from "./errors.ts";
import { createValidator, defineEvent, type EventSpec, type Validator } from "./methods/define.ts";
import { Block } from "./schemas/blocks.ts";
import { Device, NodeInfo, PairingRequest } from "./schemas/identity.ts";
import { Channel, CredentialMeta, VaultStatus } from "./schemas/integrations.ts";
import { MemoryChangeSource, MemoryJob } from "./schemas/memory.ts";
import { ApprovalRequest, Receipt } from "./schemas/permissions.ts";
import { FeedPost, Goal, Idea, Notification, SettingEntry } from "./schemas/surfaces.ts";
import { InputRequest, Task, TaskAction } from "./schemas/tasks.ts";
import { Message, Run, Thread } from "./schemas/threads.ts";
import { ToolCall } from "./schemas/tools.ts";

/**
 * Server-pushed events (data model §11; architecture §4.2 step 5). Each arrives in an
 * `EventFrame` with `seq` and `stateVersion`. Structured blocks are separate typed events so the
 * UI renders them deterministically instead of parsing prose. Additive: new events are appended.
 */

/** Pane command the Gateway forwards to the desktop shell for `view.*` (see `src/methods/view.ts`). */
export const ViewCommandName = StringEnum(["open", "close", "focus"], { $id: "ViewCommandName" });

export const Events = {
  "chat.delta": defineEvent({
    payload: Type.Object({
      threadId: Id,
      messageId: Id,
      runId: Type.Optional(Id),
      delta: Type.String(),
    }),
    description: "Streamed text delta of an agent message.",
  }),
  "chat.message": defineEvent({
    payload: Type.Object({ message: Message }),
    description: "A message was committed (user, agent, system or tool).",
  }),
  "chat.block": defineEvent({
    payload: Type.Object({ threadId: Id, messageId: Id, block: Block }),
    description:
      "A structured block (plan, checklist, approval, question, artifact, receipt, …) was added to a message.",
  }),
  "run.updated": defineEvent({
    payload: Type.Object({ run: Run }),
    description: "A run changed status or usage.",
  }),
  "tool_call.updated": defineEvent({
    payload: Type.Object({ toolCall: ToolCall }),
    description: "A tool call changed status (params are redacted; never secrets).",
  }),
  "task.updated": defineEvent({
    payload: Type.Object({ task: Task }),
    description: "A task changed status, plan or checklist.",
  }),
  "task.action": defineEvent({
    payload: Type.Object({ action: TaskAction }),
    description: "A new Activity line for a task.",
  }),
  "approval.created": defineEvent({
    payload: Type.Object({
      approval: ApprovalRequest,
      answerToken: Type.Optional(
        Type.String({ minLength: 1, description: "This connection's surface token, if any" }),
      ),
    }),
    description: "A new approval request is pending.",
  }),
  "approval.updated": defineEvent({
    payload: Type.Object({ approval: ApprovalRequest }),
    description: "An approval was decided, expired or invalidated.",
  }),
  "question.created": defineEvent({
    payload: Type.Object({ inputRequest: InputRequest }),
    description: "The agent asked the user structured questions (ask_user); no timeout.",
  }),
  "receipt.created": defineEvent({
    payload: Type.Object({ receipt: Receipt }),
    description: "A side effect was recorded.",
  }),
  "notification.created": defineEvent({
    payload: Type.Object({ notification: Notification }),
    description: "A notification was created for the in-app inbox.",
  }),
  "settings.changed": defineEvent({
    payload: Type.Object({ entries: Type.Array(SettingEntry) }),
    description: "Settings changed (including appearance), so every paired client re-themes.",
  }),
  "thread.updated": defineEvent({
    payload: Type.Object({ thread: Thread }),
    description: "A thread was created, renamed, pinned, archived or restored.",
  }),
  "node.updated": defineEvent({
    payload: Type.Object({ node: NodeInfo }),
    description: "A node connected, disconnected or changed capabilities.",
  }),
  "device.updated": defineEvent({
    payload: Type.Object({ device: Device }),
    description: "A device was paired, changed scopes or was revoked.",
  }),
  "pairing.requested": defineEvent({
    payload: Type.Object({ pairingRequest: PairingRequest }),
    description: "A new pairing request awaits the owner's approval.",
  }),
  "channels.updated": defineEvent({
    payload: Type.Object({
      channel: Channel,
      /** Adapter health detail when `status` is `error` or `disconnected`. */
      detail: Type.Optional(Type.String()),
    }),
    description: "A channel was configured, connected, disconnected or changed status.",
  }),
  "view.command": defineEvent({
    payload: Type.Object({
      commandId: Type.Optional(Type.String()),
      command: ViewCommandName,
      args: Type.Record(Type.String(), Type.Unknown()),
    }),
    description: "Gateway → desktop pane RPC for view.* (only the desktop shell acts on it).",
  }),
  "memory.file.changed": defineEvent({
    payload: Type.Object({
      path: Type.String({ description: "Workspace path" }),
      /** New etag; `null` when the file was deleted. */
      etag: Nullable(Type.String()),
      source: MemoryChangeSource,
      provenance: Type.Optional(Provenance),
    }),
    description:
      "A workspace file was created, changed or deleted (by a tool, the API, a job, or outside Psyche).",
  }),
  "memory.job.updated": defineEvent({
    payload: Type.Object({ job: MemoryJob }),
    description: "A memory job (flush, dreaming, reindex, import) started or finished.",
  }),
  "gateway.shutdown": defineEvent({
    payload: Type.Object({ reason: Type.String() }),
    description: "The Gateway is shutting down; clients reconnect with backoff.",
  }),
  "vault.locked": defineEvent({
    payload: Type.Object({
      reason: StringEnum(["manual", "idle", "sleep", "screen_lock", "shutdown"]),
      status: VaultStatus,
    }),
    description: "The vault locked and its key was zeroized.",
  }),
  "vault.unlocked": defineEvent({
    payload: Type.Object({
      via: StringEnum(["keychain", "safe_storage", "key_file", "recovery"]),
      status: VaultStatus,
    }),
    description: "The vault unlocked through a key slot.",
  }),
  "credential.updated": defineEvent({
    payload: Type.Object({
      credentialId: Id,
      change: StringEnum(["created", "updated", "deleted", "rotated", "revoked", "used"]),
      /** Metadata after the change; `null` once deleted or revoked. Never values. */
      credential: Nullable(CredentialMeta),
      ownerConnectorId: Nullable(Id),
    }),
    description:
      "A vault item was added, edited, deleted, used, rotated or revoked; revocation invalidates connection-bound work.",
  "question.updated": defineEvent({
    payload: Type.Object({ inputRequest: InputRequest }),
    description: "An input request was answered or cancelled.",
  }),
  "feed.post": defineEvent({
    payload: Type.Object({ post: FeedPost }),
    description: "A feed post was published or its feedback changed.",
  }),
  "idea.updated": defineEvent({
    payload: Type.Object({ idea: Idea }),
    description: "An idea was proposed, accepted, edited, dismissed or expired.",
  }),
  "goal.updated": defineEvent({
    payload: Type.Object({ goal: Goal }),
    description: "A goal was created, confirmed, changed or archived.",
  }),
} as const;

export type EventName = keyof typeof Events;
export type EventPayload<E extends EventName> = Static<(typeof Events)[E]["payload"]>;

const eventTable: Readonly<Record<string, EventSpec>> = Events;
const payloadValidators = new Map<string, Validator<EventSpec["payload"]>>();

export function isEventName(s: unknown): s is EventName {
  return typeof s === "string" && Object.hasOwn(eventTable, s);
}

/** Validates an event payload; throws `invalid_params` for a bad payload or unknown event. */
export function validateEventPayload<E extends EventName>(
  event: E,
  payload: unknown,
): EventPayload<E>;
export function validateEventPayload(event: string, payload: unknown): unknown;
export function validateEventPayload(event: string, payload: unknown): unknown {
  const spec = isEventName(event) ? eventTable[event] : undefined;
  if (spec === undefined) {
    throw new PsycheError("invalid_params", `unknown event ${JSON.stringify(event)}`);
  }
  let v = payloadValidators.get(event);
  if (v === undefined) {
    v = createValidator(spec.payload);
    payloadValidators.set(event, v);
  }
  if (v.check(payload)) return payload;
  const errors = v.errors(payload);
  throw new PsycheError("invalid_params", `invalid payload for ${event}: ${errors.join("; ")}`, {
    details: { event, errors },
  });
}
