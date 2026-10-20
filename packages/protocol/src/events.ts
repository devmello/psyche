import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, Provenance, StringEnum } from "./common.ts";
import { PsycheError } from "./errors.ts";
import { BrowserRecording } from "./methods/browser.ts";
import { QueuedMessage } from "./methods/chat.ts";
import { createValidator, defineEvent, type EventSpec, type Validator } from "./methods/define.ts";
import { DictationKeyPayload } from "./methods/dictation.ts";
import { SkillChangeEvent, SkillDraft, SkillUpdateStatus } from "./methods/skills.ts";
import {
  ReadAloudCompletedPayload,
  ReadAloudFailedPayload,
  SpeechAudioPayload,
  VoiceEndedPayload,
  VoiceSegmentPayload,
} from "./methods/voice.ts";
import { Block } from "./schemas/blocks.ts";
import { ContextUsage } from "./schemas/context.ts";
import { Device, NodeInfo, PairingRequest } from "./schemas/identity.ts";
import {
  Automation,
  AutomationRun,
  Channel,
  CredentialMeta,
  VaultPayment,
  VaultStatus,
} from "./schemas/integrations.ts";
import { MemoryChangeSource, MemoryJob, PersonaIdentity } from "./schemas/memory.ts";
import { ApprovalRequest, Receipt } from "./schemas/permissions.ts";
import { FeedPost, Goal, Idea, Notification, SettingEntry } from "./schemas/surfaces.ts";
import { InputRequest, Task, TaskAction } from "./schemas/tasks.ts";
import { Message, Run, Thread } from "./schemas/threads.ts";
import { ToolCall } from "./schemas/tools.ts";
import { VmUpdatedPayload } from "./schemas/vm.ts";

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
  "chat.queue.updated": defineEvent({
    payload: Type.Object({ threadId: Id, items: Type.Array(QueuedMessage) }),
    description: "The thread's follow-up queue changed (queued, removed or started).",
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
  "thread.context.updated": defineEvent({
    payload: Type.Object({ usage: ContextUsage }),
    description: "A turn ended: the thread's context usage and limits (the context meter).",
  }),
  "thread.deleted": defineEvent({
    payload: Type.Object({ threadId: Id }),
    description: "A thread and its transcript were deleted.",
  }),
  "node.updated": defineEvent({
    payload: Type.Object({ node: NodeInfo }),
    description: "A node connected, disconnected or changed capabilities.",
  }),
  "vm.updated": defineEvent({
    payload: VmUpdatedPayload,
    description:
      "A sandbox Mac guest changed phase, resources or shares (mac helper vm.* capabilities).",
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
  "persona.updated": defineEvent({
    payload: Type.Object({
      identity: PersonaIdentity,
      changed: Type.Array(Type.String()),
      /**
       * The creature or name changed: the avatar renderer should make a new avatar from
       * `identity` and store its asset id with `memory.persona.edit { fields: { avatar } }`.
       */
      avatarRequested: Type.Boolean(),
    }),
    description: "IDENTITY.md changed: clients refresh the header; maybe regenerate the avatar.",
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
  }),
  "vault.payment.updated": defineEvent({
    payload: Type.Object({ payment: VaultPayment }),
    description:
      "A Stripe Link payment changed: requested, card issued, held, captured, refunded, declined or released. Never card data.",
  }),
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
  "browser.recording.updated": defineEvent({
    payload: Type.Object({ recording: BrowserRecording }),
    description:
      "A browser recording started, grew (coalesced) or ended; Activity re-reads it with browser.recordings.get {sinceSeq}.",
  }),
  "feed.updated": defineEvent({
    payload: Type.Object({ posts: Type.Array(FeedPost), briefingId: Type.Optional(Id) }),
    description:
      "A whole brief or briefing batch was generated (clients refresh the Feed once instead of per feed.post).",
  }),
  "notification.updated": defineEvent({
    payload: Type.Object({ notification: Notification }),
    description:
      "A notification changed: read, re-delivered, or replaced by a de-duplicated notify (same id).",
  }),
  "notification.resolved": defineEvent({
    payload: Type.Object({ notification: Notification }),
    description:
      "A notification was resolved (by the user, an action, a superseding state or restart reconciliation).",
  }),
  "automation.updated": defineEvent({
    payload: Type.Object({ automation: Automation }),
    description: "An automation was created, edited, paused, run or deleted (`enabled: false`).",
  }),
  "automation.run.started": defineEvent({
    payload: Type.Object({ run: AutomationRun }),
    description: "A scheduled or manual automation run started (missed ticks coalesced).",
  }),
  "automation.run.finished": defineEvent({
    payload: Type.Object({ run: AutomationRun }),
    description: "An automation run ended (done, no_reply, failed, cancelled, skipped).",
  }),
  "voice.segment": defineEvent({
    payload: VoiceSegmentPayload,
    description:
      "A dictation partial or final, in order, sent only to the device that started the session.",
  }),
  "voice.ended": defineEvent({
    payload: VoiceEndedPayload,
    description: "A dictation session ended (stopped, cancelled, idle timeout or engine error).",
  }),
  "dictation.key": defineEvent({
    payload: DictationKeyPayload,
    description:
      "The watched hold-to-talk key went down or up (dictation.watch), sent only to the watching device.",
  }),
  "speech.audio": defineEvent({
    payload: SpeechAudioPayload,
    description:
      "One chunk of read-aloud PCM for progressive playback; last marks the end of audio.",
  }),
  "speech.readAloud.completed": defineEvent({
    payload: ReadAloudCompletedPayload,
    description: "A read-aloud clip was saved to the Library.",
  }),
  "speech.readAloud.failed": defineEvent({
    payload: ReadAloudFailedPayload,
    description: "A read-aloud failed before its Library item was saved.",
  }),
  "skills.changed": defineEvent({
    payload: SkillChangeEvent,
    description:
      "Skills changed: a reload, an install or removal, or a skill whose files no longer match its approved hash.",
  }),
  "skills.updated": defineEvent({
    payload: SkillUpdateStatus,
    description:
      "An installed skill's pinned source now has different content; review it with skills.proposeUpdate (nothing is installed until approved).",
  }),
  "skills.draft.updated": defineEvent({
    payload: Type.Object({ draft: SkillDraft }),
    description:
      "The agent proposed a skill from a repeated routine, or a draft was edited, accepted, installed, dismissed or expired (T3).",
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
