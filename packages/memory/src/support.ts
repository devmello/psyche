import { createHash } from "node:crypto";
import type {
  EventPayload,
  MemoryChangeSource,
  PermissionBroker,
  Provenance,
} from "@psyche/protocol";

/** Local calendar date and wall-clock time of an instant in a time zone. */
export function localDateTime(ms: number, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** The previous calendar date of `YYYY-MM-DD`. */
export function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Etag of file content: a prefix of its sha256. */
export function etagOf(content: string): string {
  return sha256Hex(content).slice(0, 32);
}

// --- Approvals ---------------------------------------------------------------------------------

export interface ProtectedWriteRequest {
  path: string;
  operation: "write" | "delete" | "rename";
  /** sha256 hex of the content to be written (write only). */
  contentSha256?: string;
  /** Destination of a rename. */
  newPath?: string;
}

/**
 * Confirms that `approvalId` is an approved `memory_protected_write` covering this request.
 * The Permission Broker (S05) issues the approval; the store only checks it.
 */
export type ApprovalCheck = (
  approvalId: string,
  request: ProtectedWriteRequest,
) => boolean | Promise<boolean>;

/** Denies every protected write by the agent (the safe default when no broker is wired). */
export const denyAllApprovals: ApprovalCheck = () => false;

/**
 * Approval check backed by the Permission Broker: the approval must exist, be `approved`, be of
 * kind `memory_protected_write`, and name this path as its target (or `details.path`). When the
 * approval's details name an `operation`, `newPath` or `contentSha256`, the request must match
 * them exactly; a request without a content hash never satisfies an approval that has one. The
 * store also consumes each approval id once.
 */
export function brokerApprovalCheck(broker: Pick<PermissionBroker, "get">): ApprovalCheck {
  return async (approvalId, request) => {
    const approval = await broker.get(approvalId);
    if (approval === undefined) return false;
    if (approval.status !== "approved" || approval.kind !== "memory_protected_write") return false;
    const details = approval.details as {
      path?: unknown;
      operation?: unknown;
      newPath?: unknown;
      contentSha256?: unknown;
    };
    const target = approval.target?.value ?? details.path;
    if (target !== request.path) return false;
    if (typeof details.operation === "string" && details.operation !== request.operation) {
      return false;
    }
    if (typeof details.newPath === "string" && details.newPath !== request.newPath) return false;
    if (typeof details.contentSha256 === "string") {
      return details.contentSha256 === request.contentSha256;
    }
    return true;
  };
}

// --- Events ------------------------------------------------------------------------------------

export type MemoryEvent =
  | { event: "memory.file.changed"; payload: EventPayload<"memory.file.changed"> }
  | { event: "memory.job.updated"; payload: EventPayload<"memory.job.updated"> };

export type MemoryEventSink = (event: MemoryEvent) => void;

/** Who performs a write; decides which rules apply (security §8). */
export type WriteActor =
  /** The model through a tool: protected files need an approval, daily notes are append-only. */
  | "agent"
  /** The owner through a paired device (Soul & Memory sheet) or an edit outside Psyche. */
  | "owner"
  /** A memory job of this package (templates, flush, forget, import, reset, dreaming). */
  | "job";

export interface WriteContext {
  actor: WriteActor;
  provenance: Provenance;
  source: MemoryChangeSource;
}
