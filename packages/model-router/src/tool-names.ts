import type { ProviderKind } from "./config.ts";

/**
 * Provider-facing tool names. Providers accept only a narrow name syntax for function tools,
 * while Psyche names tools `gmail.search`, `task.start`, `subagent.spawn`, `mcp__server__tool`
 * and so on (the protocol's `ToolSpec.name` is any non-empty string). The adapter maps names at
 * the provider boundary, reversibly and per request, so the loop, the Permission Broker and the
 * audit log only ever see the real names.
 */

/** What one provider family accepts as a function-tool name. */
export interface ToolNameRule {
  /** Longest accepted name. */
  maxLength: number;
  /** The first character must be a letter or `_` (Gemini function declarations). */
  letterFirst: boolean;
}

/** Anthropic: `^[a-zA-Z0-9_-]{1,128}$`. */
export const ANTHROPIC_TOOL_NAMES: ToolNameRule = { maxLength: 128, letterFirst: false };
/** OpenAI Chat Completions / Responses and the servers that copy them: `^[a-zA-Z0-9_-]{1,64}$`. */
export const OPENAI_TOOL_NAMES: ToolNameRule = { maxLength: 64, letterFirst: false };
/** Gemini: starts with a letter or `_`, at most 64 characters. */
export const GOOGLE_TOOL_NAMES: ToolNameRule = { maxLength: 64, letterFirst: true };

export function toolNameRuleFor(kind: ProviderKind): ToolNameRule {
  switch (kind) {
    case "anthropic":
    case "anthropic-compatible":
      return ANTHROPIC_TOOL_NAMES;
    case "google":
      return GOOGLE_TOOL_NAMES;
    default:
      return OPENAI_TOOL_NAMES;
  }
}

function isValid(name: string, rule: ToolNameRule): boolean {
  if (name.length === 0 || name.length > rule.maxLength) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return false;
  return !rule.letterFirst || /^[a-zA-Z_]/.test(name);
}

/** `gmail.search` → `gmail_search`; every disallowed character becomes `_`, capped per rule. */
export function sanitizeToolName(name: string, rule: ToolNameRule = ANTHROPIC_TOOL_NAMES): string {
  let cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (rule.letterFirst && cleaned.length > 0 && !/^[a-zA-Z_]/.test(cleaned))
    cleaned = `_${cleaned}`;
  cleaned = cleaned.slice(0, rule.maxLength);
  return cleaned.length === 0 ? "tool" : cleaned;
}

interface RequestLike {
  tools?: readonly { name: string }[];
  messages: readonly { parts: readonly { type: string; name?: string }[] }[];
}

export class ToolNameMap {
  readonly #toProvider = new Map<string, string>();
  readonly #toOurs = new Map<string, string>();
  readonly rule: ToolNameRule;

  constructor(rule: ToolNameRule = ANTHROPIC_TOOL_NAMES) {
    this.rule = rule;
  }

  /** Seeded with the request's tools and every tool call already in its history. */
  static for(request: RequestLike, rule?: ToolNameRule): ToolNameMap {
    const map = new ToolNameMap(rule);
    for (const t of request.tools ?? []) map.toProvider(t.name);
    for (const m of request.messages) {
      for (const p of m.parts) {
        if (p.type === "tool_call" && p.name !== undefined) map.toProvider(p.name);
      }
    }
    return map;
  }

  /** The name sent to the provider; a valid name is kept, a collision gets a numeric suffix. */
  toProvider(name: string): string {
    const known = this.#toProvider.get(name);
    if (known !== undefined) return known;
    const max = this.rule.maxLength;
    let candidate = isValid(name, this.rule) ? name : sanitizeToolName(name, this.rule);
    for (let n = 2; this.#toOurs.has(candidate); n += 1) {
      const suffix = `_${n}`;
      candidate = `${sanitizeToolName(name, this.rule).slice(0, max - suffix.length)}${suffix}`;
    }
    this.#toProvider.set(name, candidate);
    this.#toOurs.set(candidate, name);
    return candidate;
  }

  /** The real name for a name the provider used; unknown names pass through. */
  toOurs(name: string): string {
    return this.#toOurs.get(name) ?? name;
  }
}
