/**
 * Provider-facing tool names. Anthropic and OpenAI only accept `^[a-zA-Z0-9_-]{1,128}$` as a
 * function-tool name, while Psyche names tools `gmail.search`, `task.start`, `subagent.spawn`,
 * `mcp__server__tool` and so on (the protocol's `ToolSpec.name` is any non-empty string). The
 * adapter maps names at the provider boundary, reversibly and per request, so the loop, the
 * Permission Broker and the audit log only ever see the real names.
 */
const ALLOWED = /^[a-zA-Z0-9_-]{1,128}$/;

/** `gmail.search` → `gmail_search`; every disallowed character becomes `_`, capped at 128. */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return cleaned.length === 0 ? "tool" : cleaned;
}

interface RequestLike {
  tools?: readonly { name: string }[];
  messages: readonly { parts: readonly { type: string; name?: string }[] }[];
}

export class ToolNameMap {
  readonly #toProvider = new Map<string, string>();
  readonly #toOurs = new Map<string, string>();

  /** Seeded with the request's tools and every tool call already in its history. */
  static for(request: RequestLike): ToolNameMap {
    const map = new ToolNameMap();
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
    let candidate = ALLOWED.test(name) ? name : sanitizeToolName(name);
    for (let n = 2; this.#toOurs.has(candidate); n += 1) {
      candidate = `${sanitizeToolName(name).slice(0, 120)}_${n}`;
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
