import type {
  ApprovalRequest,
  ChannelAdapter,
  NodeClient,
  Notification,
  Surface,
} from "@psyche/protocol";
import { type InterruptionLevel, parseChannelSurface, surfaceClass } from "./types.ts";

export type DeliveryOutcome =
  | { status: "delivered" }
  /** `retryable: false` → give up at once (e.g. the capability does not exist). */
  | { status: "failed"; error: string; retryable: boolean }
  /** Deliberately not delivered (policy), never retried. */
  | { status: "suppressed"; reason: string };

export interface DeliveryContext {
  surface: Surface;
  interruption: InterruptionLevel;
  /** 1 for the first try. */
  attempt: number;
}

/** One delivery transport. The Notifier picks the first adapter whose `handles` returns true. */
export interface SurfaceAdapter {
  readonly name: string;
  handles(surface: Surface): boolean;
  deliver(notification: Notification, ctx: DeliveryContext): Promise<DeliveryOutcome>;
}

// --- OS notifications through the mac helper -----------------------------------------------------

/** Node capability the mac helper exposes for notifications (S14 prompt, O10). */
export const NOTIFY_SHOW_CAPABILITY = "notify.show";

/** Params sent to `notify.show`. S14's helper maps them onto `UNNotificationContent`. */
export interface NotifyShowParams {
  /** Stable identifier: re-showing the same id replaces the banner instead of stacking. */
  id: string;
  /** Category per kind; the helper registers one `UNNotificationCategory` per kind. */
  category: Notification["kind"];
  title: string;
  body: string;
  interruptionLevel: InterruptionLevel;
  /** Groups banners per task (`threadIdentifier`). */
  threadId: string | null;
  route: string | null;
  actions: {
    id: string;
    label: string;
    destructive: boolean;
    authenticationRequired: boolean;
    /** One free-text question → reply field (UI §3.20). */
    textInput: boolean;
  }[];
}

export function toNotifyShowParams(
  n: Notification,
  interruption: InterruptionLevel,
): NotifyShowParams {
  return {
    id: n.id,
    category: n.kind,
    title: n.title,
    body: n.body,
    interruptionLevel: interruption,
    threadId: n.taskId ?? null,
    route: n.route ?? null,
    actions: n.actions.map((a) => ({
      id: a.id,
      label: a.label,
      destructive: a.destructive === true,
      authenticationRequired: a.authenticationRequired === true,
      textInput: n.kind === "input_needed" && a.id === "reply",
    })),
  };
}

export interface OsSurfaceOptions {
  /** The connected mac helper node, or `undefined` while it is offline. */
  node: () => NodeClient | undefined;
  /** Used when no helper is connected, e.g. the Electron `Notification` wrapper (arch §4.12). */
  fallback?: SurfaceAdapter;
  timeoutMs?: number;
}

const NON_RETRYABLE = new Set(["not_found", "invalid_params", "forbidden", "not_implemented"]);

export function createOsSurface(options: OsSurfaceOptions): SurfaceAdapter {
  return {
    name: "os",
    handles: (surface) => surfaceClass(surface) === "notification",
    async deliver(n, ctx) {
      const node = options.node();
      if (node === undefined) {
        if (options.fallback !== undefined) return options.fallback.deliver(n, ctx);
        return { status: "failed", error: "no mac helper connected", retryable: true };
      }
      const res = await node.invoke(
        NOTIFY_SHOW_CAPABILITY,
        toNotifyShowParams(n, ctx.interruption),
        {
          timeoutMs: options.timeoutMs ?? 10_000,
        },
      );
      if (res.ok) return { status: "delivered" };
      const code = res.error?.code ?? "internal";
      return {
        status: "failed",
        error: `${code}: ${res.error?.message ?? "notify.show failed"}`,
        retryable: !NON_RETRYABLE.has(code),
      };
    },
  };
}

// --- Chat channels -------------------------------------------------------------------------------

export interface ChannelSurfaceOptions {
  /** The running adapter for a channel type (`telegram`), or `undefined` if not configured. */
  adapter: (channel: string) => ChannelAdapter | undefined;
  /**
   * The approval behind an `approval` notification and the answer token S05 issued for this
   * chat. Without it approvals are not sent to chat at all.
   */
  approval?: (
    approvalId: string,
    surface: Surface,
  ) => Promise<{ approval: ApprovalRequest; answerToken: string } | undefined>;
}

/** Plain-text rendering: title, body and the deep link; cut to the channel's limit. */
export function channelText(n: Notification, maxChars?: number): string {
  const parts = [n.title, n.body].filter((p) => p.trim().length > 0);
  if (n.route != null) parts.push(`Open in Psyche: ${n.route}`);
  const text = parts.join("\n\n");
  if (maxChars === undefined || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function createChannelSurface(options: ChannelSurfaceOptions): SurfaceAdapter {
  return {
    name: "channel",
    handles: (surface) => parseChannelSurface(surface) !== undefined,
    async deliver(n, ctx) {
      const target = parseChannelSurface(ctx.surface);
      if (target === undefined) return { status: "suppressed", reason: "not a channel surface" };
      const adapter = options.adapter(target.channel);
      if (adapter === undefined) {
        return {
          status: "failed",
          error: `channel ${target.channel} not running`,
          retryable: true,
        };
      }
      try {
        if (n.kind === "approval") {
          // Security §3.5 / §9: deviceOnly approvals never reach chat, not even as a nudge.
          const found =
            n.approvalId == null ? undefined : await options.approval?.(n.approvalId, ctx.surface);
          if (found === undefined) {
            return { status: "suppressed", reason: "approval not deliverable to chat" };
          }
          if (found.approval.deviceOnly) {
            return { status: "suppressed", reason: "deviceOnly approval" };
          }
          if (adapter.sendApprovalButtons === undefined || !adapter.capabilities().buttons) {
            return { status: "suppressed", reason: "channel has no approval buttons" };
          }
          await adapter.sendApprovalButtons(target.peerId, found.approval, found.answerToken);
          return { status: "delivered" };
        }
        await adapter.send({
          chatId: target.peerId,
          text: channelText(n, adapter.capabilities().maxMessageChars),
        });
        return { status: "delivered" };
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        const message = err instanceof Error ? err.message : String(err);
        if (code === "forbidden") return { status: "suppressed", reason: message };
        return {
          status: "failed",
          error: message,
          retryable: typeof code !== "string" || !NON_RETRYABLE.has(code),
        };
      }
    },
  };
}
