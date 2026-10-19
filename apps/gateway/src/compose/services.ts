import type { HashChainAuditLog } from "@psyche/audit";
import type { PsycheDb } from "@psyche/db";
import type { PsycheNotifier } from "@psyche/notifications";
import type {
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
import type { HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import type { Gateway } from "../server.ts";
import type { CallContexts } from "./call-context.ts";

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
  readonly logger?: Logger;
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
  /** Verifies presence assertions of one kind (the helper's Touch ID signature). */
  readonly presence?: { kind: PresenceAssertion["kind"]; verifier: PresenceVerifier };
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
