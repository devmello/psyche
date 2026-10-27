import type { ApprovalRequest, InputRequest, JsonObject, Question } from "@psyche/protocol";

/**
 * Approval card text (security §3.7 "Delivery", S23 design-12). Every surface renders a fixed
 * template per kind from typed fields, security-relevant lines first; attacker strings only fill
 * quoted value slots, with format characters (bidi controls, zero-width, tag block) shown as
 * `⟨U+XXXX⟩`, CR/LF collapsed to `⏎`, and hosts shown as punycode. Chat text is plain (no parse
 * mode); a card that does not fit a surface gets no buttons and a pointer to the Mac instead of a
 * truncated card; a `deviceOnly` approval never gets a card on a chat surface, only the header and
 * "Answer this on your Mac." (security §9).
 *
 * This module has no Node-only imports: the UI kit (`@psyche/ui`) renders the desktop card
 * through it too, so the two surfaces cannot drift (`@psyche/permissions/cards`).
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
 * Like `sanitizeDisplay` but keeps line breaks: for a value a surface shows as its own delimited
 * block (an email body, a diff, an option preview), where a line break cannot forge a card line.
 */
export function sanitizeBlock(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => sanitizeDisplay(line, Number.POSITIVE_INFINITY))
    .join("\n");
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

/**
 * Punycode (IDNA) form of a host, in Node and browsers alike. Returns "" when `host` is not a
 * bare host (a user-info, port, path or forbidden code point would otherwise let `new URL` pick
 * a different host than the one on screen) or already carries a `⟨U+XXXX⟩` / `�` marker, which
 * must stay visible rather than vanish into a punycode label.
 */
function hostToASCII(host: string): string {
  if (host === "" || /[\s@/\\?#:[\]%<>"'`^|{}⟨⟩�]/u.test(host)) return "";
  try {
    const u = new URL(`http://${host}`);
    if (
      u.username !== "" ||
      u.port !== "" ||
      u.pathname !== "/" ||
      u.search !== "" ||
      u.hash !== ""
    )
      return "";
    return u.hostname;
  } catch {
    return "";
  }
}

/** Hosts inside a string, rewritten to punycode (Chromium-style display of IDNs). */
export function punycodeHosts(text: string): string {
  return text
    .replace(/(https?:\/\/)([^/\s:?#⏎]+)/giu, (_m, scheme: string, host: string) => {
      const ascii = hostToASCII(host.toLowerCase());
      return `${scheme}${ascii === "" ? host : ascii}`;
    })
    .replace(
      /([A-Za-z0-9._%+-]+)@([^\s@,;⏎<>]+\.[^\s@,;⏎<>]+)/gu,
      (_m, local: string, domain: string) => {
        const ascii = hostToASCII(domain.toLowerCase());
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
  task_start: "Start background task",
  apple_script: "Run AppleScript",
  shortcut_run: "Run Shortcut",
  git_write: "Change git repository",
  git_push: "Push to git remote",
  folder_access: "Open a folder",
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
  apple_script: ["target", "language", "source"],
  shortcut_run: ["name", "input"],
  git_write: ["repo", "operation", "branch", "message", "paths"],
  git_push: ["remote", "remoteUrl", "branch", "commit", "repo"],
  // What the skill asks for comes before anything else on the trust card (T2).
  skill_install: [
    "name",
    "source",
    "commit",
    "hash",
    "permissions",
    "tools",
    "prompts",
    "findings",
    "scope",
  ],
};

/** Kinds whose list fields read "none" when empty (a trust card must say it asks for nothing). */
const NONE_WHEN_EMPTY: Record<string, readonly string[]> = {
  skill_install: ["permissions", "tools", "prompts"],
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

/** Second line of a card a chat surface may not answer (security §3.7, §9). */
export const DEVICE_ONLY_TEXT = "Answer this on your Mac.";
/** Second line of a card that did not fit its surface. */
export const TOO_LONG_TEXT = "Open on your Mac to review.";

export interface RenderedCard {
  text: string;
  /** Never set: chat adapters send plain text (design-12). */
  parseMode?: undefined;
  buttons: { label: string; decision: "approve" | "deny" }[];
  /** The card did not fit; the surface shows "Open on your Mac to review". */
  truncated: boolean;
  /** A chat surface was given the header and "Answer this on your Mac." only. */
  deviceOnly: boolean;
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

/** Chat surfaces: everything that is not the paired device itself (desktop, web, notification). */
export function isChatSurface(surface: string): boolean {
  const kind = surfaceKind(surface);
  return kind !== "desktop" && kind !== "web" && kind !== "notification";
}

/** `punycodeHosts` over every string in a (sanitized) details tree. */
function punycodeStrings(value: unknown): unknown {
  if (typeof value === "string") return punycodeHosts(value);
  if (Array.isArray(value)) return value.map(punycodeStrings);
  if (typeof value === "object" && value !== null) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = punycodeStrings(v) as JsonObject[string];
    return out;
  }
  return value;
}

/**
 * Display-safe copy of an approval for structured (desktop) rendering: the same value-slot rules
 * as the text card (hidden characters, line breaks, punycode hosts), applied to `summary`,
 * `target` and every `details` value. Keys listed in `blockKeys` keep their line breaks (they
 * are shown as delimited blocks, never as card lines).
 */
export function sanitizeApproval(
  a: ApprovalRequest,
  blockKeys: readonly string[] = ["body", "bodyPreview", "diff", "preview", "text"],
): ApprovalRequest {
  const details = punycodeStrings(sanitizeDetails(a.details)) as JsonObject;
  for (const key of blockKeys) {
    const raw = (a.details as Record<string, unknown>)[key];
    if (typeof raw === "string")
      details[sanitizeDisplay(key, 200)] = punycodeHosts(sanitizeBlock(raw));
  }
  return {
    ...a,
    summary: punycodeHosts(sanitizeDisplay(a.summary)),
    details,
    ...(a.target === undefined
      ? {}
      : {
          target: {
            ...a.target,
            value: punycodeHosts(sanitizeDisplay(a.target.value, Number.POSITIVE_INFINITY)),
            ...(a.target.display === undefined
              ? {}
              : {
                  display: punycodeHosts(
                    sanitizeDisplay(a.target.display, Number.POSITIVE_INFINITY),
                  ),
                }),
          },
        }),
    ...(a.invalidatedReason === undefined
      ? {}
      : { invalidatedReason: sanitizeDisplay(a.invalidatedReason, 500) }),
  };
}

/** Fixed template: header, target, key fields, then the rest; never the free-text summary first. */
export function renderForSurface(surface: string, a: ApprovalRequest): RenderedCard {
  const kind = surfaceKind(surface);
  const header = cardHeader(a);
  if (kind === "notification") {
    // Notifications show the header only and send the owner to the card (design-12).
    return { text: header, buttons: [], truncated: false, deviceOnly: false };
  }
  if (a.deviceOnly && isChatSurface(surface)) {
    // Never the arguments, never buttons: a chat sender is not a presence-checked device (§9).
    return {
      text: `${header}\n${DEVICE_ONLY_TEXT}`,
      buttons: [],
      truncated: false,
      deviceOnly: true,
    };
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
  const noneWhenEmpty = NONE_WHEN_EMPTY[a.kind] ?? [];
  for (const k of keys) {
    const v = details[k];
    if (noneWhenEmpty.includes(k) && Array.isArray(v) && v.length === 0) {
      lines.push(`${sanitizeDisplay(k, 60)}: none`);
      continue;
    }
    lines.push(
      `${sanitizeDisplay(k, 60)}: “${punycodeHosts(sanitizeDisplay(valueText(v), Number.POSITIVE_INFINITY))}”`,
    );
  }
  lines.push(`Summary: “${punycodeHosts(sanitizeDisplay(a.summary))}”`);
  lines.push(`Expires: ${a.expiresAt}`);
  const text = lines.join("\n");
  if (text.length > SURFACE_LIMITS[kind]) {
    return { text: `${header}\n${TOO_LONG_TEXT}`, buttons: [], truncated: true, deviceOnly: false };
  }
  return {
    text,
    buttons: [
      { label: "Approve", decision: "approve" },
      { label: "Deny", decision: "deny" },
    ],
    truncated: false,
    deviceOnly: false,
  };
}

export interface RenderedQuestion {
  /** Plain text for a chat surface; the header line, then one numbered block per question. */
  text: string;
  /** The questions with every model-authored string sanitized; what a structured surface shows. */
  questions: Question[];
  /** Never set: chat adapters send plain text. */
  parseMode?: undefined;
  /** The text did not fit; the surface shows the header and a pointer to the Mac. */
  truncated: boolean;
}

export const QUESTION_HEADER = "Psyche needs an answer before continuing";

/**
 * Question card (`ask_user`, UI design §3.4) for a surface. Questions are written by the model,
 * which may be echoing untrusted content, so headers, questions, labels and descriptions are
 * value slots like approval details; previews keep their line breaks (shown as blocks).
 */
export function renderQuestionForSurface(
  surface: string,
  request: Pick<InputRequest, "questions">,
): RenderedQuestion {
  const kind = surfaceKind(surface);
  const questions: Question[] = request.questions.map((q) => ({
    ...q,
    header: sanitizeDisplay(q.header, 60),
    question: sanitizeDisplay(q.question, 2000),
    options: q.options.map((o) => ({
      ...o,
      label: sanitizeDisplay(o.label, 200),
      ...(o.description === undefined ? {} : { description: sanitizeDisplay(o.description) }),
      ...(o.preview === undefined ? {} : { preview: sanitizeBlock(o.preview) }),
    })),
  }));
  const lines = [QUESTION_HEADER];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. “${q.header}”: “${q.question}”${q.multiSelect ? " (pick any)" : ""}`);
    for (const o of q.options) {
      lines.push(`   - “${o.label}”${o.description === undefined ? "" : ` — “${o.description}”`}`);
    }
  });
  const text = lines.join("\n");
  if (text.length > SURFACE_LIMITS[kind]) {
    return { text: `${QUESTION_HEADER}\n${TOO_LONG_TEXT}`, questions, truncated: true };
  }
  return { text, questions, truncated: false };
}
