import type { HashChainAuditLog } from "@psyche/audit";
import type { PsycheDb } from "@psyche/db";
import type { PsycheNotifier } from "@psyche/notifications";
import type { PsychePermissionBroker } from "@psyche/permissions";
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
  /** Approvals over chat (the channels part). */
  readonly relay?: ApprovalRelay;
}

/** Hooks the channels part gives the broker (approvals over chat, owner senders). */
export interface ApprovalRelay {
  /** Extra surfaces for every approval: the owner's chat peers (`telegram:<id>`). */
  surfaces(): Surface[];
  /** Deliver an issued approval to those surfaces (buttons, `/approve` fallback). */
  deliver(issued: IssuedApproval): Promise<void>;
  isOwnerSender(channel: string, senderId: string): Promise<boolean>;
}
