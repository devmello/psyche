import { domainToASCII } from "node:url";
import type { ApprovalRequest, JsonObject } from "@psyche/protocol";

/**
 * Approval card text (security §3.7 "Delivery", S23 design-12). Every surface renders a fixed
 * template per kind from typed fields, security-relevant lines first; attacker strings only fill
 * quoted value slots, with format characters (bidi controls, zero-width, tag block) shown as
 * `⟨U+XXXX⟩`, CR/LF collapsed to `⏎`, and hosts shown as punycode. Chat text is plain (no parse
 * mode); a card that does not fit a surface gets no buttons and a pointer to the Mac instead of a
 * truncated card.
 */

// Unicode general category Cf, plus line / paragraph separators and other invisibles.
const FORMAT_CHARS = /[\p{Cf}\u2028\u2029\u115F\u1160\u3164\uFFA0\u180E]/gu;

export function sanitizeDisplay(value: string, maxLength = 2000): string {
  let s = value
    .replace(/\r\n|\r|\n/g, "⏎")
    .replace(
      FORMAT_CHARS,
      (c) => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`,
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "�");
  if (s.length > maxLength) s = `${s.slice(0, maxLength)}…`;
  return s;
}

/**
 * Display-safe copy of approval details. Values are never truncated (security §3.7: commands,
 * recipients, amounts and URLs are shown in full; review #8); keys that sanitize to the same text
 * get a `#n` suffix instead of overwriting each other.
 */
export function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (depth > 16) return "…";
  if (typeof value === "string") return sanitizeDisplay(value, Number.POSITIVE_INFINITY);
  if (Array.isArray(value)) return value.map((v) => sanitizeDetails(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const base = sanitizeDisplay(k, 200);
      let key = base;
      for (let n = 2; Object.hasOwn(out, key); n += 1) key = `${base}#${n}`;
      out[key] = sanitizeDetails(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Hosts inside a string, rewritten to punycode (Chromium-style display of IDNs). */
export function punycodeHosts(text: string): string {
  return text
    .replace(/(https?:\/\/)([^/\s:?#⏎]+)/giu, (_m, scheme: string, host: string) => {
      const ascii = domainToASCII(host.toLowerCase());
      return `${scheme}${ascii === "" ? host : ascii}`;
    })
    .replace(
      /([A-Za-z0-9._%+-]+)@([^\s@,;⏎<>]+\.[^\s@,;⏎<>]+)/gu,
      (_m, local: string, domain: string) => {
        const ascii = domainToASCII(domain.toLowerCase());
        return `${local}@${ascii === "" ? domain : ascii}`;
      },
    );
}

const KIND_TITLES: Record<string, string> = {
  exec: "Run command in sandbox",
  exec_host: "Run command on this Mac",
  send_email: "Send email",
  calendar_write: "Change calendar",
  message_send: "Send message",
  browser_submit: "Submit form",
  credential_fill: "Fill credential",
  purchase: "Pay",
  file_write: "Write file",
  connector_action: "Connector action",
  computer_action: "Use app",
  new_origin: "Open site",
  plan_exit: "Start the plan",
  skill_install: "Install skill",
  mcp_tool: "MCP tool",
  archive_thread: "Archive thread",
  memory_protected_write: "Edit protected memory",
  pairing: "Pair device",
  policy_change: "Change permissions",
};

/** Detail keys shown first, in this order, per kind. */
const KEY_FIELDS: Record<string, string[]> = {
  send_email: ["account", "to", "cc", "bcc", "replyTo", "from", "subject", "urls"],
  message_send: ["channel", "account", "recipient"],
  exec: ["argv", "cwd", "env", "network"],
  exec_host: ["argv", "cwd", "env", "executable"],
  purchase: ["merchant", "amount", "currency", "lineItems"],
  credential_fill: ["item", "origin", "field"],
  browser_submit: ["origin", "action", "method", "fields"],
  file_write: ["path", "operation"],
  calendar_write: ["account", "calendar", "operation", "title", "start"],
  mcp_tool: ["server", "tool", "args"],
  new_origin: ["url", "origin"],
  computer_action: ["app", "action"],
};

export type CardSurfaceKind =
  | "desktop"
  | "web"
  | "notification"
  | "telegram"
  | "imessage"
  | "slack"
  | "discord"
  | "signal"
  | "chat";

/** Characters a surface can show before a card would be cut. */
export const SURFACE_LIMITS: Record<CardSurfaceKind, number> = {
  desktop: Number.POSITIVE_INFINITY,
  web: Number.POSITIVE_INFINITY,
  notification: 180,
  telegram: 4000,
  imessage: 1000,
  slack: 3000,
  discord: 2000,
  signal: 2000,
  chat: 1000,
};

export interface RenderedCard {
  text: string;
  /** Never set: chat adapters send plain text (design-12). */
  parseMode?: undefined;
  buttons: { label: string; decision: "approve" | "deny" }[];
  /** The card did not fit; the surface shows "Open on your Mac to review". */
  truncated: boolean;
}

function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(valueText).join(", ");
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function cardHeader(a: Pick<ApprovalRequest, "kind" | "sideEffect" | "taint">): string {
  const title = KIND_TITLES[a.kind] ?? a.kind;
  return `${title} · ${a.sideEffect ?? "unknown"}${a.taint ? " · after reading untrusted content" : ""}`;
}

export function surfaceKind(surface: string): CardSurfaceKind {
  if (surface === "desktop" || surface === "web" || surface === "notification") return surface;
  const channel = surface.split(":")[0] ?? "";
  if (["telegram", "imessage", "slack", "discord", "signal"].includes(channel))
    return channel as CardSurfaceKind;
  return "chat";
}

/** Fixed template: header, target, key fields, then the rest; never the free-text summary first. */
export function renderForSurface(surface: string, a: ApprovalRequest): RenderedCard {
  const kind = surfaceKind(surface);
  const header = cardHeader(a);
  if (kind === "notification") {
    // Notifications show the header only and send the owner to the card (design-12).
    return { text: header, buttons: [], truncated: false };
  }
  const lines = [header];
  if (a.target !== undefined) {
    lines.push(
      `Target: “${punycodeHosts(sanitizeDisplay(a.target.display ?? a.target.value, Number.POSITIVE_INFINITY))}”`,
    );
  }
  const details = a.details as Record<string, unknown>;
  const order = KEY_FIELDS[a.kind] ?? [];
  const keys = [
    ...order.filter((k) => k in details),
    ...Object.keys(details)
      .filter((k) => !order.includes(k))
      .sort(),
  ];
  for (const k of keys) {
    lines.push(
      `${sanitizeDisplay(k, 60)}: “${punycodeHosts(sanitizeDisplay(valueText(details[k]), Number.POSITIVE_INFINITY))}”`,
    );
  }
  lines.push(`Summary: “${punycodeHosts(sanitizeDisplay(a.summary))}”`);
  lines.push(`Expires: ${a.expiresAt}`);
  const text = lines.join("\n");
  if (text.length > SURFACE_LIMITS[kind]) {
    return { text: `${header}\nOpen on your Mac to review.`, buttons: [], truncated: true };
  }
  return {
    text,
    buttons: [
      { label: "Approve", decision: "approve" },
      { label: "Deny", decision: "deny" },
    ],
    truncated: false,
  };
}
