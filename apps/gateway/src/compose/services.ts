import type { HashChainAuditLog } from "@psyche/audit";
import type { AttentionState } from "@psyche/browser";
import type { PsycheDb } from "@psyche/db";
import type { PsycheNotifier } from "@psyche/notifications";
import type {
  LocalProjectVerifier,
  PresenceAssertion,
  PresenceVerifier,
  PsychePermissionBroker,
} from "@psyche/permissions";
import type {
  Clock,
  EventName,
  EventPayload,
  IssuedApproval,
  PermissionBroker,
  Surface,
  ToolRegistry,
} from "@psyche/protocol";
import type { SecretRedactor, Vault } from "@psyche/vault";
import type { HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import type { Gateway } from "../server.ts";
import type { OwnerAttention } from "./attention.ts";
import type { CallContexts } from "./call-context.ts";
import type { ChannelConversations } from "./channel-conversations.ts";
import type { ComposeRateLimits } from "./rate-limits.ts";

/**
 * What the composition root hands to the INT-2 subsystems (browser, connectors, channels).
 * Each subsystem module turns these into handlers, tools and background work.
 */
export interface ComposeServices {
  readonly db: PsycheDb;
  readonly clock: Clock;
  /** `$PSYCHE_HOME`. */
  readonly home: string;
  /** The broker the agent loop uses (answer tokens, channel delivery). */
  readonly broker: PermissionBroker;
  /** The package broker itself, for callers that need more than the contract. */
  readonly rawBroker: PsychePermissionBroker;
  readonly audit: HashChainAuditLog;
  readonly notifier: PsycheNotifier;
  /** Register package executors here: calls get their decision context through `calls`. */
  readonly tools: ToolRegistry;
  readonly calls: CallContexts;
  publish<E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string): void;
  /** Whether the owner is watching (pause-when-unwatched, #272). */
  readonly attention: OwnerAttention;
  /** Inbound channel policy decisions per conversation (the broker's channel reply authority). */
  readonly channelConversations: ChannelConversations;
  /** The credential vault (S06): connector tokens, Settings → Credentials. */
  readonly vault: Vault;
  /** The redactor the vault registers handed-out values with; mask any output path with it. */
  readonly redactor: SecretRedactor;
  readonly logger?: Logger;
  /**
   * Psyche's own listening ports (security §3.10: never "the owner's project"): the Gateway's
   * configured port, then the bound one once it listens; parts add theirs (a real-Chrome CDP
   * port, a fixed OAuth redirect port). Listeners inside the Gateway process are also found
   * at check time by the browser part, so random-port OAuth receivers need no registration.
   */
  readonly ownPorts: OwnPorts;
  /**
   * Pause-when-unwatched (security §7.2 item 5, #272): the owner's attention per desktop pane, from
   * `attention.report` (pane visible, input in the app) and the owner's own messages and answers.
   * Supplied by the Gateway (S01); the browser part turns its sensitive-origin check on when it is
   * present. Undefined state means nothing was reported: unwatched.
   */
  readonly attention?: (pane: "browser" | "computer") => AttentionState | undefined;
  /** Security §10 rate limits (inbound chat per sender, `web_fetch` per Task), audited. */
  readonly rateLimits: ComposeRateLimits;
}

export interface OwnPorts {
  /** Register a port; returns the unregister function. */
  add(port: number, label: string): () => void;
  list(): number[];
}

/** A small registry; the same port registered twice stays until both are removed. */
export function createOwnPorts(): OwnPorts {
  const ports = new Map<number, Set<symbol>>();
  return {
    add(port, _label) {
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) return () => undefined;
      const token = Symbol(_label);
      let set = ports.get(port);
      if (set === undefined) {
        set = new Set();
        ports.set(port, set);
      }
      set.add(token);
      return () => {
        const s = ports.get(port);
        s?.delete(token);
        if (s !== undefined && s.size === 0) ports.delete(port);
      };
    },
    list: () => [...ports.keys()],
  };
}

/** One subsystem as the composition root mounts it. */
export interface ComposedPart {
  readonly handlers?: Readonly<Record<string, HandlerDef>>;
  /** Runs once the Gateway is listening. */
  start?(gateway: Gateway): Promise<void> | void;
  stop?(): Promise<void> | void;
  /** Approvals delivered beyond the in-app surfaces (chat, the Mac helper's notifications). */
  readonly relay?: ApprovalRelay;
  /**
   * Devices that answer approvals through this part's relay although their paired scopes lack
   * `operator.approvals` (the mac helper node, which can never call `approvals.answer` itself).
   */
  approver?(deviceId: string): boolean;
  /**
   * Verifies presence assertions of one kind (the helper's Touch ID signature). `ready` says
   * whether it can verify anything at all (the owner registered a key); security settings need
   * fresh presence only once some verifier is ready (security §10), so an unconfigured one never
   * locks the owner out of them. Absent `ready` means always ready.
   */
  readonly presence?: {
    kind: PresenceAssertion["kind"];
    verifier: PresenceVerifier;
    ready?: () => boolean;
  };
  /**
   * Decides whether a loopback origin is the owner's own project (security §3.10). The browser
   * part supplies it from its dev-server registry; without one every loopback target is denied.
   */
  readonly localProject?: LocalProjectVerifier;
}

/** Hooks a part gives the broker (approvals over chat or the helper, owner senders). */
export interface ApprovalRelay {
  /** Extra surfaces for every approval: the owner's chat peers (`telegram:<id>`), `notification`. */
  surfaces(): Surface[];
  /** Deliver an issued approval to those surfaces (buttons, `/approve` fallback). */
  deliver(issued: IssuedApproval): Promise<void>;
  /** Channel owners (only the channels part names any). */
  isOwnerSender(channel: string, senderId: string): Promise<boolean>;
}
