import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { Receipts, sha256 } from "@psyche/audit";
import { isUnderHostPath } from "@psyche/hostfs";
import {
  APPROVAL_ARM_DELAY_MS,
  APPROVAL_TTL_MS,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStatus,
  type AuditEntryInput,
  type AuditLog,
  type BindingVerification,
  type Clock,
  chatLinkRoute,
  type DecidedBy,
  type DeviceScope,
  type ErrorCode,
  type Grant,
  type GrantFilter,
  type GrantScope,
  type IssuedApproval,
  isPrepNoteCall,
  type JsonObject,
  type Notifier,
  type PermissionBroker,
  PREP_NOTE_TITLE_PREFIX,
  type PreviewResult,
  PsycheError,
  type Receipt,
  type ReceiptInput,
  type SideEffect,
  type Surface,
  type ToolCallIntent,
} from "@psyche/protocol";
import { venueOfHost } from "@psyche/protocol/financial-block";
import { monotonicFactory } from "ulid";
import { type Binding, bindingFor, bindingHash, grantKeyHash, readsCwdConfig } from "./binding.ts";
import { cardHeader, cardTaintSources, sanitizeDetails, sanitizeDisplay } from "./cards.ts";
import {
  CHANNEL_PAIRING_WINDOW_MS,
  CHANNEL_REPLIES_PER_MINUTE,
  CHANNEL_REPLY_TTL_MS,
  CHANNEL_REPLY_WINDOW_MS,
  type ChannelConversationLookup,
  type ChannelReplyInput,
} from "./channel-reply.ts";
import { type ActionClassifier, RulesClassifier } from "./classifier.ts";
import { floorClass } from "./connector-matrix.ts";
import {
  type DryRun,
  newTaskState,
  PolicyEngine,
  type PolicyHook,
  safeOrigin,
  type TaskState,
  targetKey,
  taskKey,
  trustedRead,
} from "./engine.ts";
import {
  effectiveEntries,
  type FolderAccessEnv,
  type FolderGrantEntry,
  folderCovers,
  grantedRootMoved,
  grantedRootRefused,
  inSystemRoot,
  lookupRootFacts,
  type RootFacts,
  refuseFolder,
  resolveFilePick,
  resolveFolderPick,
  sameRootSpelling,
} from "./folder-access.ts";
import {
  checkReconnect,
  type FolderRef,
  folderRefOf,
  locateFolder,
  pathIsGone,
  ReconnectRefused,
} from "./folder-reconnect.ts";
import {
  HOST_PROGRAM_ROOTS,
  type HostProgramFacts,
  type HostProgramGrant,
  hostProgramCoverage,
  hostProgramGrantCovers,
  hostProgramRefusal,
} from "./host-program.ts";
import {
  AUTH_KINDS,
  allowedScopes,
  DEVICE_ONLY_KINDS,
  inferApprovalKind,
  isDeviceOnly,
  isSeparateDesktopCredentialKey,
  SEVERITY,
} from "./kinds.ts";
import {
  type ComposeFinal,
  composeBindingHash,
  readCompose,
  readFinal,
  resolveCompose,
} from "./message-compose.ts";
import {
  type CompiledPolicy,
  compilePolicy,
  isSensitiveHost,
  type PolicyConfig,
} from "./policy.ts";
import { DENY_ALL_LOOPBACK, type LocalProjectVerifier } from "./prohibitions.ts";
import { receiptGrantBinding, receiptGrantId } from "./receipt-grant.ts";
import { requesterKey, requesterSurfaces } from "./requester.ts";
import type { RevocationLedger } from "./revocations.ts";
import { riskClassFor } from "./risk.ts";
import {
  MemoryPermissionStore,
  type PermissionStore,
  type StoredApproval,
  type StoredCardFields,
  type StoredGrant,
} from "./store.ts";
import { canonicalPath } from "./targets.ts";
import {
  isSharedTenantHost,
  normalizeTrustedSite,
  type TrustedSite,
  TrustedSiteError,
  trustedSiteCovers,
} from "./trusted-sites.ts";
import type {
  BatchChild,
  PolicyAnswerInput,
  PolicyApprovalInput,
  PolicyBatchInput,
  PolicyCall,
  PolicyContext,
  PolicyDecision,
  PresenceAssertion,
} from "./types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Who may answer (security §3.7): paired devices with `operator.approvals`, owner-identity senders. */

/**
 * Granted roots are judged from a per-path cache of what is on disk (`lookupRootFacts`), never
 * looked up synchronously on the decide path: a hung SMB or NFS mount must not freeze the event
 * loop. Past `FOLDER_FRESH_MS` a read starts one asynchronous refresh (one in flight per path)
 * and keeps the last verdict meanwhile; a root whose refresh has been outstanding for
 * `FOLDER_STALE_CAP_MS` (a hung mount) is refused until one completes. (Measured from the
 * refresh, not the last look, so a root nobody read for a while is not refused for the moment
 * its refresh takes.) The executors still check live, at once.
 */
export const FOLDER_FRESH_MS = 5_000;
export const FOLDER_STALE_CAP_MS = 60_000;
/**
 * How long an evaluation waits, once per lookup, for a look at a root whose answer is not fresh
 * (a new grant, a start, a root not read for longer than `FOLDER_FRESH_MS`).
 */
const FOLDER_FIRST_LOOK_WAIT_MS = 250;

/** Resolves when `p` settles or after `ms`, whichever is first; never rejects. */
function raceTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
    const done = (): void => {
      clearTimeout(t);
      resolve();
    };
    p.then(done, done);
  });
}

/** How long `freshGrantedFolders` waits for the looks it starts. */
const FOLDER_FRESH_WAIT_MS = 2_000;
/** How long an executor's live look (`lookRootNow`) may take before the root is refused. */
const FOLDER_LIVE_LOOK_MS = 2_000;

interface RootLookup {
  done: Promise<RootFacts | "error">;
  /** An evaluation has already waited for it (it waits once per lookup). */
  waited: boolean;
  /** A fresh read (`freshGrantedFolders`) waited its whole bound for it: the next ones do not. */
  freshTimedOut: boolean;
  /** When it started (broker clock). */
  since: number;
  /** When it started (wall clock): a fresh read does not wait on one older than its bound. */
  startedAt: number;
}

interface RootLook {
  /** What the last completed look found; "error" when it failed (refused until the next one). */
  facts: RootFacts | "error";
  /** When it completed (broker clock). */
  checkedAt: number;
  /** No look has completed yet: the verdict comes from the stored path alone. */
  first?: true;
}
export interface ApproverDirectory {
  device(
    deviceId: string,
  ): Promise<{ scopes: readonly DeviceScope[]; revoked?: boolean; role?: string } | undefined>;
  /** True only for `commands.ownerAllowFrom` identities, never for merely allowlisted senders. */
  isOwnerSender(channel: string, senderId: string): Promise<boolean>;
}

/** Verifies a WebAuthn / helper Touch ID assertion over `presenceChallenge(...)` (design-04). */
export interface PresenceVerifier {
  verify(assertion: PresenceAssertion, challenge: string, deviceId: string): Promise<boolean>;
}

export type BrokerEvent =
  | { type: "approval.created"; approval: ApprovalRequest }
  | {
      type: "approval.decided" | "approval.expired" | "approval.invalidated";
      approval: ApprovalRequest;
    }
  | { type: "grant.created" | "grant.revoked"; grant: Grant }
  /**
   * `taskId`: the task whose call went through the grant (none for a batch's own use);
   * `bindingHash`: that call's binding (a grant covers a key, not one exact call);
   * `fromSetAside`: the grant was made by approving a set-aside card (a resume may wait on it).
   */
  | {
      type: "grant.used";
      grant: Grant;
      taskId?: string;
      bindingHash: string;
      fromSetAside?: true;
    }
  | { type: "receipt.created"; receipt: Receipt }
  | { type: "task.paused" | "task.downgraded"; taskId: string; reason: string };

export interface PermissionBrokerOptions {
  approvers: ApproverDirectory;
  /** "Always allow <program> in <folder>" (tests): where a granted binary may live, whose rules. */
  hostProgram?: { roots?: readonly string[]; platform?: NodeJS.Platform; home?: string };
  store?: PermissionStore;
  audit?: AuditLog;
  receipts?: Receipts;
  notifier?: Notifier;
  policy?: PolicyConfig;
  clock?: Clock;
  bootId?: string;
  hooks?: PolicyHook[];
  classifier?: ActionClassifier;
  localProject?: LocalProjectVerifier;
  psycheHome?: string;
  /** Gateway UI origins the agent may never act on (design-03, design-19). */
  gatewayOrigins?: string[];
  presence?: PresenceVerifier;
  /** Which approvals need a presence assertion once a verifier is configured. */
  presenceFor?: "authentication" | "device_only";
  ttlMs?: number;
  armDelayMs?: number;
  /**
   * True for a card an unattended run is waiting on (Deferred). Such a card gets no card of its
   * own in the notifier: the Gateway's automation digest announces them as one. The card, its
   * expiry and its answer path are unchanged.
   */
  deferredApproval?: (approval: ApprovalRequest) => boolean | Promise<boolean>;
  /**
   * For a card the agent loop set aside (`setAside`): true when a resume run of its automation
   * can start once the card is approved. Absent or false refuses the approval (`not_resumable`),
   * because approving would otherwise report success for an action that never runs.
   */
  canResume?: (approval: ApprovalRequest) => boolean | Promise<boolean>;
  /**
   * A restart revoked an approved set-aside card before any run used it (`reissue`): the resume
   * it promised will not happen, so the Gateway tells the owner instead of staying silent.
   */
  onSetAsideRevoked?: (
    approval: ApprovalRequest,
    how: { failed: boolean; unknown: boolean },
  ) => void;
  /**
   * Whether `taskId` is a run of the automation that set this card aside (the scheduler's
   * `runForTask`). Only those runs' grant receipts can say the card's action was done at boot;
   * without it none can (fail closed: the owner is told).
   */
  sameAutomation?: (approval: ApprovalRequest, taskId: string) => boolean;
  onEvent?: (event: BrokerEvent) => void;
  newId?: (prefix: string) => string;
  /** Records grant revocations outside the backup scope (design-26). */
  revocations?: RevocationLedger;
  /** The channel layer's view of its conversations; without it no reply authority is issued. */
  channelConversations?: ChannelConversationLookup;
  /**
   * Folder access the agent asks for (`folder_access`, security §3.5). `env` names the sensitive
   * roots a pick is refused under; `persist` stores an `always` grant (Settings → File access).
   * Without it a `folder_access` approval can only be denied.
   */
  folderAccess?: {
    env: () => FolderAccessEnv;
    /**
     * The places a `separate_desktop_share` pick is refused under (the container's own list,
     * wider than `env`): the card and the mount judge by one list. Without it `env` is used.
     */
    separateDesktopEnv?: () => FolderAccessEnv;
    persist: (entry: FolderGrantEntry) => Promise<void>;
    /** Removes an `always` folder from Settings (the owner's revoke); true when it was there. */
    remove?: (path: string) => Promise<boolean>;
    /**
     * Stores the real path first seen for a Settings folder granted before real paths were
     * recorded (`permissions.policy.folders[].real`), so a later move is caught after a restart.
     * With `by`, the owner confirmed a moved folder from that device (`confirmMovedFolder`): the
     * store reports it as that device's security setting change, as a policy write would.
     */
    recordReal?: (path: string, real: string, by?: { deviceId: string }) => void | Promise<void>;
    /** Stores the identity of a Settings folder first seen at its recorded place (`ref`). */
    recordRef?: (path: string, ref: FolderRef) => void | Promise<void>;
    /**
     * Re-points a Settings folder to `to` (a real path that passed `checkReconnect`), keeping its
     * mode, `ref` and place in the list. With `by`, reported as that device's security setting
     * change. False when the entry is gone.
     */
    repoint?: (path: string, to: string, by: { deviceId: string }) => boolean | Promise<boolean>;
  };
}

/** How long an attached file stays readable in its conversation (it also ends with the thread). */
export const ATTACH_GRANT_MS = 24 * 60 * 60 * 1000;

type GrantFields = { grantFields?: JsonObject };

/**
 * Challenge a presence assertion signs (design-04). A card answered with a scope wider than
 * `once` binds that scope too, so Touch ID given for "once" cannot be turned into "always"
 * afterwards. `once` keeps the original form (the helper's challenge never carries a scope).
 */
export function presenceChallenge(
  approvalId: string,
  bindingHash: string,
  answerToken: string,
  scope?: string,
): string {
  const base = `psyche.presence.v1|${approvalId}|${bindingHash}|${answerToken}`;
  const digest = sha256(scope === undefined || scope === "once" ? base : `${base}|scope:${scope}`);
  // The Mac helper and WebAuthn both want the bare 64-hex digest, but `@psyche/audit`'s `sha256`
  // carries a `sha256:` prefix. With it the helper's `isValidChallenge` (exactly 64 hex) refused
  // every challenge, so no presence check could ever pass.
  return digest.slice("sha256:".length);
}

const isChat = (s: Surface) => s.includes(":");

function actorOf(by: DecidedBy, surface?: Surface): AuditEntryInput["actor"] {
  if ("deviceId" in by) {
    const s = surface ?? by.surface;
    return { type: "device", deviceId: by.deviceId, ...(s === undefined ? {} : { surface: s }) };
  }
  return { type: "channel", ...(surface === undefined ? {} : { surface }) };
}

function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new PsycheError(code, message, details === undefined ? {} : { details });
}

/**
 * The Permission Broker (architecture §4.6, security §3): the only component that can authorize a
 * side effect. Evaluation lives in `PolicyEngine`; this class owns approvals, grants, receipts,
 * delivery and the audit trail.
 */
/** Calls one batch approval may hold (docs/workflows/mail-and-meetings-2026.md §8.1). */
export const MAX_BATCH_CALLS = 100;
/** How long a minted child approval of an approved batch stays usable. */
export const BATCH_CHILD_TTL_MS = 10 * 60_000;

/** `invalidatedReason` of a card the owner closed by typing in the chat instead. */
export const OWNER_REPLIED_IN_CHAT = "owner_replied_in_chat";

/** The id of a batch's child approval: deterministic, so no store has to remember it. */
export function batchChildId(batchApprovalId: string, index: number): string {
  return `${batchApprovalId}.${index}`;
}

/**
 * Guessing-shaped rejections (a wrong or replayed token, a failed sheet or password) per
 * identity per minute, as a multiple of `approvals.answersPerMinute`, before a lockout. Real
 * decisions are never capped: the owner tapping Allow on card after card must not trip anything
 * (owner decision 2026-11-09), and a decision needs the card's own one-time token anyway.
 */
const FAILURE_CAP_FACTOR = 6;

/**
 * The rejections that count toward the lockout cap: the ones a brute-force attempt produces — a
 * guessed or reused answer token, an answer from the wrong place or by someone who may not
 * decide, and a presence assertion or password that did not check out. Every other refusal
 * (`late`, `not_armed`, `not_found`, `invalidated`, a cancelled sheet, a missing helper or key, a
 * malformed request) is still audited, but it proves nothing about guessing: a client that
 * retries a stale card must not lock the owner out of the cards that are still open.
 */
const GUESSING_REASONS: ReadonlySet<string> = new Set([
  "unknown_token",
  "replayed",
  "surface_mismatch",
  "not_approver",
  "not_owner",
  "device_only",
  "presence_invalid",
  "presence_failed",
  "password_failed",
  "password_from_client",
]);

export class PsychePermissionBroker implements PermissionBroker {
  readonly clock: Clock;
  readonly audit: AuditLog | undefined;
  readonly receipts: Receipts;
  readonly engine: PolicyEngine;
  readonly #store: PermissionStore;
  readonly #approvers: ApproverDirectory;
  readonly #notifier: Notifier | undefined;
  readonly #presence: PresenceVerifier | undefined;
  readonly #presenceFor: "authentication" | "device_only";
  readonly #armDelayMs: number;
  readonly #ttlMs: number | undefined;
  readonly #deferredApproval: PermissionBrokerOptions["deferredApproval"];
  readonly #canResume: PermissionBrokerOptions["canResume"];
  readonly #onSetAsideRevoked: PermissionBrokerOptions["onSetAsideRevoked"];
  readonly #sameAutomation: PermissionBrokerOptions["sameAutomation"];
  readonly #onEvent: ((e: BrokerEvent) => void) | undefined;
  readonly #newId: (prefix: string) => string;
  readonly #revocations: RevocationLedger | undefined;
  readonly #classifierId: string;
  #policy: CompiledPolicy;
  #bootId: string;
  readonly #listeners = new Set<(e: BrokerEvent) => void>();
  readonly #waiters = new Map<string, Set<(a: ApprovalRequest) => void>>();
  readonly #timers = new Map<string, () => void>();
  readonly #notifications = new Map<string, string>();
  readonly #tasks = new Map<string, TaskState>();
  readonly #recent = new Map<
    string,
    { call: PolicyCall; ctx: PolicyContext; binding: Binding; decision: PolicyDecision; at: number }
  >();
  /** Rejected, guessing-shaped answers per identity: the only answer cap. */
  readonly #failureTimes = new Map<string, number[]>();
  /** The `decidedBy` objects of calls the Gateway vouched for as the owner's own Host app. */
  readonly #localBy = new WeakSet<object>();
  readonly #channelConversations: ChannelConversationLookup | undefined;
  readonly #replyTimes = new Map<string, number[]>();
  readonly #folderAccess: PermissionBrokerOptions["folderAccess"];
  /** The last place found for a vanished Settings folder (`folderReconnectOffer`). */
  readonly #reconnectOffers = new Map<string, { to: string | undefined; at: number }>();
  readonly #hostProgram: NonNullable<PermissionBrokerOptions["hostProgram"]>;
  readonly #psycheHome: string | undefined;
  /** thread → folders allowed for that conversation only; gone at `/new` and at a restart. */
  readonly #sessionFolders = new Map<string, FolderGrantEntry[]>();
  /** The string-only parts of `folderRefused` and `#workspaceRefused`, by path (no filesystem). */
  readonly #refusedMemo = new Map<string, boolean>();
  /** The last look at each granted root (`lookupRootFacts`), refreshed asynchronously. */
  readonly #rootLooks = new Map<string, RootLook>();
  /** One lookup in flight per path; `waited` once an evaluation has waited for it. */
  readonly #rootLookups = new Map<string, RootLookup>();
  /** Verdicts from `#rootLooks` and the recorded real paths, until either changes. */
  readonly #rootVerdicts = new Map<string, boolean>();
  /** Real paths recorded in the policy (`folders[].real`), by stored and canonical path. */
  #recordedReal = new Map<string, string>();
  /** Real paths seen at a pick, or first seen for an older grant with none recorded. */
  readonly #observedReal = new Map<string, string>();
  /** When an attached file's grant ends (`${threadId}\0${path}` -> epoch ms); see attachFiles. */
  readonly #fileGrantExpiry = new Map<string, number>();
  /**
   * Which files the owner attached in which conversation (`${threadId}\0${path}` -> epoch ms
   * when the record ends). Separate from the grants: a file inside a granted folder gets no
   * grant entry but is still attached. The record alone never grants a read.
   */
  readonly #attachRecords = new Map<string, number>();

  constructor(options: PermissionBrokerOptions) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.#store = options.store ?? new MemoryPermissionStore();
    this.#approvers = options.approvers;
    this.audit = options.audit;
    this.receipts =
      options.receipts ??
      new Receipts({
        clock: this.clock,
        ...(options.audit === undefined ? {} : { audit: options.audit }),
      });
    this.#notifier = options.notifier;
    this.#presence = options.presence;
    this.#presenceFor = options.presenceFor ?? "authentication";
    this.#armDelayMs = options.armDelayMs ?? APPROVAL_ARM_DELAY_MS;
    this.#ttlMs = options.ttlMs;
    this.#deferredApproval = options.deferredApproval;
    this.#canResume = options.canResume;
    this.#onSetAsideRevoked = options.onSetAsideRevoked;
    this.#sameAutomation = options.sameAutomation;
    this.#onEvent = options.onEvent;
    this.#revocations = options.revocations;
    this.#channelConversations = options.channelConversations;
    this.#folderAccess = options.folderAccess;
    this.#hostProgram = options.hostProgram ?? {};
    this.#psycheHome = options.psycheHome;
    const ulid = monotonicFactory();
    this.#newId = options.newId ?? ((prefix) => `${prefix}_${ulid(this.clock.now())}`);
    this.#bootId = options.bootId ?? this.#newId("boot");
    this.#policy = compilePolicy(options.policy ?? {});
    const classifier = options.classifier ?? new RulesClassifier();
    this.#classifierId = classifier.id;
    const gatewayOrigins = (
      options.gatewayOrigins ?? ["http://127.0.0.1:7979", "http://localhost:7979"]
    ).map((o) => safeOrigin(o) ?? o);
    this.engine = new PolicyEngine({
      policy: () => this.#policy,
      task: (ctx) => this.#task(ctx),
      peekTask: (ctx) => this.#tasks.get(taskKey(ctx)),
      sessionFolders: (threadId) => this.sessionFolders(threadId),
      folderRefused: (path) => this.folderRefused(path),
      workspaceRefused: (path) => this.#workspaceRefused(path),
      settleFolders: (threadId) => this.#settleFolders(threadId),
      matchGrant: (key, kind, se, ctx, origin) => this.#matchGrant(key, kind, se, ctx, origin),
      useGrant: (rec, hash, ctx) => this.#useGrant(rec, hash, ctx?.taskId),
      trustedSite: (origin) => this.#trustedSite(origin),
      hostProgramGrant: (call, ctx) => this.#hostProgramGrant(call, ctx),
      hooks: options.hooks ?? [],
      classifier,
      localProject: options.localProject ?? DENY_ALL_LOOPBACK,
      psycheHome: options.psycheHome,
      gatewayOrigins,
      onClassified: (ctx, call, label, reason, breaker) =>
        this.#onClassified(ctx, call, label, reason, breaker),
    });
    this.#warmRefusals();
  }

  get bootId(): string {
    return this.#bootId;
  }

  get policy(): PolicyConfig {
    return this.#policy.config;
  }

  /** Takes effect on the next call (feature F5). Never reachable from a tool (security §3.9). */
  setPolicy(config: PolicyConfig): void {
    this.#policy = compilePolicy(config);
    this.#refusedMemo.clear();
    // What is on disk (`#rootLooks`) survives a policy write; the verdicts depend on the
    // recorded real paths, which may have changed.
    this.#rootVerdicts.clear();
    this.#pruneRoots();
    this.#warmRefusals();
  }

  /**
   * The folders the owner granted in Settings that still count: a folder `inSystemRoot` refuses
   * today (granted before `/opt` was refused, say), or one that leads somewhere else than where
   * it was granted (`grantedRootRefused`), is left out. Answers from the last look at the disk,
   * which can be older than `FOLDER_FRESH_MS`: a reader that follows the roots itself without a
   * live check of its own (an indexer, a sweep, the coding tools) uses `freshGrantedFolders`.
   * Each entry carries its recorded real path (`real`) when one is known, so an executor can
   * compare it with the real path it looks up itself.
   */
  grantedFolders(): NonNullable<PolicyConfig["folders"]> {
    return (this.policy.folders ?? [])
      .filter((f) => !this.folderRefused(f.path))
      .map((f) => this.#withReal(f));
  }

  /**
   * `grantedFolders`, judged from a look no older than `FOLDER_FRESH_MS`: the looks that are due
   * start now and are awaited (at most `timeoutMs`). A root whose look is still pending after
   * that, or that has never been looked at, is left out until a look completes.
   */
  async freshGrantedFolders(
    timeoutMs = FOLDER_FRESH_WAIT_MS,
  ): Promise<NonNullable<PolicyConfig["folders"]>> {
    const folders = this.policy.folders ?? [];
    for (const f of folders) this.folderRefused(f.path);
    // A lookup is not waited on again once a fresh read waited its whole bound for it, nor once
    // it is older than the bound: a root on a hung mount costs one wait, then it is left out at
    // once until it answers.
    const started = Date.now();
    const due = folders.flatMap((f) => {
      const l = this.#rootLookups.get(f.path);
      if (l === undefined || l.freshTimedOut || started - l.startedAt >= timeoutMs) return [];
      return [l];
    });
    if (due.length > 0) {
      await raceTimeout(Promise.all(due.map((l) => l.done)), timeoutMs);
      for (const l of due) if ([...this.#rootLookups.values()].includes(l)) l.freshTimedOut = true;
    }
    return folders
      .filter((f) => {
        const look = this.#rootLooks.get(f.path);
        if (look === undefined || look.first === true || this.#rootLookups.has(f.path))
          return false;
        if (this.clock.now() - look.checkedAt > FOLDER_FRESH_MS) return false;
        return !this.folderRefused(f.path);
      })
      .map((f) => this.#withReal(f));
  }

  /** This conversation's folders and attached files that still count (see `grantedFolders`). */
  liveSessionFolders(threadId: string): FolderGrantEntry[] {
    return this.sessionFolders(threadId)
      .filter((f) => !this.folderRefused(f.path))
      .map((f) => this.#withReal(f));
  }

  #withReal<F extends { path: string; real?: string }>(f: F): F {
    const real = this.recordedReal(f.path);
    return real === undefined || f.real === real ? f : { ...f, real };
  }

  /**
   * The real path a granted root had when it was granted: recorded in the policy, seen at the
   * pick, or the first one seen for an older grant (only when that is the stored path itself, up
   * to spelling). Undefined when nothing is known yet.
   */
  recordedReal(path: string): string | undefined {
    return this.#recordedReal.get(path) ?? this.#observedReal.get(path);
  }

  /**
   * Where a Settings folder granted before real paths were recorded now leads, when that is the
   * only reason it does not count: its real path is not the stored one, so nothing says it was
   * granted there. Settings shows it as moved, and the owner may confirm it again
   * (`confirmMovedFolder`). Undefined for every other folder.
   */
  folderMovedTo(path: string): string | undefined {
    if (!(this.#policy.config.folders ?? []).some((f) => f.path === path)) return undefined;
    const look = this.#rootLooks.get(path);
    if (look === undefined || look.first === true || look.facts === "error") return undefined;
    return grantedRootMoved(path, look.facts, this.recordedReal(path), this.#confirmEnv());
  }

  /**
   * The owner's tap on a moved older folder (Settings → Access). `seen` is the place Settings
   * showed (`movedTo`): the folder is looked up now, and only when it still leads there (up to
   * spelling) is that recorded as where it was granted, so it counts again. A folder re-pointed
   * since the list was read is not confirmed (false; Settings reads the list again). Only for a
   * Settings folder with nothing recorded whose real path is a plain folder a grant may cover
   * (`refuseFolder` passes there). Recorded as the owner's device's change (`by`).
   */
  async confirmMovedFolder(
    path: string,
    seen: string,
    by: { deviceId: string; surface?: Surface },
  ): Promise<boolean> {
    const entry = (this.#policy.config.folders ?? []).find((f) => f.path === path);
    if (entry === undefined || this.recordedReal(path) !== undefined) return false;
    const facts = await this.lookRootNow(path);
    if (facts === undefined) return false;
    const env = this.#confirmEnv();
    const real = grantedRootMoved(path, facts, undefined, env);
    if (real === undefined || !sameRootSpelling(real, seen, env)) return false;
    this.#observedReal.set(path, real);
    this.#rootVerdicts.delete(path);
    await this.#folderAccess?.recordReal?.(path, real, { deviceId: by.deviceId });
    await this.#log("folder.confirmed", actorOf(by), {}, { path, real });
    return true;
  }

  #confirmEnv(): FolderAccessEnv {
    return this.#folderAccess?.env() ?? this.#refuseEnv();
  }

  /** Starts a look at every stored root (asynchronous: nothing here touches the disk). */
  #warmRefusals(): void {
    const recorded = new Map<string, string>();
    for (const f of this.#policy.config.folders ?? []) {
      if (f.real === undefined) continue;
      recorded.set(f.path, f.real);
      try {
        recorded.set(canonicalPath(f.path), f.real);
      } catch {
        // compilePolicy accepted it; nothing else to add.
      }
    }
    this.#recordedReal = recorded;
    for (const f of this.#policy.folders) this.folderRefused(f.path);
    for (const r of this.#policy.workspaceRoots) this.#workspaceRefused(r);
  }

  /** The roots anything still grants: Settings folders (both spellings), workspace roots, chats. */
  #liveRoots(): Set<string> {
    const live = new Set<string>(this.#policy.workspaceRoots);
    for (const f of this.#policy.config.folders ?? []) live.add(f.path);
    for (const f of this.#policy.folders) live.add(f.path);
    for (const roots of this.#sessionFolders.values()) for (const r of roots) live.add(r.path);
    return live;
  }

  /**
   * Forgets the looks, verdicts and first-seen real paths of roots nothing grants any more (a
   * revoke, a policy write, an ended chat, an expired attachment), so a path granted again later
   * starts from a fresh look, never from an old baseline.
   */
  #pruneRoots(): void {
    const live = this.#liveRoots();
    for (const map of [this.#rootLooks, this.#rootVerdicts, this.#observedReal] as Map<
      string,
      unknown
    >[]) {
      for (const k of [...map.keys()]) if (!live.has(k)) map.delete(k);
    }
  }

  /**
   * Waits until every root lookup in flight has finished; with `timeoutMs`, no longer than that.
   * The Gateway waits (bounded) once at start, before the indexer, the work sweep and the folder
   * watchers start; Settings' access list waits briefly; tests wait for good.
   */
  async foldersSettled(timeoutMs?: number): Promise<void> {
    for (;;) {
      const pending = [...this.#rootLookups.values()].map((l) => l.done);
      if (pending.length === 0) return;
      if (timeoutMs === undefined) await Promise.all(pending);
      else {
        await raceTimeout(Promise.all(pending), timeoutMs);
        return;
      }
    }
  }

  /**
   * Before an evaluation: waits (at most `FOLDER_FIRST_LOOK_WAIT_MS`, once per lookup) for the
   * looks at roots whose answer is not fresh: never looked at, or older than `FOLDER_FRESH_MS`.
   * So the engine decides on a look at most about `FOLDER_FRESH_MS` old. On a healthy disk the
   * wait is a fraction of a millisecond; a hung mount costs one short wait per lookup, after
   * which the root is judged as `folderRefused` says. Undefined when there is nothing to wait for,
   * so an evaluation does not yield for nothing.
   */
  #settleFolders(threadId: string | undefined): Promise<void> | undefined {
    const paths = [
      ...this.#policy.folders.map((f) => f.path),
      ...this.#policy.workspaceRoots,
      ...(threadId === undefined ? [] : this.sessionFolders(threadId).map((f) => f.path)),
    ];
    const now = this.clock.now();
    const waits: Promise<unknown>[] = [];
    for (const path of paths) {
      this.folderRefused(path);
      const look = this.#rootLooks.get(path);
      const lookup = this.#rootLookups.get(path);
      if (look === undefined || lookup === undefined || lookup.waited) continue;
      if (look.first === true || now - look.checkedAt > FOLDER_FRESH_MS) {
        lookup.waited = true;
        waits.push(lookup.done);
      }
    }
    return waits.length === 0
      ? undefined
      : raceTimeout(Promise.all(waits), FOLDER_FIRST_LOOK_WAIT_MS);
  }

  /**
   * A look at a root started now, for an executor that checks live (exec-host). It goes through
   * the same single lookup per path as the cache: one already in flight is awaited first (it may
   * have started before the caller's call), then a new one. Undefined when the root cannot be
   * read, or no look completes within `timeoutMs` (a hung mount): the caller refuses the root.
   * Waiting callers never start more lookups, so a hung mount holds one libuv thread per path.
   */
  async lookRootNow(path: string, timeoutMs = FOLDER_LIVE_LOOK_MS): Promise<RootFacts | undefined> {
    const until = Date.now() + timeoutMs;
    const within = async (
      p: Promise<RootFacts | "error">,
    ): Promise<RootFacts | "error" | undefined> => {
      const left = until - Date.now();
      if (left <= 0) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), left);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        return await Promise.race([p, timeout]);
      } finally {
        clearTimeout(timer);
      }
    };
    const earlier = this.#rootLookups.get(path);
    if (earlier !== undefined && (await within(earlier.done)) === undefined) return undefined;
    // Another caller may have started the next one meanwhile: share it.
    const next = this.#rootLookups.get(path) ?? this.#lookAt(path);
    const facts = await within(next.done);
    return facts === undefined || facts === "error" ? undefined : facts;
  }

  /** Starts one asynchronous look at a root unless one is in flight; returns the one in flight. */
  #lookAt(path: string): RootLookup {
    const inFlight = this.#rootLookups.get(path);
    if (inFlight !== undefined) return inFlight;
    const done = lookupRootFacts(path).then(
      (facts): RootFacts => {
        this.#looked(path, facts);
        return facts;
      },
      (): "error" => {
        this.#looked(path, "error");
        return "error";
      },
    );
    const entry: RootLookup = {
      done,
      waited: false,
      freshTimedOut: false,
      since: this.clock.now(),
      startedAt: Date.now(),
    };
    this.#rootLookups.set(path, entry);
    void done.finally(() => {
      if (this.#rootLookups.get(path) === entry) this.#rootLookups.delete(path);
    });
    return entry;
  }

  #looked(path: string, facts: RootFacts | "error"): void {
    this.#rootLooks.set(path, { facts, checkedAt: this.clock.now() });
    this.#rootVerdicts.delete(path);
    if (facts !== "error") this.#recordRefOnce(path, facts);
    // An older grant with nothing recorded counts only while its real path is the stored path
    // itself (up to spelling). That real path is then what later looks compare with (a parent
    // swapped afterwards is caught), and it is stored. Anything else waits for the owner.
    if (facts === "error" || facts.real === undefined || this.recordedReal(path) !== undefined)
      return;
    if (!sameRootSpelling(facts.real, path, this.#refuseEnv())) return;
    if (!this.#liveRoots().has(path) || this.folderRefused(path)) return;
    this.#observedReal.set(path, facts.real);
    this.#rootVerdicts.delete(path);
    const inSettings = (this.#policy.config.folders ?? []).some((f) => f.path === path);
    // Stored after this look is done (the store writes the policy, which calls `setPolicy`).
    // If that fails it is still remembered for as long as the Gateway runs.
    const real = facts.real;
    if (inSettings) {
      void Promise.resolve()
        .then(() => this.#folderAccess?.recordReal?.(path, real))
        .catch(() => {});
    }
  }

  /**
   * Records the identity of a Settings folder that is where it was granted, a plain folder
   * reached through no link, once (never replaced: it is what a reconnect is judged by).
   */
  #recordRefOnce(path: string, facts: RootFacts): void {
    const entry = (this.#policy.config.folders ?? []).find((f) => f.path === path);
    if (
      entry === undefined ||
      entry.ref !== undefined ||
      this.#folderAccess?.recordRef === undefined
    )
      return;
    if (facts.real === undefined || facts.link) return;
    const recorded = this.recordedReal(path);
    const env = this.#refuseEnv();
    if (!sameRootSpelling(facts.real, path, env)) return;
    if (recorded !== undefined && !sameRootSpelling(facts.real, recorded, env)) return;
    const real = facts.real;
    void folderRefOf(real)
      .then((ref) => (ref === undefined ? undefined : this.#folderAccess?.recordRef?.(path, ref)))
      .catch(() => {});
  }

  /**
   * A Settings folder the owner renamed or moved: its path is gone, its identity was recorded,
   * and the same folder is somewhere else now. Settings offers "Reconnect <name>?" with `to`.
   * Never re-points by itself (`reconnectFolder` is the owner's tap).
   */
  async folderReconnectOffer(path: string): Promise<string | undefined> {
    const entry = (this.#policy.config.folders ?? []).find((f) => f.path === path);
    if (entry?.ref === undefined || !(await pathIsGone(path))) return undefined;
    const cached = this.#reconnectOffers.get(path);
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.to;
    const env = this.#confirmEnv();
    const found = await locateFolder(path, entry.ref, env);
    let to: string | undefined;
    if (found !== undefined) {
      try {
        to = await checkReconnect(path, found, entry.ref, env);
      } catch {
        to = undefined;
      }
    }
    this.#reconnectOffers.set(path, { to, at: Date.now() });
    return to;
  }

  /**
   * The owner's tap on "Reconnect <name>?" (admin device). `to` is the place Settings showed; it
   * goes through every check of a fresh grant again (`checkReconnect`) and is refused when the
   * old path came back, when `to` is a link or reached through one, or when it is not the same
   * folder. Returns false when there is nothing to reconnect; throws what a fresh grant would
   * throw for a sensitive place.
   */
  async reconnectFolder(
    path: string,
    to: string,
    by: { deviceId: string; surface?: Surface },
  ): Promise<boolean> {
    const entry = (this.#policy.config.folders ?? []).find((f) => f.path === path);
    if (entry === undefined || this.#folderAccess?.repoint === undefined) return false;
    let real: string;
    try {
      real = await checkReconnect(path, to, entry.ref, this.#confirmEnv());
    } catch (err) {
      if (err instanceof ReconnectRefused) return false;
      throw err;
    }
    const done = await this.#folderAccess.repoint(path, real, { deviceId: by.deviceId });
    if (!done) return false;
    this.#reconnectOffers.delete(path);
    this.#observedReal.delete(path);
    this.#pruneRoots();
    await this.#log("folder.reconnected", actorOf(by), {}, { path, to: real });
    return true;
  }

  /** A root the owner just picked: its real path is known now, so no first look is needed. */
  #pickedRoot(path: string): void {
    this.#observedReal.set(path, path);
    this.#rootLooks.set(path, { facts: { real: path, link: false }, checkedAt: this.clock.now() });
    this.#rootVerdicts.delete(path);
  }

  subscribe(listener: (e: BrokerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(e: BrokerEvent): void {
    for (const l of [this.#onEvent, ...this.#listeners]) {
      try {
        l?.(structuredClone(e));
      } catch {
        // listeners never break the broker
      }
    }
  }

  async #log(
    kind: string,
    actor: AuditEntryInput["actor"],
    subject: JsonObject,
    data: JsonObject,
  ): Promise<void> {
    await this.audit?.append({ kind, actor, subject, data });
  }

  #task(ctx: PolicyContext): TaskState {
    const key = taskKey(ctx);
    let s = this.#tasks.get(key);
    if (s === undefined) {
      s = newTaskState();
      this.#tasks.set(key, s);
    }
    return s;
  }

  #ttl() {
    const g = this.#policy.config.grants ?? {};
    return {
      task: (g.taskHours ?? 24) * HOUR,
      destructiveTask: (g.destructiveTaskHours ?? 8) * HOUR,
      site: (g.siteExpiryDays ?? 30) * DAY,
      sessionIdle: (g.sessionIdleHours ?? 12) * HOUR,
      sessionMax: (g.sessionMaxHours ?? 24) * HOUR,
      always: (g.alwaysExpiryDays ?? 90) * DAY,
      execHostAlways: (g.execHostAlwaysExpiryDays ?? 30) * DAY,
    };
  }

  #approvalTtl(): number {
    const m = this.#policy.config.approvals?.ttlMinutes;
    return this.#ttlMs ?? (m === undefined ? APPROVAL_TTL_MS : m * 60_000);
  }

  // ---- decide -------------------------------------------------------------------------------

  async decide(call: PolicyCall, ctx: PolicyContext): Promise<PolicyDecision> {
    this.#sweep();
    const { decision, binding } = await this.engine.evaluate(call, ctx);
    if (decision.decision === "ask" && binding !== undefined) {
      // Keyed by the binding alone, kept for twice the approval lifetime: requestApproval restores
      // the broker's floors (side-effect class, scopes, typed confirmation) from it (review #1).
      const key = binding.bindingHash;
      const now = this.clock.now();
      this.#recent.delete(key);
      this.#recent.set(key, {
        call: structuredClone(decision.call),
        ctx: structuredClone(ctx),
        binding,
        decision,
        at: now,
      });
      const horizon = now - 2 * this.#approvalTtl();
      for (const [k, v] of this.#recent) {
        if (v.at >= horizon && this.#recent.size <= 20_000) break;
        this.#recent.delete(k);
      }
    }
    await this.#log(
      "tool_call.decided",
      { type: "agent", runId: ctx.runId },
      {
        runId: ctx.runId,
        threadId: ctx.threadId,
        ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
        ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      },
      {
        tool: call.tool,
        kind: decision.approvalKind ?? call.kind ?? inferApprovalKind(call.tool),
        sideEffect: decision.sideEffect,
        decision: decision.decision,
        rule: decision.rule,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.bindingHash === undefined ? {} : { bindingHash: decision.bindingHash }),
        ...(decision.grantId === undefined ? {} : { grantId: decision.grantId }),
        // A send / destructive / financial call let through without a card (§3.12).
        ...(decision.via === undefined ? {} : { via: decision.via }),
        paramsHash: call.paramsHash,
        ...(call.target === undefined ? {} : { target: call.target.value }),
        taint: ctx.taint,
        mode: ctx.permissionMode,
        trace: decision.trace,
      },
    );
    // A connector action the owner set to Deny is refused with a receipt naming the rule (#747),
    // so the refusal shows next to the other actions on that connector.
    if (decision.decision === "deny" && decision.rule.startsWith("connector:")) {
      await this.recordReceipt({
        kind: decision.rule.slice(decision.rule.indexOf("/") + 1),
        outcome: "failed",
        summary: `Refused ${call.tool}: ${decision.reason ?? "the connector matrix denies it"}`,
        taskId: ctx.taskId ?? null,
        toolCallId: call.toolCallId ?? null,
        payload: { rule: decision.rule, decision: "deny" },
      });
    }
    return decision;
  }

  /**
   * Dry-run `decide` (§4.4 pre-flight, #686): the same evaluation, with no side effect. It skips
   * the sweep, grant use, the classifier, the audit entry, the receipt and the recent-decision
   * cache, and it never writes the broker's Task state (the engine works on copies). Hooks still
   * run, as they do in `decide`, so they must be pure.
   */
  async preview(intents: ToolCallIntent[], ctx: PolicyContext): Promise<PreviewResult[]> {
    const dry: DryRun = { scratch: new Map() };
    const out: PreviewResult[] = [];
    for (const intent of intents) {
      const call = structuredClone(intent) as PolicyCall;
      const { decision } = await this.engine.evaluate(call, ctx, dry);
      const kind = decision.approvalKind;
      const deviceOnly =
        decision.decision === "ask" &&
        kind !== undefined &&
        (decision.deviceOnly === true ||
          isDeviceOnly(kind, decision.sideEffect, this.#policy.config.approvals?.deviceOnly));
      out.push({
        tool: call.tool,
        decision: deviceOnly ? "device-only" : decision.decision,
        rule: decision.rule,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(kind === undefined || decision.decision !== "ask" ? {} : { approvalKind: kind }),
        ...(decision.scopesOffered === undefined || decision.decision !== "ask"
          ? {}
          : { scopesOffered: decision.scopesOffered }),
      });
    }
    return out;
  }

  async #onClassified(
    ctx: PolicyContext,
    call: PolicyCall,
    label: string,
    reason: string,
    breaker?: "pause" | "downgrade",
  ) {
    const subject = {
      runId: ctx.runId,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
    };
    await this.#log("classifier.labeled", { type: "system" }, subject, {
      classifier: this.#classifierId,
      tool: call.tool,
      label,
      reason,
    });
    if (breaker === undefined) return;
    await this.#log("classifier.circuit_open", { type: "system" }, subject, { action: breaker });
    if (ctx.taskId === undefined) return;
    if (breaker === "downgrade") {
      this.#emit({
        type: "task.downgraded",
        taskId: ctx.taskId,
        reason: "three consecutive sensitive labels",
      });
      return;
    }
    this.#emit({ type: "task.paused", taskId: ctx.taskId, reason: "possible injection" });
    await this.#notifier
      ?.notify({
        kind: "task_failed",
        title: "Task paused: possible injection",
        body: "Two actions were labeled prohibited. Review the task before resuming it.",
        taskId: ctx.taskId,
        dedupeKey: `possible_injection:${ctx.taskId}`,
      })
      .catch(() => undefined);
  }

  // ---- grants matching ----------------------------------------------------------------------

  #matchGrant(
    grantKey: string,
    kind: ApprovalKind,
    se: SideEffect,
    ctx: PolicyContext,
    origin: string | undefined,
  ) {
    // A login typed into the separate desktop is never covered by a standing grant.
    if (kind === "credential_fill" && isSeparateDesktopCredentialKey(grantKey)) return undefined;
    const now = this.clock.now();
    const allowed = allowedScopes(se, kind);
    for (const rec of this.#store.listGrants()) {
      const g = rec.grant;
      if (g.revokedAt != null || g.grantKey !== grantKey || g.kind !== kind) continue;
      if (g.expiresAt != null && Date.parse(g.expiresAt) <= now) continue;
      if (!allowed.includes(g.scope)) continue;
      if (SEVERITY[se] > SEVERITY[rec.meta.sideEffect]) continue;
      if (g.scope === "task" && (g.taskId == null || g.taskId !== ctx.taskId)) continue;
      if (
        g.scope === "session" &&
        (rec.meta.sessionId !== this.#bootId || rec.meta.threadId !== ctx.threadId)
      )
        continue;
      if (g.scope === "site" && kind !== "credential_fill" && rec.meta.origin !== origin) continue;
      if (rec.meta.maxUses !== null && g.useCount >= rec.meta.maxUses) continue;
      // Grants never cross requesters: the owner's do not cover a designated person, and theirs
      // do not cover the owner (security §9).
      if ((rec.meta.requesterId ?? null) !== requesterKey(ctx.requester)) continue;
      return rec;
    }
    return undefined;
  }

  /** The trusted-site entry of a grant, if it is one (its grant key must match its own fields). */
  static trustedSiteOf(rec: StoredGrant): TrustedSite | undefined {
    const t = (rec.grant.subject as { trustedSite?: { origin?: unknown; subdomains?: unknown } })
      .trustedSite;
    if (t === undefined || typeof t.origin !== "string") return undefined;
    const site: TrustedSite = { origin: t.origin, subdomains: t.subdomains === true };
    return rec.grant.kind === "new_origin" &&
      rec.grant.grantKey === grantKeyHash("trusted_site", site)
      ? site
      : undefined;
  }

  /** Whether a live trusted-site entry of the owner covers this origin (Balanced reads). */
  #trustedSite(origin: string): boolean {
    const now = this.clock.now();
    for (const rec of this.#store.listGrants()) {
      const g = rec.grant;
      if (g.revokedAt != null || (g.expiresAt != null && Date.parse(g.expiresAt) <= now)) continue;
      if ((rec.meta.requesterId ?? null) !== null) continue;
      const site = PsychePermissionBroker.trustedSiteOf(rec);
      if (site !== undefined && trustedSiteCovers(site, origin)) return true;
    }
    return false;
  }

  /**
   * What a first-read card may offer as "Always for this site": the exact origin (server-computed
   * from the call, never from the answer) when the read is a Balanced, untainted, owner read of a
   * site that is not on the sensitive list and may be trusted at all.
   */
  #trustSiteOffer(
    recent: { call: PolicyCall; ctx: PolicyContext } | undefined,
    input: PolicyApprovalInput,
    se: SideEffect,
  ): { origin: string; subdomains: boolean } | undefined {
    // The call the broker itself decided (never a caller-supplied one) names the origin.
    const call = recent?.call;
    const ctx = recent?.ctx;
    if (call === undefined || ctx === undefined || se !== "read") return undefined;
    if (call.sideEffect !== "read") return undefined;
    if (ctx.permissionMode !== "balanced" || input.taint || ctx.taint === true) return undefined;
    if (ctx.initiator === "mcp_app") return undefined;
    if (ctx.requester !== undefined && ctx.requester.role !== "owner") return undefined;
    if (!trustedRead(call) || call.target?.kind !== "origin") return undefined;
    const origin = safeOrigin(call.target.value);
    if (origin === undefined) return undefined;
    try {
      const host = new URL(origin).hostname;
      if (isSensitiveHost(this.#policy, host)) return undefined;
      // A brokerage, exchange or bank is never a quiet read, and a shared-tenant host would
      // trust every tenant's pages at once.
      if (venueOfHost(host) !== undefined || isSharedTenantHost(host)) return undefined;
      normalizeTrustedSite(origin);
      let subdomains = true;
      try {
        normalizeTrustedSite(origin, true);
      } catch {
        subdomains = false;
      }
      return { origin, subdomains };
    } catch (e) {
      if (e instanceof TrustedSiteError) return undefined;
      throw e;
    }
  }

  #newTrustedSiteGrant(
    rec: StoredApproval,
    offer: { origin: string },
    subdomains: boolean,
    by: DecidedBy,
    now: number,
  ): StoredGrant {
    const a = rec.approval;
    const site: TrustedSite = { origin: offer.origin, subdomains };
    const grantKey = grantKeyHash("trusted_site", site);
    return {
      grant: {
        id: this.#newId("grt"),
        kind: "new_origin",
        scope: "always",
        grantKey,
        subject: {
          grantKey,
          trustedSite: { ...site },
          target: { kind: "origin", value: site.origin },
          sideEffect: "read",
        },
        binding: null,
        expiresAt: new Date(now + this.#ttl().always).toISOString(),
        useCount: 0,
        lastUsedAt: null,
        createdFromApprovalId: a.id,
        taskId: null,
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      },
      meta: {
        sideEffect: "read",
        sessionId: null,
        threadId: null,
        origin: null,
        createdByDeviceId: "deviceId" in by ? by.deviceId : null,
        maxUses: null,
        lastUsedBindingHash: null,
        revokedReason: null,
        requesterId: null,
      },
    };
  }

  /** The program grant of a stored grant, if it is one (its key must match its own fields). */
  static hostProgramOf(rec: StoredGrant): HostProgramGrant | undefined {
    const h = (rec.grant.subject as { hostProgram?: Record<string, unknown> }).hostProgram;
    if (h === undefined || h === null || typeof h !== "object") return undefined;
    const { executable, sha256, folder, argv } = h;
    if (typeof executable !== "string" || typeof sha256 !== "string" || typeof folder !== "string")
      return undefined;
    if (argv !== null && !(Array.isArray(argv) && argv.every((a) => typeof a === "string")))
      return undefined;
    const out: HostProgramGrant = { executable, sha256, folder, argv: argv as string[] | null };
    return rec.grant.kind === "exec_host" &&
      rec.grant.scope === "always" &&
      rec.grant.grantKey === grantKeyHash("host_program", out)
      ? out
      : undefined;
  }

  /** What a host command is, for a program grant: the call's own params and the Gateway's meta. */
  #hostFacts(call: PolicyCall): HostProgramFacts | undefined {
    const hp = call.meta?.hostProgram;
    const p = (call.params ?? {}) as {
      argv?: unknown;
      cwd?: unknown;
      env?: unknown;
      allowedDomains?: unknown;
    };
    if (hp === undefined || !Array.isArray(p.argv) || typeof p.cwd !== "string") return undefined;
    if (p.env !== undefined && (typeof p.env !== "object" || p.env === null)) return undefined;
    if (p.allowedDomains !== undefined && !Array.isArray(p.allowedDomains)) return undefined;
    // The binding the engine hashed names the same binary, or the description is not trusted.
    const b = (call.binding ?? {}) as { executable?: unknown; executableSha256?: unknown };
    if (b.executable !== undefined && b.executable !== hp.executable) return undefined;
    if (b.executableSha256 !== undefined && b.executableSha256 !== hp.sha256) return undefined;
    return {
      argv: p.argv as string[],
      cwd: p.cwd,
      env: p.env as Record<string, unknown> | undefined,
      allowedDomains: p.allowedDomains as unknown[] | undefined,
      executable: hp.executable,
      sha256: hp.sha256,
      cwdReal: hp.cwdReal,
    };
  }

  #hostProgramRefusal(f: HostProgramFacts, threadId: string | undefined): string | undefined {
    return hostProgramRefusal(f, {
      platform: this.#hostProgram.platform ?? process.platform,
      roots: this.#hostProgram.roots ?? HOST_PROGRAM_ROOTS,
      inGrantedFolder: (path) => this.engine.folderFor(path, threadId) !== undefined,
    });
  }

  /**
   * Whether a granted root covers nothing now (`grantedRootRefused`): inside a system root as
   * written or by its real path, or leading somewhere else than where it was granted. Settings
   * lists such a folder as refused. Judged from the last look at the disk (`#rootLooks`), never
   * a synchronous lookup: a look older than `FOLDER_FRESH_MS` starts an asynchronous refresh and
   * the last verdict holds meanwhile; a failed look, or a refresh outstanding for
   * `FOLDER_STALE_CAP_MS` (a hung mount), refuses. Before the first look completes the root is
   * judged as written (an evaluation waits briefly for it, see `#settleFolders`).
   */
  folderRefused(path: string): boolean {
    const env = this.#refuseEnv();
    const key = `sys\0${path}`;
    let named = this.#refusedMemo.get(key);
    if (named === undefined) {
      named = inSystemRoot(path, env);
      this.#refusedMemo.set(key, named);
    }
    if (named) return true;
    const now = this.clock.now();
    let look = this.#rootLooks.get(path);
    if (look === undefined) {
      look = { facts: { link: false }, checkedAt: now, first: true };
      this.#rootLooks.set(path, look);
      this.#lookAt(path);
    } else if (now - look.checkedAt > FOLDER_FRESH_MS) this.#lookAt(path);
    const lookup = this.#rootLookups.get(path);
    if (lookup !== undefined && now - lookup.since > FOLDER_STALE_CAP_MS) return true;
    if (look.facts === "error") return true;
    if (look.first === true) return grantedRootRefused(path, look.facts, undefined, env);
    let verdict = this.#rootVerdicts.get(path);
    if (verdict === undefined) {
      verdict = grantedRootRefused(path, look.facts, this.recordedReal(path), env);
      this.#rootVerdicts.set(path, verdict);
    }
    return verdict;
  }

  /** A workspace root: refused like a grant would be (`refuseFolder`), or inside a system root. */
  #workspaceRefused(path: string): boolean {
    const key = `ws\0${path}`;
    let byName = this.#refusedMemo.get(key);
    if (byName === undefined) {
      byName = refuseFolder(path, this.#refuseEnv()) !== undefined;
      this.#refusedMemo.set(key, byName);
    }
    return byName || this.folderRefused(path);
  }

  #refuseEnv(): FolderAccessEnv {
    return {
      ...(this.#hostProgram.home === undefined ? {} : { home: this.#hostProgram.home }),
      ...(this.#psycheHome === undefined ? {} : { psycheHome: this.#psycheHome }),
    };
  }

  /** The folder an offer or a grant covers: a shared folder that is not home or a sensitive root. */
  #hostProgramFolder(cwd: string, threadId: string | undefined): string | undefined {
    let c: string;
    try {
      c = canonicalPath(cwd);
    } catch {
      return undefined;
    }
    const root = this.engine.folderFor(c, threadId)?.path;
    if (root === undefined) return undefined;
    return refuseFolder(root, this.#refuseEnv()) === undefined ? root : undefined;
  }

  /** A live program grant that covers this host command (security §5.4); never in a tainted turn. */
  #hostProgramGrant(call: PolicyCall, ctx: PolicyContext): StoredGrant | undefined {
    if (ctx.taint === true) return undefined;
    if (ctx.requester !== undefined && ctx.requester.role !== "owner") return undefined;
    const f = this.#hostFacts(call);
    if (f === undefined || this.#hostProgramRefusal(f, ctx.threadId) !== undefined) {
      return undefined;
    }
    // The folder must still be a shared one, and the command must run inside it.
    if (this.#hostProgramFolder(f.cwd, ctx.threadId) === undefined) return undefined;
    if (readsCwdConfig(f.executable) || readsCwdConfig(f.argv[0] as string)) return undefined;
    const now = this.clock.now();
    for (const rec of this.#store.listGrants()) {
      const g = rec.grant;
      if (g.revokedAt != null || (g.expiresAt != null && Date.parse(g.expiresAt) <= now)) continue;
      if ((rec.meta.requesterId ?? null) !== null) continue;
      const h = PsychePermissionBroker.hostProgramOf(rec);
      if (h === undefined || !hostProgramGrantCovers(h, f)) continue;
      // Granted folders can be revoked: the grant's own folder must still be shared.
      if (this.engine.folderFor(h.folder, ctx.threadId) === undefined) continue;
      if (refuseFolder(h.folder, this.#refuseEnv()) !== undefined) continue;
      return rec;
    }
    return undefined;
  }

  /**
   * What an `exec_host` card may offer as "Always allow <program> in <folder>": computed from the
   * call the broker itself decided, never from the caller's details or the answer.
   */
  #hostProgramOffer(
    recent: { call: PolicyCall; ctx: PolicyContext } | undefined,
    input: PolicyApprovalInput,
  ): (HostProgramGrant & { program: string }) | undefined {
    const call = recent?.call;
    const ctx = recent?.ctx;
    if (call === undefined || ctx === undefined || input.kind !== "exec_host") return undefined;
    if (ctx.permissionMode === "manual") return undefined;
    if (input.taint || ctx.taint === true || ctx.initiator === "mcp_app") return undefined;
    if (ctx.requester !== undefined && ctx.requester.role !== "owner") return undefined;
    const f = this.#hostFacts(call);
    if (f === undefined || this.#hostProgramRefusal(f, ctx.threadId) !== undefined) {
      return undefined;
    }
    const folder = this.#hostProgramFolder(f.cwd, ctx.threadId);
    if (folder === undefined) return undefined;
    // A program that reads config from the working directory (git, make, npm…) never gets a
    // folder-wide grant: the config can change under it, and a grant cannot bind its hashes.
    if (readsCwdConfig(f.executable) || readsCwdConfig(f.argv[0] as string)) return undefined;
    // Only the read tools that cannot run code: every other program keeps its exact grant.
    if (hostProgramCoverage(f.argv, f.executable) !== "any") return undefined;
    const any = true;
    return {
      program: basename(f.executable),
      executable: f.executable,
      sha256: f.sha256,
      folder,
      argv: any ? null : [...f.argv],
    };
  }

  #newHostProgramGrant(
    rec: StoredApproval,
    offer: HostProgramGrant,
    by: DecidedBy,
    now: number,
  ): StoredGrant {
    const a = rec.approval;
    const key: HostProgramGrant = {
      executable: offer.executable,
      sha256: offer.sha256,
      folder: offer.folder,
      argv: offer.argv,
    };
    const grantKey = grantKeyHash("host_program", key);
    return {
      grant: {
        id: this.#newId("grt"),
        kind: "exec_host",
        scope: "always",
        grantKey,
        subject: {
          grantKey,
          hostProgram: { ...key, argv: key.argv === null ? null : [...key.argv] },
          target: { kind: "command", value: basename(key.executable) },
          sideEffect: "destructive",
        },
        binding: null,
        // 30 days, like every other host-command grant.
        expiresAt: new Date(now + this.#ttl().execHostAlways).toISOString(),
        useCount: 0,
        lastUsedAt: null,
        createdFromApprovalId: a.id,
        taskId: null,
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      },
      meta: {
        sideEffect: "destructive",
        sessionId: null,
        threadId: null,
        origin: null,
        createdByDeviceId: "deviceId" in by ? by.deviceId : null,
        maxUses: null,
        lastUsedBindingHash: null,
        revokedReason: null,
        requesterId: null,
      },
    };
  }

  #useGrant(rec: StoredGrant, bindingHash: string, taskId?: string | null): StoredGrant {
    const now = this.clock.now();
    const next = structuredClone(rec);
    next.grant.useCount += 1;
    next.grant.lastUsedAt = new Date(now).toISOString();
    next.meta.lastUsedBindingHash = bindingHash;
    if (next.grant.scope === "session") {
      // Idle expiry renews on use but never past the absolute cap (design-28).
      const ttl = this.#ttl();
      const cap = Date.parse(next.grant.createdAt) + ttl.sessionMax;
      next.grant.expiresAt = new Date(Math.min(now + ttl.sessionIdle, cap)).toISOString();
    }
    this.#store.updateGrant(next);
    const from = next.grant.createdFromApprovalId;
    const fromSetAside = from != null && this.#store.getApproval(from)?.approval.setAside === true;
    this.#emit({
      type: "grant.used",
      grant: next.grant,
      bindingHash,
      ...(taskId == null ? {} : { taskId }),
      ...(fromSetAside ? { fromSetAside: true as const } : {}),
    });
    void this.#log(
      "grant.used",
      { type: "system" },
      { grantId: next.grant.id },
      { useCount: next.grant.useCount, bindingHash },
    );
    return next;
  }

  // ---- approvals ----------------------------------------------------------------------------

  /**
   * One approval for a listed set of `write` calls (an `ActionProposal`; docs/workflows/
   * mail-and-meetings-2026.md §8.1). Each call is decided now, as the loop would decide it. The
   * batch is refused when any call is denied, when any call's effective side effect is above
   * `write` (after the broker's floors), or when any call is a send, a device-only or an
   * authentication kind. The approval binds the ordered list of the calls' own binding hashes,
   * offers `once` only, and on approval mints one approved child approval per call.
   */
  async requestBatch(input: PolicyBatchInput): Promise<IssuedApproval> {
    this.#sweep();
    if (input.children.length === 0 || input.children.length > MAX_BATCH_CALLS) {
      fail("invalid_params", `a batch holds 1 to ${MAX_BATCH_CALLS} calls`);
    }
    const children: BatchChild[] = [];
    // Per child: the live prep-note standing grant that covers it (security §3.4), and whether
    // the decision already used it. Taint is never exempted: a tainted call asks and is not covered.
    const byGrant: { grant: StoredGrant; used: boolean }[] = [];
    for (const [i, c] of input.children.entries()) {
      const d = await this.decide(c.call, input.context);
      const kind = d.approvalKind ?? c.call.kind ?? inferApprovalKind(c.call.tool);
      const at = `call ${i + 1} (${c.call.tool})`;
      const covering = this.#prepGrantFor(c.call, d);
      if (covering !== undefined) byGrant.push(covering);
      if (d.decision === "deny") {
        fail("policy_denied", `${at} is denied: ${d.reason ?? d.rule}`);
      }
      if (SEVERITY[d.sideEffect] > SEVERITY.write) {
        fail("policy_denied", `${at} is ${d.sideEffect}; a batch holds write actions only`);
      }
      if (
        kind === "send_email" ||
        kind === "batch" ||
        DEVICE_ONLY_KINDS.includes(kind) ||
        AUTH_KINDS.includes(kind)
      ) {
        fail("policy_denied", `${at} (${kind}) needs its own approval`);
      }
      children.push({
        call: structuredClone(d.call),
        kind,
        bindingHash:
          d.bindingHash ??
          c.call.bindingHash ??
          bindingHash(kind, { tool: c.call.tool, paramsHash: c.call.paramsHash }),
        grantKey: d.grantKey ?? c.call.grantKey ?? `${c.call.tool}|${c.call.target?.value ?? "*"}`,
        sideEffect: d.sideEffect,
        summary: sanitizeDisplay(c.summary).slice(0, 300),
      });
    }
    const hash = bindingHash("batch", { children: children.map((c) => c.bindingHash) });
    // Every call is a Prep-titled `notes_create`: the card may offer the narrow `always` grant
    // for prep notes, and a live grant that covers every call approves the batch without a card.
    const prepNotes = children.length > 0 && children.every((c) => this.#isPrepChild(c));
    const covered = prepNotes ? byGrant : [];
    const issued = this.#issue({
      kind: "batch",
      summary: input.title,
      details: {
        ...(input.details ?? {}),
        title: input.title,
        count: children.length,
        calls: children.map((c) => c.summary),
      },
      bindingHash: hash,
      grantKey: `batch|${hash}`,
      requestedBy: { ...input.requestedBy },
      sideEffect: "write",
      surfaces: input.surfaces,
      // A tainted batch is never offered `always`: taint overrides grants (§3.6), so it would not apply.
      scopesOffered: prepNotes && !input.context.taint ? ["once", "always"] : ["once"],
      taint: input.context.taint,
      ...(input.taintSources === undefined ? {} : { taintSources: input.taintSources }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      context: structuredClone(input.context),
      batch: { children },
    });
    if (prepNotes && covered.length === children.length) {
      for (const [i, c] of covered.entries()) {
        const child = children[i];
        if (c.used || child === undefined) continue;
        // Re-read: one grant may cover several calls, each counting its own use.
        this.#useGrant(this.#store.getGrant(c.grant.grant.id) ?? c.grant, child.bindingHash);
      }
      const first = covered[0];
      if (first !== undefined) return await this.#approveBatchByGrant(issued, first.grant);
    }
    await this.#afterIssue(issued.approval);
    return issued;
  }

  /** A batch child that is a Prep-titled `notes_create`, keyed by the connector's own class. */
  #isPrepChild(c: BatchChild): boolean {
    return isPrepNoteCall({ tool: c.call.tool, params: c.call.params, grantKey: c.grantKey });
  }

  /**
   * The live prep-note grant that already approved this call (a decision of `allow` under it), or
   * undefined. Taint is never exempted (security §3.6): a tainted batch decides `ask` and is not
   * covered. The caller uses the grant only when the whole batch is covered.
   */
  #prepGrantFor(
    call: PolicyCall,
    d: PolicyDecision,
  ): { grant: StoredGrant; used: boolean } | undefined {
    const grantKey = d.grantKey ?? call.grantKey;
    if (grantKey === undefined || !isPrepNoteCall({ ...call, grantKey })) return undefined;
    if (d.decision !== "allow") return undefined;
    const used = d.grantId === undefined ? undefined : this.#store.getGrant(d.grantId);
    return used === undefined ? undefined : { grant: used, used: true };
  }

  /**
   * The batch is approved by a standing grant: no card, no notification. It is recorded as
   * approved under that grant (`scopeGranted: always`, `grantId`) with one minted child per call,
   * exactly as an answered card would leave it.
   */
  async #approveBatchByGrant(issued: IssuedApproval, grant: StoredGrant): Promise<IssuedApproval> {
    const now = this.clock.now();
    const decided = this.#store.transaction(() => {
      const rec = this.#store.getApproval(issued.approval.id);
      if (rec === undefined) return undefined;
      const a = rec.approval;
      a.status = "approved";
      a.scopeGranted = "always";
      a.decidedBy = null;
      a.decidedAt = new Date(now).toISOString();
      a.grantId = grant.grant.id;
      for (const t of rec.tokens) t.usedAt = a.decidedAt;
      this.#mintBatchChildren(rec, null, now);
      this.#store.updateApproval(rec);
      return rec;
    });
    this.#timers.get(issued.approval.id)?.();
    this.#timers.delete(issued.approval.id);
    if (decided === undefined) return issued;
    const a = decided.approval;
    await this.#log(
      "approval.decided",
      { type: "system" },
      { approvalId: a.id },
      {
        decision: "allow",
        grantScope: "always",
        grantId: grant.grant.id,
        bindingHash: a.bindingHash,
        taint: a.taint,
        via: "grant",
      },
    );
    this.#settled(a, "approval.decided");
    return { approval: structuredClone(a), answerTokens: {} };
  }

  /**
   * The minted child approvals of an approved batch, in order, with the calls they cover.
   * Empty until the batch is approved (and for any other kind).
   */
  async batchChildren(
    batchApprovalId: string,
  ): Promise<{ approval: ApprovalRequest; call: PolicyCall; summary: string }[]> {
    this.#sweep();
    const rec = this.#store.getApproval(batchApprovalId);
    if (rec === undefined || rec.approval.kind !== "batch" || rec.approval.status !== "approved") {
      return [];
    }
    const out: { approval: ApprovalRequest; call: PolicyCall; summary: string }[] = [];
    for (const [i, c] of (rec.input.batch?.children ?? []).entries()) {
      const child = this.#store.getApproval(batchChildId(batchApprovalId, i));
      if (child === undefined) continue;
      out.push({
        approval: structuredClone(child.approval),
        call: structuredClone(c.call),
        summary: c.summary,
      });
    }
    return out;
  }

  #mintBatchChildren(batch: StoredApproval, by: DecidedBy | null, now: number): void {
    const children = batch.input.batch?.children ?? [];
    const at = new Date(now).toISOString();
    const expiresAt = new Date(now + BATCH_CHILD_TTL_MS).toISOString();
    for (const [i, c] of children.entries()) {
      const approval: ApprovalRequest = {
        id: batchChildId(batch.approval.id, i),
        kind: c.kind,
        summary: c.summary,
        details: { batchApprovalId: batch.approval.id, index: i, tool: c.call.tool },
        bindingHash: c.bindingHash,
        grantKey: c.grantKey,
        requestedBy: {
          ...batch.approval.requestedBy,
          toolCallId: `${batch.approval.id}:${i}`,
        },
        surfaces: [],
        scopesOffered: ["once"],
        deviceOnly: false,
        requiresAuthentication: false,
        taint: batch.approval.taint,
        status: "approved",
        scopeGranted: "once",
        decidedBy: by === null ? null : structuredClone(by),
        requestedAt: at,
        expiresAt,
        decidedAt: at,
        grantId: null,
      };
      approval.sideEffect = c.sideEffect;
      if (batch.approval.taintSources !== undefined) {
        approval.taintSources = structuredClone(batch.approval.taintSources);
      }
      this.#store.insertApproval({
        approval,
        tokens: [],
        input: {
          kind: c.kind,
          summary: c.summary,
          details: approval.details,
          bindingHash: c.bindingHash,
          grantKey: c.grantKey,
          requestedBy: approval.requestedBy,
          sideEffect: c.sideEffect,
          surfaces: [],
          taint: approval.taint,
          call: structuredClone(c.call),
          ...(batch.input.context === undefined ? {} : { context: batch.input.context }),
        },
        consumedAt: null,
        revoked: false,
        bootId: this.#bootId,
      });
    }
  }

  async requestApproval(input: PolicyApprovalInput): Promise<IssuedApproval> {
    this.#sweep();
    const issued = this.#issue(input);
    await this.#afterIssue(issued.approval);
    return issued;
  }

  #issue(raw: PolicyApprovalInput, carry: { setAside?: boolean } = {}): IssuedApproval {
    const now = this.clock.now();
    const input: PolicyApprovalInput & GrantFields = structuredClone(raw);
    const recent = this.#recent.get(input.bindingHash);
    if (recent !== undefined) {
      input.call ??= recent.call;
      input.context ??= recent.ctx;
      if (recent.decision.typedConfirmation !== undefined)
        input.typedConfirmation ??= recent.decision.typedConfirmation;
      if (recent.binding.grantKey === input.grantKey)
        input.grantFields ??= recent.binding.grantFields;
      // The broker's own side-effect floor wins over a lower declared class.
      if (SEVERITY[recent.decision.sideEffect] > SEVERITY[input.sideEffect])
        input.sideEffect = recent.decision.sideEffect;
      // And a host command it checked into the read-only class (§5.4) reads as one on its card,
      // although the tool itself is declared `destructive`.
      if (input.kind === "exec_host" && recent.decision.sideEffect === "read")
        input.sideEffect = "read";
    }
    const se = input.sideEffect;
    // Device-only from the request itself, or from the decision that asked for it (the agent loop
    // requests with the protocol's input type, which has no such flag, right after `decide`).
    const deviceOnly =
      input.deviceOnly === true ||
      recent?.decision.deviceOnly === true ||
      isDeviceOnly(input.kind, se, this.#policy.config.approvals?.deviceOnly);
    // Presence (the owner sheet, a passkey, the Linux password) is for payments only (owner's
    // decision, 2026-11-09): a purchase or any financial action. Every other approval is a tap on
    // a card, still bound to its answer token, binding hash and arm delay. The Gateway sets
    // `requireAuthentication` itself for the one other case, enrolling a presence verifier.
    const requiresAuthentication =
      se === "financial" || input.kind === "purchase" || input.requireAuthentication === true;
    // A non-owner requester never sees the card for their own request (security §9).
    const requester = input.context?.requester;
    const own = new Set(requesterSurfaces(requester));
    let surfaces = [
      ...new Set(
        (deviceOnly ? input.surfaces.filter((s) => !isChat(s)) : input.surfaces).filter(
          (s) => !own.has(s),
        ),
      ),
    ];
    if (surfaces.length === 0) surfaces = ["desktop"];

    const allowed = allowedScopes(se, input.kind);
    const fromDecision = recent?.decision.scopesOffered;
    let scopesOffered = [...new Set(input.scopesOffered ?? fromDecision ?? allowed)].filter(
      (s) =>
        allowed.includes(s) &&
        (fromDecision === undefined || fromDecision.includes(s)) &&
        (s !== "task" || input.requestedBy.taskId != null) &&
        (s !== "session" || input.requestedBy.threadId != null),
    );
    if (input.typedConfirmation !== undefined)
      scopesOffered = scopesOffered.filter((s) => s === "once");
    // Taint always overrides standing grants (§3.6): a tainted folder request is never kept.
    // So is a tainted send, destructive or financial card: `once` only, never Always (§3.12).
    if (
      (input.kind === "folder_access" ||
        input.kind === "separate_desktop_share" ||
        floorClass(input.kind, se) !== undefined) &&
      (input.taint || input.context?.taint === true)
    )
      scopesOffered = scopesOffered.filter((s) => s === "once");
    if (scopesOffered.length === 0) scopesOffered = ["once"];
    if (input.kind === "credential_fill" && isSeparateDesktopCredentialKey(input.grantKey)) {
      scopesOffered = ["once"];
    }

    const details = sanitizeDetails(input.details) as JsonObject;
    if (input.typedConfirmation !== undefined) details.confirmationWord = input.typedConfirmation;
    if (requester !== undefined && requester.role !== "owner") {
      details.requestedFor = sanitizeDisplay(
        `${requester.role}: ${requester.display ?? requester.identityId ?? requester.senderId ?? "unknown"}`,
      );
    }
    // Only the Gateway's own decision may offer it: a caller-supplied `details.trustSite` is dropped.
    delete details.trustSite;
    // Only the owner's answer sets these (`answer`): UNSANDBOXED typed on the card, the folder
    // the picker picked, the compose card's final message. A caller's own are dropped, so a
    // card nobody answered that way never runs unsandboxed or grants a folder.
    delete details.unsandboxed;
    delete details.granted;
    delete details.final;
    const trustOffer = this.#trustSiteOffer(recent, input, se);
    if (trustOffer !== undefined) details.trustSite = { ...trustOffer };
    delete details.hostProgram;
    const programOffer = this.#hostProgramOffer(recent, input);
    if (programOffer !== undefined) {
      details.hostProgram = {
        program: programOffer.program,
        executable: programOffer.executable,
        sha256: programOffer.sha256,
        folder: programOffer.folder,
        argv: programOffer.argv,
      };
    }
    const sources = input.taintSources ?? input.context?.taintSources;
    if (sources !== undefined && sources.length > 0) {
      details.taintSources = sources.map((s) =>
        sanitizeDisplay(`${s.sourceKind}:${s.origin ?? s.sender ?? "?"}`),
      );
    }
    const approval: ApprovalRequest = {
      id: this.#newId("apr"),
      kind: input.kind,
      summary: sanitizeDisplay(input.summary),
      details,
      bindingHash: input.bindingHash,
      grantKey: input.grantKey,
      requestedBy: { ...input.requestedBy },
      surfaces,
      scopesOffered,
      deviceOnly,
      requiresAuthentication,
      taint: input.taint || input.context?.taint === true,
      status: "pending",
      scopeGranted: null,
      decidedBy: null,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? this.#approvalTtl())).toISOString(),
      decidedAt: null,
      grantId: null,
    };
    approval.sideEffect = se;
    // Keyed on the decision that asked (its rule), never on a label the ask path does not carry.
    approval.riskClass = riskClassFor({
      kind: input.kind,
      sideEffect: se,
      requiresAuthentication,
      taint: approval.taint,
      deviceOnly,
      typedConfirmation: input.typedConfirmation !== undefined,
      // Only the decision this run made counts: another run's ask under the same binding does not.
      recent:
        recent === undefined || recent.ctx.runId !== input.requestedBy.runId
          ? undefined
          : {
              call: recent.call,
              ctx: recent.ctx,
              decision: recent.decision,
              fields: recent.binding.fields,
            },
    });
    // The agent loop set this action aside: it says so, and its unattended run asked through
    // `decide` and went on without it. Nothing waits on the card, so approving it starts a resume
    // run (`canResume`). A caller that awaits its card (webhook delivery) never sets the flag.
    if (
      carry.setAside === true ||
      (input.setAside === true &&
        recent?.decision.deferred === true &&
        recent.ctx.unattended === true &&
        recent.ctx.runId === input.requestedBy.runId &&
        input.requestedBy.runId != null)
    ) {
      approval.setAside = true;
    }
    if (approval.taint && sources !== undefined && sources.length > 0) {
      approval.taintSources = cardTaintSources(sources);
    }
    // Kept with the stored input, so a SQLite store (no column for them) gives them back.
    const card = input as PolicyApprovalInput & StoredCardFields;
    card.cardRiskClass = approval.riskClass;
    if (approval.setAside === true) card.cardSetAside = true;
    else delete card.cardSetAside;
    if (input.targetKind !== undefined) approval.targetKind = input.targetKind;
    if (input.target !== undefined) approval.target = { ...input.target };
    if (input.fromLesson !== undefined) {
      approval.fromLesson = {
        lessonId: input.fromLesson.lessonId,
        feedbackId: input.fromLesson.feedbackId,
        because: sanitizeDisplay(input.fromLesson.because).slice(0, 500),
      };
    }
    const answerTokens: Record<Surface, string> = {};
    const tokens = surfaces.map((surface) => {
      const token = `at_${randomBytes(24).toString("base64url")}`;
      answerTokens[surface] = token;
      return { surface, hash: sha256(token), usedAt: null };
    });
    this.#store.insertApproval({
      approval,
      tokens,
      input,
      consumedAt: null,
      revoked: false,
      bootId: this.#bootId,
    });
    this.#armExpiry(approval);
    return { approval: structuredClone(approval), answerTokens };
  }

  async #afterIssue(a: ApprovalRequest): Promise<void> {
    this.#emit({ type: "approval.created", approval: a });
    await this.#log(
      "approval.created",
      { type: "system" },
      {
        approvalId: a.id,
        ...(a.requestedBy.taskId == null ? {} : { taskId: a.requestedBy.taskId }),
        ...(a.requestedBy.toolCallId === undefined ? {} : { toolCallId: a.requestedBy.toolCallId }),
      },
      {
        kind: a.kind,
        sideEffect: a.sideEffect ?? null,
        bindingHash: a.bindingHash,
        surfaces: a.surfaces,
        scopesOffered: a.scopesOffered,
        deviceOnly: a.deviceOnly,
        taint: a.taint,
        expiresAt: a.expiresAt,
      },
    );
    if (this.#notifier === undefined) return;
    // A card an unattended run waits on is announced by the automation digest, not one by one.
    if (await this.#isDeferred(a)) return;
    try {
      const n = await this.#notifier.notify({
        kind: "approval",
        title: cardHeader(a),
        // Header only: the card holds the details (design-12). Tokens never go through the inbox.
        body: "Approval pending",
        approvalId: a.id,
        ...(a.requestedBy.taskId == null ? {} : { taskId: a.requestedBy.taskId }),
        surfaces: a.surfaces,
        dedupeKey: `approval:${a.id}`,
        route:
          a.requestedBy.threadId == null
            ? "/agent/approvals"
            : chatLinkRoute({ threadId: a.requestedBy.threadId, approvalId: a.id }),
      });
      this.#notifications.set(a.id, n.id);
    } catch {
      // Delivery failure leaves the request pending in the approvals queue.
    }
  }

  async #canResumeCard(a: ApprovalRequest): Promise<boolean> {
    if (this.#canResume === undefined) return false;
    try {
      return (await this.#canResume(a)) === true;
    } catch {
      return false;
    }
  }

  async #isDeferred(a: ApprovalRequest): Promise<boolean> {
    if (this.#deferredApproval === undefined) return false;
    try {
      return (await this.#deferredApproval(a)) === true;
    } catch {
      // Unknown means a card of its own: an owner is never left without a notice.
      return false;
    }
  }

  #armExpiry(a: ApprovalRequest): void {
    const at = Date.parse(a.expiresAt);
    const c = this.clock as Clock & { setTimer?: (at: number, fn: () => void) => () => void };
    if (typeof c.setTimer === "function") {
      this.#timers.set(
        a.id,
        c.setTimer.call(this.clock, at, () => this.#sweep()),
      );
      return;
    }
    const t = setTimeout(() => this.#sweep(), Math.max(0, at - this.clock.now()));
    t.unref?.();
    this.#timers.set(a.id, () => clearTimeout(t));
  }

  /**
   * Seconds until the identity may answer again, or 0. Only guessing-shaped rejections count
   * (`#reject`); real decisions never do, however many the owner makes in a minute.
   */
  #retryAfterSec(identity: string, local: boolean): number {
    // A vouched local call is not held back by guesses made under the same device id.
    if (local) return 0;
    const limit = this.#policy.config.approvals?.answersPerMinute ?? 10;
    return this.#windowWait(this.#failureTimes, identity, limit * FAILURE_CAP_FACTOR);
  }

  /**
   * A call the Gateway vouched for as the owner's own Host app or helper (`local`: the desktop
   * shell or Host helper on a loopback connection with the per-launch secret). Its refused answers
   * are audited but never lock it out. Marked on the call's own `decidedBy` object, so it holds
   * for this call only and a device id alone (another connection reusing a key) never earns it.
   */
  #markLocal(by: object, local: boolean | undefined): void {
    if (local === true) this.#localBy.add(by);
    else this.#localBy.delete(by);
  }

  #isLocal(by: DecidedBy): boolean {
    return this.#localBy.has(by);
  }

  #windowWait(map: Map<string, number[]>, identity: string, limit: number): number {
    const now = this.clock.now();
    const times = (map.get(identity) ?? []).filter((t) => t > now - 60_000);
    map.set(identity, times);
    if (times.length < limit) return 0;
    const oldest = times[times.length - limit] ?? now;
    return Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
  }

  async #reject(
    rec: StoredApproval | undefined,
    id: string,
    by: DecidedBy,
    reason: string,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ): Promise<never> {
    if (GUESSING_REASONS.has(reason) && !this.#isLocal(by)) {
      const identity =
        "deviceId" in by ? `device:${by.deviceId}` : `channel:${by.channel}:${by.senderId}`;
      const failures = this.#failureTimes.get(identity) ?? [];
      failures.push(this.clock.now());
      this.#failureTimes.set(identity, failures);
    }
    await this.#log(
      "approval.answer_rejected",
      actorOf(by),
      {
        approvalId: id,
        ...(rec?.approval.requestedBy.taskId == null
          ? {}
          : { taskId: rec.approval.requestedBy.taskId }),
      },
      { reason, status: rec?.approval.status ?? "unknown" },
    );
    return fail(code, message, details);
  }

  /**
   * Checks an answer before a host asks the owner for presence out of band (the desktop window's
   * Touch ID through the helper, security §3.7): the answerer is not rate limited, the approval is
   * pending and armed, and the token is an unused one for `decidedBy.surface`. Throws what
   * `answer` would (a refusal that looks like guessing counts against the rejected-answer cap, the
   * rest are only audited); records nothing else.
   */
  async precheckAnswer(input: {
    approvalId: string;
    answerToken: string;
    decidedBy: { deviceId: string; surface: Surface };
    /** The Gateway vouches this is the owner's own Host app or helper. */
    local?: boolean;
  }): Promise<ApprovalRequest> {
    this.#sweep();
    const by = input.decidedBy;
    this.#markLocal(by, input.local);
    const id = input.approvalId;
    const retryAfterSec = this.#retryAfterSec(`device:${by.deviceId}`, this.#isLocal(by));
    if (retryAfterSec > 0)
      return this.#reject(
        undefined,
        id,
        by,
        "rate_limited",
        "rate_limited",
        `Too many tries in a minute. Try again in ${retryAfterSec} s`,
        { retryAfterSec },
      );
    const rec = this.#store.getApproval(id);
    if (rec === undefined)
      return this.#reject(undefined, id, by, "not_found", "not_found", `approval ${id} not found`);
    const a = rec.approval;
    if (a.status !== "pending" || rec.bootId !== this.#bootId)
      return this.#reject(rec, id, by, "late", "answer_late", `approval already ${a.status}`);
    const token = rec.tokens.find((t) => t.hash === sha256(input.answerToken));
    if (token === undefined || token.surface !== by.surface)
      return this.#reject(rec, id, by, "unknown_token", "forbidden", "unknown answer token");
    if (token.usedAt !== null)
      return this.#reject(rec, id, by, "replayed", "answer_replayed", "answer token already used");
    if (this.clock.now() < Date.parse(a.requestedAt) + this.#armDelayMs)
      return this.#reject(
        rec,
        id,
        by,
        "not_armed",
        "approval_not_armed",
        "approval card is not armed yet",
      );
    return structuredClone(a);
  }

  /**
   * An out-of-band presence step failed (Touch ID cancelled, failed or unavailable): audited as a
   * rejected answer. A failed or invalid presence counts against the answerer's cap like a bad
   * assertion would; a cancelled sheet or a missing helper or key does not.
   */
  async rejectPresence(input: {
    approvalId: string;
    decidedBy: { deviceId: string; surface: Surface };
    /** The Gateway vouches this is the owner's own Host app or helper. */
    local?: boolean;
    reason: string;
    code: ErrorCode;
    message: string;
    details?: unknown;
  }): Promise<never> {
    this.#markLocal(input.decidedBy, input.local);
    const rec = this.#store.getApproval(input.approvalId);
    return this.#reject(
      rec,
      input.approvalId,
      input.decidedBy,
      input.reason,
      input.code,
      input.message,
      input.details,
    );
  }

  /**
   * `trusted` is what the Gateway itself vouches for about the connection: it is a separate
   * argument, never a field of `input`, because `input` is built from a client's params (or a chat
   * message) and a client must not be able to claim it.
   */
  async answer(
    input: PolicyAnswerInput,
    trusted: { local?: boolean } = {},
  ): Promise<ApprovalRequest> {
    this.#sweep();
    const by = input.decidedBy;
    this.#markLocal(by, trusted.local);
    const identity =
      "deviceId" in by ? `device:${by.deviceId}` : `channel:${by.channel}:${by.senderId}`;
    const id = input.approvalId;
    const retryAfterSec = this.#retryAfterSec(identity, this.#isLocal(by));
    if (retryAfterSec > 0)
      return this.#reject(
        undefined,
        id,
        by,
        "rate_limited",
        "rate_limited",
        `Too many tries in a minute. Try again in ${retryAfterSec} s`,
        { retryAfterSec },
      );
    const rec = this.#store.getApproval(id);
    if (rec === undefined)
      return this.#reject(undefined, id, by, "not_found", "not_found", `approval ${id} not found`);
    const a = rec.approval;
    if (a.status === "pending" && rec.bootId !== this.#bootId) {
      // Issued by an earlier Gateway boot and not yet re-issued (review #14).
      return this.#reject(
        rec,
        id,
        by,
        "invalidated",
        "approval_invalidated",
        "approval invalidated (re-issued)",
        {
          reason: "re-issued",
        },
      );
    }
    if (a.status === "expired")
      return this.#reject(rec, id, by, "late", "approval_expired", "approval expired", {
        late: true,
      });
    if (a.status === "invalidated") {
      const r =
        a.invalidatedReason === "gateway_restart"
          ? "re-issued"
          : (a.invalidatedReason ?? "invalidated");
      return this.#reject(
        rec,
        id,
        by,
        "invalidated",
        "approval_invalidated",
        `approval invalidated (${r})`,
        { reason: r },
      );
    }
    const tokenHash = sha256(input.answerToken);
    const token = rec.tokens.find((t) => t.hash === tokenHash);
    if (token === undefined)
      return this.#reject(rec, id, by, "unknown_token", "forbidden", "unknown answer token");
    if (token.usedAt !== null)
      return this.#reject(rec, id, by, "replayed", "answer_replayed", "answer token already used");
    if (a.status !== "pending")
      return this.#reject(rec, id, by, "late", "answer_late", `approval already ${a.status}`);
    if (this.clock.now() < Date.parse(a.requestedAt) + this.#armDelayMs) {
      return this.#reject(
        rec,
        id,
        by,
        "not_armed",
        "approval_not_armed",
        "approval card is not armed yet",
      );
    }

    // The answerer must match the token's surface and be an approver (security §3.7, design-20).
    const chat = isChat(token.surface);
    if (chat) {
      if (!("channel" in by) || token.surface.split(":")[0] !== by.channel) {
        return this.#reject(
          rec,
          id,
          by,
          "surface_mismatch",
          "forbidden",
          "a chat token is answered from that chat",
        );
      }
      if (a.deviceOnly)
        return this.#reject(
          rec,
          id,
          by,
          "device_only",
          "forbidden",
          "device-only approvals cannot be answered from chat",
        );
      if (!(await this.#approvers.isOwnerSender(by.channel, by.senderId))) {
        return this.#reject(
          rec,
          id,
          by,
          "not_owner",
          "forbidden",
          "only the owner's identity answers approvals",
        );
      }
    } else {
      if (!("deviceId" in by))
        return this.#reject(
          rec,
          id,
          by,
          "surface_mismatch",
          "forbidden",
          "a device token is answered by a device",
        );
      if (by.surface !== undefined && by.surface !== token.surface) {
        return this.#reject(
          rec,
          id,
          by,
          "surface_mismatch",
          "forbidden",
          "the answer came from another surface",
        );
      }
      const device = await this.#approvers.device(by.deviceId);
      if (
        device === undefined ||
        device.revoked === true ||
        device.role === "node" ||
        !device.scopes.includes("operator.approvals")
      ) {
        return this.#reject(
          rec,
          id,
          by,
          "not_approver",
          "forbidden",
          "the device lacks operator.approvals",
        );
      }
    }

    const scope: GrantScope = input.scope ?? "once";
    if (input.decision === "approve") {
      if (!a.scopesOffered.includes(scope))
        return this.#reject(
          rec,
          id,
          by,
          "scope_not_offered",
          "invalid_params",
          `scope ${scope} not offered`,
        );
      const chatScopes = this.#policy.config.approvals?.chatScopes ?? ["once"];
      if (chat && !chatScopes.includes(scope)) {
        return this.#reject(
          rec,
          id,
          by,
          "chat_scope",
          "invalid_params",
          `chat answers ${chatScopes.join(" / ")} only`,
        );
      }
      // "Approve all routine ones" is checked here, not in a client filter: a bulk answer lands
      // only on a card the broker itself classed routine (no payment, no device-only card).
      if (
        input.bulk === true &&
        (a.riskClass !== "routine" || a.requiresAuthentication || a.deviceOnly || scope !== "once")
      ) {
        return this.#reject(
          rec,
          id,
          by,
          "bulk_not_routine",
          "invalid_params",
          "this action needs its own approval",
          { reason: "not_routine" },
        );
      }
      // A set-aside card has nobody waiting on it: approving it is only honest when a resume run
      // can start that may do it (the Gateway's DeferredResume). Without one, refuse.
      if (a.setAside === true && !(await this.#canResumeCard(a))) {
        return this.#reject(
          rec,
          id,
          by,
          "not_resumable",
          "unavailable",
          "this automation can't run again, so approving would do nothing",
          { reason: "not_resumable" },
        );
      }
      const word = rec.input.typedConfirmation;
      if (word !== undefined && input.typedConfirmation !== word) {
        return this.#reject(
          rec,
          id,
          by,
          "confirmation_missing",
          "invalid_params",
          `type ${word} to confirm`,
        );
      }
      const needsPresence =
        this.#presenceFor === "device_only"
          ? a.deviceOnly || a.requiresAuthentication
          : a.requiresAuthentication;
      if (this.#presence !== undefined && needsPresence) {
        if (
          input.presence === undefined ||
          !("deviceId" in by) ||
          input.presence.deviceId !== by.deviceId
        ) {
          return this.#reject(
            rec,
            id,
            by,
            "presence_required",
            "forbidden",
            "a presence assertion is required",
            { reason: "presence_required" },
          );
        }
        const ok = await this.#presence.verify(
          input.presence,
          presenceChallenge(a.id, a.bindingHash, input.answerToken, scope),
          by.deviceId,
        );
        if (!ok)
          return this.#reject(
            rec,
            id,
            by,
            "presence_invalid",
            "forbidden",
            "presence assertion invalid",
            { reason: "presence_invalid" },
          );
      }
    }

    // "Always for this site": only a device answers it, only on a card that offered it, and the
    // origin is the one the Gateway computed from the call (security §3.2).
    let trustChoice: "origin" | "subdomains" | undefined;
    if (input.trustSite !== undefined && input.decision === "approve") {
      const offer = (a.details as { trustSite?: { origin?: unknown; subdomains?: unknown } })
        .trustSite;
      if (
        chat ||
        scope !== "once" ||
        offer === undefined ||
        typeof offer.origin !== "string" ||
        (input.trustSite === "subdomains" && offer.subdomains !== true)
      ) {
        return this.#reject(
          rec,
          id,
          by,
          "trust_not_offered",
          "invalid_params",
          "this card does not offer to trust the site",
        );
      }
      trustChoice = input.trustSite;
    }

    // "Always allow <program> in <folder>": a device answers it, on a card that offered it, with
    // scope `once`; the program and folder are the Gateway's own, from the card (security §5.4).
    let programChoice = false;
    if (input.hostProgram === true && input.decision === "approve") {
      const offer = (a.details as { hostProgram?: { executable?: unknown } }).hostProgram;
      if (
        chat ||
        scope !== "once" ||
        a.taint ||
        a.kind !== "exec_host" ||
        input.unsandboxed !== undefined ||
        offer === undefined ||
        typeof offer.executable !== "string"
      ) {
        return this.#reject(
          rec,
          id,
          by,
          "program_not_offered",
          "invalid_params",
          "this card does not offer to allow the program",
        );
      }
      programChoice = true;
    }

    // Security §5.4: `UNSANDBOXED` typed on an exec_host card runs that one command without srt.
    if (input.unsandboxed !== undefined) {
      if (input.decision !== "approve" || a.kind !== "exec_host" || scope !== "once") {
        return this.#reject(
          rec,
          id,
          by,
          "unsandboxed_not_offered",
          "invalid_params",
          "UNSANDBOXED applies to approving one exec_host command once",
        );
      }
    }

    // The folder the owner picked is what is granted, never the agent's string (security §3.5).
    let folderPick: FolderGrantEntry | undefined;
    if (
      input.decision === "approve" &&
      (a.kind === "folder_access" || a.kind === "separate_desktop_share")
    ) {
      if (this.#folderAccess === undefined || input.folderPath === undefined) {
        return this.#reject(
          rec,
          id,
          by,
          "folder_missing",
          "invalid_params",
          "pick the folder to share",
        );
      }
      if (a.kind === "folder_access" && scope === "once" && a.requestedBy.threadId == null) {
        return this.#reject(
          rec,
          id,
          by,
          "folder_no_thread",
          "invalid_params",
          "this request has no conversation",
        );
      }
      try {
        folderPick = {
          path: await resolveFolderPick(
            input.folderPath,
            a.kind === "separate_desktop_share" &&
              this.#folderAccess.separateDesktopEnv !== undefined
              ? this.#folderAccess.separateDesktopEnv()
              : this.#folderAccess.env(),
          ),
          // The owner may narrow the request to read-only; nothing widens it.
          mode: a.details.access === "rw" && input.folderMode !== "ro" ? "rw" : "ro",
        };
      } catch (err) {
        await this.#log(
          "approval.answer_rejected",
          actorOf(by),
          { approvalId: id },
          {
            reason: "folder_refused",
            status: a.status,
          },
        );
        throw err;
      }
    }

    // The `messages_send` compose card: the recipient the owner chose and the text they left in
    // the editor are what the approval binds, never the agent's draft (security §3.5).
    let composeFinal: ComposeFinal | undefined;
    const compose = a.kind === "message_send" ? readCompose(a.details) : undefined;
    if (input.decision === "approve" && compose !== undefined) {
      composeFinal = resolveCompose(compose, input);
      if (composeFinal === undefined) {
        return this.#reject(
          rec,
          id,
          by,
          "compose_invalid",
          "invalid_params",
          "choose one recipient on the card and keep some text to send",
        );
      }
      if (scope !== "once") {
        return this.#reject(rec, id, by, "compose_scope", "invalid_params", "sends are once only");
      }
    }

    // First authorized answer wins: re-read, check, mark the token and decide atomically.
    // Re-read the clock after the awaited approver and presence checks (review #14).
    const now = this.clock.now();
    let grant: StoredGrant | undefined;
    const decided = this.#store.transaction(() => {
      const fresh = this.#store.getApproval(id);
      if (fresh === undefined) return undefined;
      if (fresh.approval.status === "expired" || now >= Date.parse(fresh.approval.expiresAt)) {
        return "expired" as const;
      }
      if (fresh.approval.status !== "pending") return undefined;
      const t = fresh.tokens.find((x) => x.hash === tokenHash);
      if (t === undefined || t.usedAt !== null) return undefined;
      t.usedAt = new Date(now).toISOString();
      const fa = fresh.approval;
      fa.decidedBy = structuredClone(by);
      fa.decidedAt = new Date(now).toISOString();
      if (input.decision === "deny") fa.status = "denied";
      else {
        fa.status = "approved";
        fa.scopeGranted = scope;
        // A batch becomes one approved, once-only approval per listed call (§8.1).
        if (fa.kind === "batch") this.#mintBatchChildren(fresh, by, now);
        if (fa.kind === "exec_host" && input.unsandboxed !== undefined) {
          fa.details = { ...fa.details, unsandboxed: true };
        }
        if (fa.kind === "message_send" && composeFinal !== undefined && compose !== undefined) {
          fa.details = { ...fa.details, final: { ...composeFinal } };
          fa.bindingHash = composeBindingHash(
            compose.account,
            composeFinal.recipient,
            composeFinal.text,
          );
        }
        if (
          (fa.kind === "folder_access" || fa.kind === "separate_desktop_share") &&
          folderPick !== undefined
        ) {
          // Not a ledger grant: `always` lives in Settings → File access, `once` in the thread.
          // A separate-desktop share only records the pick here; `#applyFolder` is skipped for it.
          fa.details = { ...fa.details, granted: { ...folderPick } };
        } else if (fa.kind === "batch" && scope === "always") {
          // The one batch grant: prep notes only. It binds the calls' own key, not the batch's.
          grant = this.#newPrepNoteGrant(fresh, by, now);
          if (grant === undefined) fa.scopeGranted = "once";
          else {
            this.#store.insertGrant(grant);
            fa.grantId = grant.grant.id;
          }
        } else if (scope !== "once") {
          grant = this.#newGrant(fresh, scope, by, now);
          this.#store.insertGrant(grant);
          fa.grantId = grant.grant.id;
        } else if (programChoice) {
          const o = (fa.details as { hostProgram?: Record<string, unknown> }).hostProgram;
          if (
            o !== undefined &&
            typeof o.executable === "string" &&
            typeof o.sha256 === "string" &&
            typeof o.folder === "string"
          ) {
            grant = this.#newHostProgramGrant(
              fresh,
              {
                executable: o.executable,
                sha256: o.sha256,
                folder: o.folder,
                argv: Array.isArray(o.argv) ? (o.argv as string[]) : null,
              },
              by,
              now,
            );
            this.#store.insertGrant(grant);
            fa.grantId = grant.grant.id;
          }
        } else if (trustChoice !== undefined) {
          const offered = (fa.details as { trustSite?: { origin?: string } }).trustSite;
          if (offered?.origin !== undefined) {
            grant = this.#newTrustedSiteGrant(
              fresh,
              { origin: offered.origin },
              trustChoice === "subdomains",
              by,
              now,
            );
            this.#store.insertGrant(grant);
            fa.grantId = grant.grant.id;
          }
        }
      }
      this.#store.updateApproval(fresh);
      return fresh;
    });
    if (decided === "expired") {
      this.#sweep();
      return this.#reject(rec, id, by, "late", "approval_expired", "approval expired", {
        late: true,
      });
    }
    if (decided === undefined)
      return this.#reject(rec, id, by, "late", "answer_late", "approval was answered concurrently");
    this.#timers.get(id)?.();
    this.#timers.delete(id);
    const fa = decided.approval;
    const { call, context } = decided.input;
    if (fa.status === "approved" && call !== undefined && context !== undefined) {
      const tk = targetKey(call);
      if (tk !== undefined) {
        const st = this.#task(context);
        st.approvedTargets.add(tk);
        st.touched.add(tk);
      }
    }
    // Announced as soon as the answer is stored, before any await: a grant it made is usable
    // from the commit on, so no use of it can come before its card's decision. No subscriber
    // reads the audit rows written below; waiters (`awaitDecision`) and the notice resolve at
    // the end, once the folder pick is applied.
    this.#emit({ type: "approval.decided", approval: fa });
    if (fa.status === "approved" && folderPick !== undefined && fa.kind === "folder_access") {
      await this.#applyFolder(fa, folderPick, scope, by);
    }
    if (
      fa.status === "approved" &&
      folderPick !== undefined &&
      fa.kind === "separate_desktop_share"
    ) {
      // Not a host grant (nothing is applied or persisted); the audit trail records the decision.
      await this.#log(
        "separate_desktop.share_granted",
        actorOf(by),
        {
          approvalId: fa.id,
          ...(fa.requestedBy.taskId == null ? {} : { taskId: fa.requestedBy.taskId }),
        },
        { path: folderPick.path, mode: folderPick.mode, taint: fa.taint },
      );
    }
    await this.#log(
      "approval.decided",
      { ...actorOf(by, token.surface), ...(chat ? {} : { scope: "operator.approvals" }) },
      {
        approvalId: fa.id,
        ...(fa.requestedBy.taskId == null ? {} : { taskId: fa.requestedBy.taskId }),
        ...(fa.requestedBy.toolCallId === undefined
          ? {}
          : { toolCallId: fa.requestedBy.toolCallId }),
      },
      {
        decision: input.decision === "approve" ? "allow" : "deny",
        grantScope: fa.scopeGranted,
        bindingHash: fa.bindingHash,
        taint: fa.taint,
        latencyMs: now - Date.parse(fa.requestedAt),
        // Answered by a spoken phrase after a readback (voice conversation, §4.6).
        ...(input.via === "voice" ? { via: "voice" } : {}),
      },
    );
    const g = grant as StoredGrant | undefined;
    if (g !== undefined) {
      this.#emit({ type: "grant.created", grant: g.grant });
      await this.#log(
        "grant.created",
        actorOf(by),
        { grantId: g.grant.id, approvalId: fa.id },
        {
          kind: g.grant.kind,
          scope: g.grant.scope,
          grantKey: g.grant.grantKey,
          expiresAt: g.grant.expiresAt,
        },
      );
    }
    this.#settled(fa, "approval.decided", { emitted: true });
    return structuredClone(fa);
  }

  /** Makes an approved pick usable now: this conversation's roots, or Settings for `always`. */
  async #applyFolder(
    fa: ApprovalRequest,
    pick: FolderGrantEntry,
    scope: GrantScope,
    by: DecidedBy,
  ): Promise<void> {
    const threadId = fa.requestedBy.threadId;
    let kept: GrantScope = scope;
    if (scope === "always") {
      try {
        await this.#folderAccess?.persist(pick);
      } catch {
        // Not stored: the folder still works for this conversation, and the record says so.
        kept = "once";
        await this.#log("folder.persist_failed", actorOf(by), { approvalId: fa.id }, { ...pick });
      }
    }
    this.#pickedRoot(pick.path);
    if (kept === "once" && threadId != null) {
      const roots = this.#sessionFolders.get(threadId) ?? [];
      this.#sessionFolders.set(threadId, [...roots.filter((r) => r.path !== pick.path), pick]);
    }
    await this.#log(
      "folder.granted",
      actorOf(by),
      { approvalId: fa.id, ...(threadId == null ? {} : { threadId }) },
      { path: pick.path, mode: pick.mode, scope: kept, taint: fa.taint },
    );
  }

  /** Revokes an `always` folder: it stops working on the next call. */
  async revokeFolder(path: string): Promise<boolean> {
    const removed = (await this.#folderAccess?.remove?.(path)) ?? false;
    this.#pruneRoots();
    if (removed)
      await this.#log("folder.revoked", { type: "system" }, {}, { path, scope: "always" });
    return removed;
  }

  /** Every conversation's folders (`once`), for the access list in Settings. */
  allSessionFolders(): { threadId: string; entry: FolderGrantEntry }[] {
    return [...this.#sessionFolders.keys()].flatMap((threadId) =>
      this.sessionFolders(threadId).map((entry) => ({ threadId, entry })),
    );
  }

  /** Ends one conversation's folder (a revoke from Settings); true when it was granted. */
  async revokeSessionFolder(threadId: string, path: string): Promise<boolean> {
    const roots = this.#sessionFolders.get(threadId) ?? [];
    const kept = roots.filter((r) => r.path !== path);
    if (kept.length === roots.length) return false;
    this.#fileGrantExpiry.delete(`${threadId}\0${path}`);
    this.#attachRecords.delete(`${threadId}\0${path}`);
    if (kept.length === 0) this.#sessionFolders.delete(threadId);
    else this.#sessionFolders.set(threadId, kept);
    this.#pruneRoots();
    await this.#log("folder.revoked", { type: "system" }, { threadId }, { path, scope: "once" });
    return true;
  }

  /** Folders allowed for one conversation (`once`), for the file executors behind the broker. */
  sessionFolders(threadId: string): readonly FolderGrantEntry[] {
    this.#expireFileGrants(threadId);
    return effectiveEntries(this.#sessionFolders.get(threadId) ?? []).filter(
      (e) =>
        e.file !== true ||
        !(this.policy.folders ?? []).some((f) => isUnderHostPath(e.path, f.path)),
    );
  }

  /**
   * The files the owner attached to this conversation whose 24 hours are not over and that some
   * live grant still reads (a covering folder or the file's own entry). A record says "this file was picked here", never "may be read".
   */
  attachedFiles(threadId: string): readonly { path: string }[] {
    const now = this.clock.now();
    const out: { path: string }[] = [];
    for (const [key, until] of this.#attachRecords) {
      if (!key.startsWith(`${threadId}\0`)) continue;
      if (until <= now) this.#attachRecords.delete(key);
      else out.push({ path: key.slice(threadId.length + 1) });
    }
    // Only files something still lets the agent read (a folder that covers them, or the file's
    // own entry): a revoked folder must not leave a message promising a file the agent cannot read.
    const live = [...(this.policy.folders ?? []), ...this.sessionFolders(threadId)];
    return out.filter((f) => folderCovers(live, f.path, "ro") !== undefined);
  }

  /** Drops this conversation's attached-file grants whose 24 hours are over. */
  #expireFileGrants(threadId: string): void {
    const roots = this.#sessionFolders.get(threadId);
    if (roots === undefined) return;
    const now = this.clock.now();
    const kept = roots.filter((r) => {
      const until = this.#fileGrantExpiry.get(`${threadId}\0${r.path}`);
      if (until === undefined || until > now) return true;
      this.#fileGrantExpiry.delete(`${threadId}\0${r.path}`);
      return false;
    });
    if (kept.length === roots.length) return;
    if (kept.length === 0) this.#sessionFolders.delete(threadId);
    else this.#sessionFolders.set(threadId, kept);
    this.#pruneRoots();
  }

  /**
   * Chat attachments picked natively (chat.attachFiles): the owner's own pick of exactly these
   * FILES is the approval. Each is resolved to its real path and refused under a sensitive root
   * (`resolveFilePick`); a file already covered by a granted folder is left alone (a read-only
   * file entry would narrow a read-write folder, since the longest root decides). The grant is
   * read-only, covers only that file path, and ends with the conversation (`endSession`) or after
   * `ATTACH_GRANT_MS`. Without folder-access settings nothing is granted.
   */
  async attachFiles(
    threadId: string,
    paths: readonly string[],
    by: { deviceId: string },
  ): Promise<{
    files: { path: string; size: number }[];
    refused: { path: string; reason: string }[];
  }> {
    if (this.#folderAccess === undefined) fail("unavailable", "attaching files is not set up");
    const env = this.#folderAccess.env();
    const files: { path: string; size: number }[] = [];
    const refused: { path: string; reason: string }[] = [];
    for (const raw of paths) {
      try {
        const file = await resolveFilePick(raw, env);
        const covered = folderCovers(
          [
            ...(this.policy.folders ?? []),
            ...this.sessionFolders(threadId).filter((e) => e.file !== true),
          ],
          file.path,
          "ro",
        );
        const recordKey = `${threadId}\0${file.path}`;
        // A re-attach refreshes the record and the file grant together, so they stay equal.
        this.#attachRecords.set(recordKey, this.clock.now() + ATTACH_GRANT_MS);
        if (covered === undefined) {
          this.#pickedRoot(file.path);
          const roots = this.#sessionFolders.get(threadId) ?? [];
          this.#sessionFolders.set(threadId, [
            ...roots.filter((r) => r.path !== file.path),
            { path: file.path, mode: "ro", file: true },
          ]);
          this.#fileGrantExpiry.set(
            `${threadId}\0${file.path}`,
            this.clock.now() + ATTACH_GRANT_MS,
          );
          await this.#log(
            "folder.granted",
            actorOf(by),
            { threadId },
            { path: file.path, mode: "ro", scope: "once", attachment: true },
          );
        }
        files.push(file);
      } catch (err) {
        if (!(err instanceof PsycheError)) throw err;
        refused.push({ path: raw, reason: err.code });
      }
    }
    return { files, refused };
  }

  /**
   * The `always` grant of an approved prep-note batch (security §3.4, §3.5): the calls' own
   * grant key (`notes_create` with a `Prep:` title), `createdFrom` the batch approval, 90 days.
   * Undefined unless every call is a Prep-titled `notes_create` under one key.
   */
  #newPrepNoteGrant(rec: StoredApproval, by: DecidedBy, now: number): StoredGrant | undefined {
    const a = rec.approval;
    const children = rec.input.batch?.children ?? [];
    const first = children[0];
    if (first === undefined) return undefined;
    if (!children.every((c) => this.#isPrepChild(c) && c.grantKey === first.grantKey)) {
      return undefined;
    }
    const target = first.call.target;
    return {
      grant: {
        id: this.#newId("grt"),
        kind: first.kind,
        scope: "always",
        grantKey: first.grantKey,
        subject: {
          grantKey: first.grantKey,
          tool: first.call.tool,
          titlePrefix: PREP_NOTE_TITLE_PREFIX,
          ...(target === undefined ? {} : { target }),
          sideEffect: "write",
        },
        binding: { bindingHash: first.bindingHash },
        expiresAt: new Date(now + this.#ttl().always).toISOString(),
        useCount: 0,
        lastUsedAt: null,
        createdFromApprovalId: a.id,
        taskId: null,
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      },
      meta: {
        sideEffect: "write",
        sessionId: null,
        threadId: null,
        origin: null,
        createdByDeviceId: "deviceId" in by ? by.deviceId : null,
        maxUses: null,
        lastUsedBindingHash: null,
        revokedReason: null,
        requesterId: requesterKey(rec.input.context?.requester),
      },
    };
  }

  #newGrant(
    rec: StoredApproval,
    scope: Exclude<GrantScope, "once">,
    by: DecidedBy,
    now: number,
  ): StoredGrant {
    const a = rec.approval;
    const ttl = this.#ttl();
    const se = a.sideEffect ?? rec.input.sideEffect;
    const life =
      scope === "task"
        ? se === "destructive"
          ? Math.min(ttl.destructiveTask, ttl.task)
          : ttl.task
        : scope === "site"
          ? ttl.site
          : scope === "session"
            ? Math.min(ttl.sessionIdle, ttl.sessionMax)
            : a.kind === "exec_host"
              ? ttl.execHostAlways
              : ttl.always;
    const grantFields = (rec.input as GrantFields).grantFields;
    const origin = a.target?.kind === "origin" ? (safeOrigin(a.target.value) ?? null) : null;
    return {
      grant: {
        id: this.#newId("grt"),
        kind: a.kind,
        scope,
        grantKey: a.grantKey,
        subject: {
          grantKey: a.grantKey,
          ...(grantFields ?? {}),
          ...(a.target === undefined ? {} : { target: a.target }),
          sideEffect: se,
        },
        binding: { bindingHash: a.bindingHash },
        expiresAt: new Date(now + life).toISOString(),
        useCount: 0,
        lastUsedAt: null,
        createdFromApprovalId: a.id,
        taskId: scope === "task" ? (a.requestedBy.taskId ?? null) : null,
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      },
      meta: {
        sideEffect: se,
        sessionId: scope === "session" ? this.#bootId : null,
        threadId: scope === "session" ? (a.requestedBy.threadId ?? null) : null,
        origin: scope === "site" ? origin : null,
        createdByDeviceId: "deviceId" in by ? by.deviceId : null,
        maxUses: null,
        lastUsedBindingHash: null,
        revokedReason: null,
        requesterId: requesterKey(rec.input.context?.requester),
      },
    };
  }

  #settled(
    a: ApprovalRequest,
    type: "approval.decided" | "approval.expired" | "approval.invalidated",
    opts: { emitted?: boolean } = {},
  ): void {
    if (opts.emitted !== true) this.#emit({ type, approval: a });
    const nid = this.#notifications.get(a.id);
    if (nid !== undefined) {
      this.#notifications.delete(a.id);
      this.#notifier?.resolve(nid).catch(() => undefined);
    }
    const set = this.#waiters.get(a.id);
    if (set === undefined) return;
    this.#waiters.delete(a.id);
    for (const w of set) w(structuredClone(a));
  }

  awaitDecision(approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
    this.#sweep();
    const rec = this.#store.getApproval(approvalId);
    if (rec === undefined)
      return Promise.reject(new PsycheError("not_found", "approval not found"));
    if (rec.approval.status !== "pending") return Promise.resolve(rec.approval);
    return new Promise((resolve, reject) => {
      const set = this.#waiters.get(approvalId) ?? new Set();
      const onAbort = () => {
        set.delete(waiter);
        reject(new PsycheError("cancelled", "awaitDecision aborted"));
      };
      const waiter = (a: ApprovalRequest) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(a);
      };
      if (signal?.aborted === true) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      set.add(waiter);
      this.#waiters.set(approvalId, set);
    });
  }

  /**
   * The resume of a set-aside card is over: it did the action, or the owner was told it did not.
   * A restart then has nothing to report for it (`onSetAsideRevoked`).
   */
  settleSetAside(approvalId: string): void {
    this.#store.transaction(() => {
      const rec = this.#store.getApproval(approvalId);
      if (rec === undefined || rec.approval.setAside !== true || rec.revoked) return;
      // The resume is over: the card's own authority ends (a standing grant it made stays).
      rec.revoked = true;
      this.#store.updateApproval(rec);
    });
  }

  /**
   * Nothing has done this approval's action: no `ok` receipt names it (a failed one is not done)
   * and its grant (if any) has no use.
   */
  async #unused(a: ApprovalRequest, pool: readonly Receipt[]): Promise<boolean> {
    const receipts = await this.receipts.list({ approvalId: a.id });
    if (receipts.some((r) => r.outcome === "ok")) return false;
    // A use of its grant is done only when that very call succeeded too.
    return !this.#grantReceipts(a, pool).some((r) => r.outcome === "ok");
  }

  /**
   * Receipts that may say what the set-aside cards' grants did: one query per boot, from the
   * earliest of their grants on (a card's grant is made by its own approval, so nothing older).
   */
  async #grantReceiptPool(recs: readonly StoredApproval[]): Promise<Receipt[]> {
    let since: string | undefined;
    for (const rec of recs) {
      const a = rec.approval;
      if (rec.revoked || a.setAside !== true || a.grantId == null) continue;
      const created = this.#store.getGrant(a.grantId)?.grant.createdAt;
      if (created !== undefined && (since === undefined || created < since)) since = created;
    }
    return since === undefined ? [] : await this.receipts.list({ since });
  }

  /**
   * The receipts of calls that went through the standing grant this approval made AND were
   * this card's action: the grant's id and the card's binding on the receipt (a grant covers a
   * key, not one call), from a run of the card's own automation (an attended chat through the
   * same grant is another action). Never matched by kind alone.
   */
  #grantReceipts(a: ApprovalRequest, pool: readonly Receipt[]): Receipt[] {
    if (a.grantId == null) return [];
    const g = this.#store.getGrant(a.grantId);
    if (g === undefined) return [];
    const same = this.#sameAutomation;
    return pool.filter(
      (r) =>
        receiptGrantId(r) === a.grantId &&
        receiptGrantBinding(r) === a.bindingHash &&
        r.createdAt >= g.grant.createdAt &&
        r.taskId != null &&
        same?.(a, r.taskId) === true,
    );
  }

  /** Its grant let this card's own call through (its last use bound to the card's binding). */
  #grantUsed(a: ApprovalRequest): boolean {
    const g = a.grantId == null ? undefined : this.#store.getGrant(a.grantId);
    return g !== undefined && g.grant.useCount > 0 && g.meta.lastUsedBindingHash === a.bindingHash;
  }

  async verifyBinding(approvalId: string, bindingHash: string): Promise<BindingVerification> {
    this.#sweep();
    const now = this.clock.now();
    const result = this.#store.transaction((): BindingVerification => {
      const rec = this.#store.getApproval(approvalId);
      if (rec === undefined) return { ok: false, reason: "not_found" };
      const a = rec.approval;
      if (rec.revoked || a.status === "invalidated") return { ok: false, reason: "revoked" };
      if (a.status === "expired") return { ok: false, reason: "expired" };
      if (a.status !== "approved") return { ok: false, reason: "not_approved" };
      if (a.grantId != null) {
        const g = this.#store.getGrant(a.grantId);
        if (g === undefined || g.grant.revokedAt != null) return { ok: false, reason: "revoked" };
        if (g.grant.expiresAt != null && now >= Date.parse(g.grant.expiresAt))
          return { ok: false, reason: "expired" };
        if (g.meta.maxUses !== null && g.grant.useCount >= g.meta.maxUses)
          return { ok: false, reason: "consumed" };
      }
      // A compose card binds what the owner left on it (`details.final`). Its stored hash must
      // still be that message's: a card whose final text or recipient was lost or changed (a
      // store that dropped the answer) never verifies, so the agent's draft is never sent.
      const compose = a.kind === "message_send" ? readCompose(a.details) : undefined;
      if (compose !== undefined) {
        const final = readFinal(a.details);
        if (
          final === undefined ||
          composeBindingHash(compose.account, final.recipient, final.text) !== a.bindingHash
        )
          return { ok: false, reason: "binding_mismatch" };
      }
      if (bindingHash !== a.bindingHash) return { ok: false, reason: "binding_mismatch" };
      if (a.scopeGranted === "once") {
        if (rec.consumedAt !== null) return { ok: false, reason: "consumed" };
        if (now >= Date.parse(a.expiresAt)) return { ok: false, reason: "expired" };
        rec.consumedAt = new Date(now).toISOString();
        this.#store.updateApproval(rec);
      }
      return { ok: true, approval: structuredClone(a) };
    });
    const rec = this.#store.getApproval(approvalId);
    await this.#log(
      result.ok ? "binding.verified" : "binding.mismatch",
      { type: "system" },
      {
        approvalId,
        ...(rec?.approval.requestedBy.taskId == null
          ? {}
          : { taskId: rec.approval.requestedBy.taskId }),
      },
      result.ok
        ? { bindingHash }
        : {
            reason: result.reason,
            expected: rec?.approval.bindingHash ?? null,
            actual: bindingHash,
          },
    );
    return result;
  }

  async get(approvalId: string): Promise<ApprovalRequest | undefined> {
    this.#sweep();
    return this.#store.getApproval(approvalId)?.approval;
  }

  async list(filter: { status?: ApprovalStatus } = {}): Promise<ApprovalRequest[]> {
    this.#sweep();
    return this.#store.listApprovals(filter).map((r) => r.approval);
  }

  /**
   * Gateway boot (security §3.7 "Restart", design-09, design-28): invalidate every pending request,
   * revoke `session` grants of earlier boots, re-evaluate each parked call with its persisted
   * context (taint included) and issue a fresh request. A re-issued request never auto-allows.
   */
  async reissue(): Promise<IssuedApproval[]> {
    this.#sweep();
    this.#bootId = this.#newId("boot");
    const pending = this.#store.listApprovals({ status: "pending" });
    for (const rec of pending) await this.#invalidate(rec, "gateway_restart");
    // An approved `once` that was never dispatched belonged to a call parked in the previous
    // process; that call is gone, so the approval ends too (S23 design-09). Found by fuzzing.
    const approved = this.#store.listApprovals({ status: "approved" });
    const pool = await this.#grantReceiptPool(approved);
    for (const rec of approved) {
      if (rec.revoked) continue;
      const unconsumedOnce = rec.approval.scopeGranted === "once" && rec.consumedAt === null;
      // A set-aside card whose resume was not over lost it with the old process, whatever its
      // scope: nothing did its action yet (no `ok` receipt, no use of its grant). That includes
      // an action that ran and failed, and one whose receipt the old process never wrote. The
      // owner is told once; the card's own authority ends (its standing grant, if any, stays).
      const lostResume = rec.approval.setAside === true && (await this.#unused(rec.approval, pool));
      if (!unconsumedOnce && !lostResume) {
        // A set-aside card whose action is done (an `ok` receipt): its resume is over. Settled,
        // so it is not a candidate again and the next boot's receipt query starts later.
        if (rec.approval.setAside === true) {
          rec.revoked = true;
          this.#store.updateApproval(rec);
        }
        continue;
      }
      rec.revoked = true;
      this.#store.updateApproval(rec);
      await this.#log(
        "approval.invalidated",
        { type: "system" },
        { approvalId: rec.approval.id },
        { reason: unconsumedOnce ? "gateway_restart_unconsumed" : "gateway_restart_set_aside" },
      );
      if (lostResume) {
        // It ran and did not succeed. Failed: a receipt (its own, or its grant's) says so.
        // Unknown: the provider did not confirm, or its grant was used and no receipt carries
        // the grant's id (the old process died first, or the recorder cannot say).
        const ran = [
          ...(await this.receipts.list({ approvalId: rec.approval.id })),
          ...this.#grantReceipts(rec.approval, pool),
        ];
        const failed = ran.some((r) => r.outcome === "failed");
        const unknown =
          !failed && (ran.some((r) => r.outcome === "uncertain") || this.#grantUsed(rec.approval));
        try {
          this.#onSetAsideRevoked?.(structuredClone(rec.approval), { failed, unknown });
        } catch {
          // A failed notice never stops the restart.
        }
      }
    }
    for (const g of this.#store.listGrants()) {
      if (
        g.grant.scope === "session" &&
        g.grant.revokedAt == null &&
        g.meta.sessionId !== this.#bootId
      ) {
        await this.#revoke(g, "gateway_restart");
      }
    }
    const issued: IssuedApproval[] = [];
    for (const rec of pending) {
      const input = structuredClone(rec.input);
      input.taint = input.taint || rec.approval.taint;
      if (input.call !== undefined && input.context !== undefined) {
        const ctx = { ...input.context, taint: input.context.taint || rec.approval.taint };
        const { decision } = await this.engine.evaluate(input.call, ctx);
        if (decision.decision === "deny") {
          await this.#log(
            "approval.invalidated",
            { type: "system" },
            { approvalId: rec.approval.id },
            { reason: "denied_on_reissue", rule: decision.rule },
          );
          continue;
        }
        // Equal or stricter: only scopes both evaluations allow.
        const prev = rec.approval.scopesOffered;
        input.scopesOffered = (decision.scopesOffered ?? prev).filter((s) => prev.includes(s));
        input.context = ctx;
      } else {
        input.scopesOffered = rec.approval.scopesOffered;
      }
      // A re-issued set-aside card stays set aside: its run still goes on without it.
      const next = this.#issue(input, { setAside: rec.approval.setAside === true });
      await this.#afterIssue(next.approval);
      issued.push(next);
    }
    return issued;
  }

  async #invalidate(rec: StoredApproval, reason: string): Promise<void> {
    const a = rec.approval;
    a.status = "invalidated";
    a.invalidatedReason = reason;
    this.#store.updateApproval(rec);
    this.#timers.get(a.id)?.();
    this.#timers.delete(a.id);
    await this.#log("approval.invalidated", { type: "system" }, { approvalId: a.id }, { reason });
    this.#settled(a, "approval.invalidated");
  }

  #sweep(): void {
    const now = this.clock.now();
    for (const rec of this.#store.listApprovals({ status: "pending" })) {
      const a = rec.approval;
      if (now < Date.parse(a.expiresAt)) continue;
      a.status = "expired";
      this.#store.updateApproval(rec);
      this.#timers.delete(a.id);
      void this.#log(
        "approval.expired",
        { type: "system" },
        { approvalId: a.id },
        { expiresAt: a.expiresAt },
      );
      this.#settled(a, "approval.expired");
    }
  }

  /**
   * A system-decided `message_send` approval (scope `once`, `decidedBy {channel, senderId}`) for
   * one channel send into a conversation the channel's policy lets Psyche answer: a reply to the
   * routed sender who just wrote there, a pairing code to an unknown sender who just wrote, or an
   * approval card into the owner's own direct conversation. Refuses (`forbidden`) otherwise.
   * Never shown as a card; every issue and refusal is audited.
   */
  async authorizeChannelReply(input: ChannelReplyInput): Promise<ApprovalRequest> {
    this.#sweep();
    const { turn } = input;
    const subject = {
      channel: input.channel,
      account: input.account,
      ...(turn === undefined ? {} : { runId: turn.context.runId, threadId: turn.context.threadId }),
    };
    const refuse = async (reason: string, message: string, rule?: string): Promise<never> => {
      await this.#log("approval.channel_reply_refused", { type: "system" }, subject, {
        reason,
        purpose: input.purpose,
        ...(rule === undefined ? {} : { rule }),
        ...(turn === undefined ? {} : { taint: turn.context.taint }),
      });
      return fail("forbidden", message, { reason, ...(rule === undefined ? {} : { rule }) });
    };
    const lookup = this.#channelConversations;
    if (lookup === undefined) {
      return refuse("no_channel_policy", "no channel conversations are known to the broker");
    }
    const conv = await lookup({
      channel: input.channel,
      account: input.account,
      conversation: input.recipient,
    });
    if (conv === undefined) {
      return refuse("unknown_conversation", "nobody wrote in that conversation");
    }
    const now = this.clock.now();
    const age = now - conv.lastInboundAt;
    switch (input.purpose) {
      case "reply":
        if (conv.allows !== "reply") {
          return refuse("sender_not_allowed", "the channel's policy does not answer that sender");
        }
        if (age > CHANNEL_REPLY_WINDOW_MS) {
          return refuse("stale_conversation", "the last message there is too old to answer");
        }
        if (turn !== undefined) {
          // Only the conversation the request came from is not a new target (security §3.6);
          // the agent writing anywhere else goes through `decide` and asks.
          if (turn.requestRecipient !== input.recipient) {
            return turn.context.taint
              ? refuse("taint_new_target", "a tainted turn cannot send to a new conversation")
              : refuse("not_requesting_conversation", "replies go only to the requesting chat");
          }
          const { decision } = await this.engine.evaluate(
            {
              tool: "channel.reply",
              kind: "message_send",
              sideEffect: "destructive",
              targetKind: "recipient",
              target: { kind: "recipient", value: input.recipient },
              params: { channel: input.channel, recipient: input.recipient },
              paramsHash: input.bodySha256,
              binding: {
                channel: input.channel,
                account: input.account,
                recipient: input.recipient,
                bodySha256: input.bodySha256,
              },
            },
            { ...turn.context, newTarget: false },
          );
          // Hard prohibitions, deny rules, plan mode and requester limits refuse; the
          // destructive default `ask` is what this authority answers.
          if (decision.decision === "deny") {
            return refuse("policy_denied", decision.reason ?? "denied by policy", decision.rule);
          }
          if (decision.rule.startsWith("taint:")) {
            return refuse("taint_new_target", decision.reason ?? "tainted", decision.rule);
          }
        }
        break;
      case "pairing_code":
        if (turn !== undefined)
          return refuse("unexpected_turn", "pairing codes are not agent text");
        if (conv.allows !== "pairing_code" || age > CHANNEL_PAIRING_WINDOW_MS) {
          return refuse("not_pairing", "no fresh pairing request in that conversation");
        }
        break;
      case "approval_card":
        if (turn !== undefined)
          return refuse("unexpected_turn", "approval cards are not agent text");
        if (!conv.owner || conv.isGroup) {
          return refuse("not_owner_conversation", "approval cards go only to the owner's own chat");
        }
        break;
      default:
        return refuse("unknown_purpose", "unknown channel send purpose");
    }
    const key = `${input.channel}|${input.account}|${input.recipient}`;
    const times = (this.#replyTimes.get(key) ?? []).filter((t) => t > now - 60_000);
    if (times.length >= CHANNEL_REPLIES_PER_MINUTE) {
      await this.#log("approval.channel_reply_refused", { type: "system" }, subject, {
        reason: "rate_limited",
        purpose: input.purpose,
      });
      return fail("rate_limited", "too many sends to that conversation");
    }
    times.push(now);
    this.#replyTimes.set(key, times);
    const binding = bindingFor("message_send", {
      channel: input.channel,
      account: input.account,
      recipient: input.recipient,
      bodySha256: input.bodySha256,
    });
    if (input.bindingHash !== undefined && input.bindingHash !== binding.bindingHash) {
      return refuse("binding_mismatch", "the binding does not match the send");
    }
    const issued = this.#issue({
      kind: "message_send",
      summary: `Reply on ${input.channel}`,
      details: { channel: input.channel, account: input.account, purpose: input.purpose },
      bindingHash: binding.bindingHash,
      grantKey: binding.grantKey,
      requestedBy: {
        runId: turn?.context.runId ?? null,
        taskId: turn?.context.taskId ?? null,
        threadId: turn?.context.threadId ?? null,
        agent: `channel:${input.channel}`,
      },
      sideEffect: "write",
      surfaces: ["desktop"],
      scopesOffered: ["once"],
      taint: turn?.context.taint === true,
      ttlMs: CHANNEL_REPLY_TTL_MS,
    });
    const id = issued.approval.id;
    const at = new Date(now).toISOString();
    const decided = this.#store.transaction(() => {
      const rec = this.#store.getApproval(id) as StoredApproval;
      rec.approval.status = "approved";
      rec.approval.scopeGranted = "once";
      rec.approval.decidedBy = { channel: input.channel, senderId: conv.senderId };
      rec.approval.decidedAt = at;
      // Nobody answers a system-decided approval: its tokens are spent at birth.
      for (const t of rec.tokens) t.usedAt = at;
      this.#store.updateApproval(rec);
      return rec.approval;
    });
    this.#timers.get(id)?.();
    this.#timers.delete(id);
    await this.#log(
      "approval.channel_reply",
      { type: "channel" },
      { approvalId: id },
      {
        ...subject,
        purpose: input.purpose,
        senderId: conv.senderId,
        bindingHash: binding.bindingHash,
        ...(turn === undefined
          ? {}
          : { taint: turn.context.taint, mode: turn.context.permissionMode }),
        expiresAt: decided.expiresAt,
      },
    );
    return structuredClone(decided);
  }

  /**
   * The owner typed a message in the chat instead of answering: every pending card of the run is
   * denied ("owner replied in chat"), never approved. The audit line records the reason; the
   * notification copies close with the card and a later click finds it already decided.
   * Returns the cards it closed.
   */
  async denyPendingForRun(
    runId: string,
    reason: string = OWNER_REPLIED_IN_CHAT,
  ): Promise<ApprovalRequest[]> {
    this.#sweep();
    const closed: ApprovalRequest[] = [];
    for (const rec of this.#store.listApprovals({ status: "pending" })) {
      const a = rec.approval;
      if (a.requestedBy.runId !== runId) continue;
      a.status = "denied";
      a.decidedAt = new Date(this.clock.now()).toISOString();
      a.invalidatedReason = reason;
      this.#store.updateApproval(rec);
      this.#timers.get(a.id)?.();
      this.#timers.delete(a.id);
      await this.#log(
        "approval.decided",
        { type: "system" },
        {
          approvalId: a.id,
          ...(a.requestedBy.taskId == null ? {} : { taskId: a.requestedBy.taskId }),
          ...(a.requestedBy.toolCallId === undefined
            ? {}
            : { toolCallId: a.requestedBy.toolCallId }),
        },
        {
          decision: "deny",
          reason: "owner replied in chat",
          bindingHash: a.bindingHash,
          taint: a.taint,
        },
      );
      this.#settled(a, "approval.decided");
      closed.push(structuredClone(a));
    }
    return closed;
  }

  /**
   * Withdraws the pending cards of one kind that `match` picks (`reason` is recorded): the
   * Gateway withdraws open Stripe Link Pay cards when Link is disconnected or signed out, so none
   * can be approved for a payment that cannot happen, and leaves every other card alone. Returns
   * the cards it closed.
   */
  async invalidatePendingOfKind(
    kind: ApprovalKind,
    reason: string,
    match: (a: ApprovalRequest) => boolean = () => true,
  ): Promise<ApprovalRequest[]> {
    this.#sweep();
    const closed: ApprovalRequest[] = [];
    for (const rec of this.#store.listApprovals({ status: "pending" })) {
      if (rec.approval.kind !== kind || !match(structuredClone(rec.approval))) continue;
      await this.#invalidate(rec, reason);
      closed.push(structuredClone(rec.approval));
    }
    return closed;
  }

  async revokeRunAuthority(runId: string): Promise<void> {
    for (const rec of this.#store.listApprovals()) {
      if (rec.approval.requestedBy.runId !== runId) continue;
      rec.revoked = true;
      this.#store.updateApproval(rec);
      if (rec.approval.status === "pending") await this.#invalidate(rec, "run_cancelled");
    }
  }

  // ---- receipts -----------------------------------------------------------------------------

  async recordReceipt(input: ReceiptInput): Promise<Receipt> {
    if (input.approvalId != null && this.#store.getApproval(input.approvalId) === undefined) {
      return fail("not_found", `approval ${input.approvalId} not found`);
    }
    const r = await this.receipts.record(input);
    this.#emit({ type: "receipt.created", receipt: r });
    return r;
  }

  async listReceipts(
    filter: { taskId?: string; toolCallId?: string; approvalId?: string; kind?: string } = {},
  ): Promise<Receipt[]> {
    return this.receipts.list(filter);
  }

  // ---- grant ledger -------------------------------------------------------------------------

  async listGrants(
    filter: GrantFilter & { scope?: GrantScope; taskId?: string; expiringWithinMs?: number } = {},
  ): Promise<Grant[]> {
    const now = this.clock.now();
    return this.#store
      .listGrants()
      .map((r) => r.grant)
      .filter((g) => filter.includeRevoked === true || g.revokedAt == null)
      .filter((g) => filter.kind === undefined || g.kind === filter.kind)
      .filter((g) => filter.scope === undefined || g.scope === filter.scope)
      .filter((g) => filter.taskId === undefined || g.taskId === filter.taskId)
      .filter((g) => {
        if (filter.expiringWithinMs === undefined) return true;
        if (g.expiresAt == null) return false;
        const left = Date.parse(g.expiresAt) - now;
        return left > 0 && left <= filter.expiringWithinMs;
      });
  }

  async revokeGrant(grantId: string, reason = "owner"): Promise<Grant> {
    const rec = this.#store.getGrant(grantId);
    if (rec === undefined) return fail("not_found", `grant ${grantId} not found`);
    if (rec.grant.revokedAt != null) return rec.grant;
    return (await this.#revoke(rec, reason)).grant;
  }

  async #revoke(rec: StoredGrant, reason: string): Promise<StoredGrant> {
    const next = structuredClone(rec);
    next.grant.revokedAt = new Date(this.clock.now()).toISOString();
    next.meta.revokedReason = reason;
    this.#store.updateGrant(next);
    // Outside the backup scope, so restoring an older backup cannot bring the grant back.
    this.#revocations?.recordGrant(next.grant.id, reason);
    this.#emit({ type: "grant.revoked", grant: next.grant });
    await this.#log(
      "grant.revoked",
      { type: "system" },
      { grantId: next.grant.id },
      { reason, kind: next.grant.kind, scope: next.grant.scope },
    );
    return next;
  }

  async #revokeWhere(pred: (g: StoredGrant) => boolean, reason: string): Promise<Grant[]> {
    const out: Grant[] = [];
    for (const g of this.#store.listGrants()) {
      if (g.grant.revokedAt == null && pred(g)) out.push((await this.#revoke(g, reason)).grant);
    }
    return out;
  }

  /** Settings → Permissions → "Revoke all" (feature F4). */
  revokeAllGrants(): Promise<Grant[]> {
    return this.#revokeWhere(() => true, "owner_revoked_all");
  }

  /** A revoked device takes the grants it approved with it (design-28). */
  revokeGrantsByDevice(deviceId: string): Promise<Grant[]> {
    return this.#revokeWhere((g) => g.meta.createdByDeviceId === deviceId, "device_revoked");
  }

  /** The server's `tools/list` hash changed: grants bound to another hash end (security §11). */
  revokeMcpGrants(serverId: string, currentToolsListHash: string): Promise<Grant[]> {
    return this.#revokeWhere(
      (g) =>
        (g.grant.kind === "mcp_tool" || g.grant.kind === "connector_action") &&
        g.grant.subject.serverId === serverId &&
        g.grant.subject.toolsListHash !== currentToolsListHash,
      "tools_list_changed",
    );
  }

  /** The Task reached a terminal state: its `task` grants end (security §3.4). */
  endTask(taskId: string): Promise<Grant[]> {
    this.#tasks.delete(taskId);
    return this.#revokeWhere(
      (g) => g.grant.scope === "task" && g.grant.taskId === taskId,
      "task_ended",
    );
  }

  /** `/new` in a thread: its `session` grants end. */
  endSession(threadId: string): Promise<Grant[]> {
    this.#tasks.delete(`thread:${threadId}`);
    this.#sessionFolders.delete(threadId);
    this.#pruneRoots();
    for (const k of this.#fileGrantExpiry.keys()) {
      if (k.startsWith(`${threadId}\0`)) this.#fileGrantExpiry.delete(k);
    }
    for (const k of this.#attachRecords.keys()) {
      if (k.startsWith(`${threadId}\0`)) this.#attachRecords.delete(k);
    }
    return this.#revokeWhere(
      (g) => g.grant.scope === "session" && g.meta.threadId === threadId,
      "session_ended",
    );
  }

  async exportGrants(): Promise<{ exportedAt: string; grants: Grant[] }> {
    return {
      exportedAt: new Date(this.clock.now()).toISOString(),
      grants: await this.listGrants({ includeRevoked: true }),
    };
  }

  taskStatus(taskId: string): { paused: boolean; downgraded: boolean } {
    const s = this.#tasks.get(taskId);
    return { paused: s?.paused ?? false, downgraded: s?.downgraded ?? false };
  }

  /** The owner resumes a Task the circuit breaker paused; it never resets itself. */
  resumeTask(taskId: string): void {
    const s = this.#tasks.get(taskId);
    if (s === undefined) return;
    s.paused = false;
    s.prohibited = 0;
  }
}

export function createPermissionBroker(options: PermissionBrokerOptions): PsychePermissionBroker {
  return new PsychePermissionBroker(options);
}
