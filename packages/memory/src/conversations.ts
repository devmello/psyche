import { PsycheError } from "@psyche/protocol";

/**
 * Conversation import (claude.ai `conversations.json`, ChatGPT `conversations.json`). Parsing
 * only: the Gateway stores the result as archived, read-only, untrusted threads. An export file
 * is data, so everything here is capped and nothing is interpreted.
 */

export type ConversationFormat = "claude" | "chatgpt";

export const CONVERSATION_LIMITS = {
  /** Characters of export text accepted. */
  inputChars: 25_000_000,
  /** Conversations imported per run; the rest are reported as skipped. */
  conversations: 200,
  messagesPerConversation: 400,
  /** Characters kept of one message; longer ones are cut and marked. */
  messageChars: 20_000,
  titleChars: 120,
} as const;

export type SkipReason = "too_many" | "too_large" | "empty" | "invalid";

export interface ImportedMessage {
  role: "user" | "agent";
  text: string;
  /** ISO time of the original message. */
  at: string;
}

export interface ImportedConversation {
  /** "<format>:<id in the export>": the dedupe key. */
  key: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ImportedMessage[];
}

export interface SkippedConversation {
  title: string;
  reason: SkipReason;
}

export interface ParsedConversations {
  conversations: ImportedConversation[];
  skipped: SkippedConversation[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function isoOf(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    // ChatGPT: seconds since the epoch (fractional).
    const d = new Date(v < 1e11 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

function cleanTitle(raw: unknown, fallback: string): string {
  const t = (str(raw) ?? fallback).replace(/\s+/g, " ").trim();
  return t.length > CONVERSATION_LIMITS.titleChars
    ? `${t.slice(0, CONVERSATION_LIMITS.titleChars - 1)}…`
    : t;
}

function capText(text: string): string {
  const max = CONVERSATION_LIMITS.messageChars;
  if (text.length <= max) return text;
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // never split a surrogate pair
  return `${text.slice(0, end)}\n[truncated: ${text.length - end} more characters]`;
}

function claudeMessages(chat: unknown[]): ImportedMessage[] {
  const out: ImportedMessage[] = [];
  for (const m of chat) {
    if (!isRecord(m)) continue;
    const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "agent" : undefined;
    const at = isoOf(m.created_at);
    let text = str(m.text);
    if (Array.isArray(m.content)) {
      const parts = m.content
        .map((c) => (isRecord(c) && c.type === "text" ? str(c.text) : undefined))
        .filter((s): s is string => s !== undefined);
      if (parts.length > 0) text = parts.join("\n\n");
    }
    if (role === undefined || at === undefined || text === undefined || text.trim() === "")
      continue;
    out.push({ role, text, at });
  }
  return out;
}

/** The branch the owner last saw: from `current_node` up through parents, oldest first. */
function chatgptMessages(mapping: Record<string, unknown>, current: unknown): ImportedMessage[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let id = str(current);
  if (id === undefined || !isRecord(mapping[id])) {
    // Fall back to a node with no children when the export has no current_node.
    id = Object.keys(mapping).find((k) => {
      const n = mapping[k];
      return isRecord(n) && Array.isArray(n.children) && n.children.length === 0;
    });
  }
  while (id !== undefined && !seen.has(id) && chain.length < 5_000) {
    seen.add(id);
    const node = mapping[id];
    if (!isRecord(node)) break;
    chain.push(node);
    id = str(node.parent);
  }
  const out: ImportedMessage[] = [];
  for (const node of chain.reverse()) {
    const msg = node.message;
    if (!isRecord(msg) || !isRecord(msg.author)) continue;
    const r = msg.author.role;
    const role = r === "user" ? "user" : r === "assistant" ? "agent" : undefined;
    if (role === undefined || !isRecord(msg.content)) continue;
    const parts = Array.isArray(msg.content.parts) ? msg.content.parts : [];
    const text = parts.filter((p): p is string => typeof p === "string").join("\n\n");
    const at = isoOf(msg.create_time);
    if (text.trim() === "" || at === undefined) continue;
    out.push({ role, text, at });
  }
  return out;
}

/** Parses a conversations export into capped conversations (no writes). */
export function parseConversations(
  format: ConversationFormat,
  content: string,
  limits: { conversations?: number } = {},
): ParsedConversations {
  if (content.length > CONVERSATION_LIMITS.inputChars) {
    throw new PsycheError("invalid_params", "import is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PsycheError("invalid_params", "the file is not a conversations export (JSON)");
  }
  if (!Array.isArray(parsed)) {
    throw new PsycheError("invalid_params", "the file is not a conversations export");
  }
  const maxConversations = limits.conversations ?? CONVERSATION_LIMITS.conversations;
  const conversations: ImportedConversation[] = [];
  const skipped: SkippedConversation[] = [];
  const keys = new Set<string>();
  for (const raw of parsed) {
    if (!isRecord(raw)) {
      skipped.push({ title: "", reason: "invalid" });
      continue;
    }
    const id = str(raw.uuid) ?? str(raw.id) ?? str(raw.conversation_id);
    const title = cleanTitle(format === "claude" ? raw.name : raw.title, "Imported conversation");
    if (id === undefined) {
      skipped.push({ title, reason: "invalid" });
      continue;
    }
    const key = `${format}:${id}`;
    if (keys.has(key)) continue;
    keys.add(key);
    let messages: ImportedMessage[];
    if (format === "claude") {
      messages = Array.isArray(raw.chat_messages) ? claudeMessages(raw.chat_messages) : [];
    } else {
      messages = isRecord(raw.mapping) ? chatgptMessages(raw.mapping, raw.current_node) : [];
    }
    if (messages.length === 0) {
      skipped.push({ title, reason: "empty" });
      continue;
    }
    if (conversations.length >= maxConversations) {
      skipped.push({ title, reason: "too_many" });
      continue;
    }
    if (messages.length > CONVERSATION_LIMITS.messagesPerConversation) {
      skipped.push({ title, reason: "too_large" });
      continue;
    }
    const first = messages[0] as ImportedMessage;
    const last = messages[messages.length - 1] as ImportedMessage;
    conversations.push({
      key,
      title,
      createdAt: isoOf(raw.created_at ?? raw.create_time) ?? first.at,
      updatedAt: isoOf(raw.updated_at ?? raw.update_time) ?? last.at,
      messages: messages.map((m) => ({ ...m, text: capText(m.text) })),
    });
  }
  return { conversations, skipped };
}
