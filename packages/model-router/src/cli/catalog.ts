import type { ProviderKind } from "../config.ts";

/**
 * Context windows of the subscription CLIs' models (#558). Neither CLI reports one, so the
 * catalog does: Claude models take 200k tokens (1M for the `[1m]` variants Claude Code offers,
 * e.g. `sonnet[1m]`); Codex's default GPT-5 Codex model takes 272k input tokens. The owner's
 * `config.models[id].contextWindow` overrides both.
 */
export const CLAUDE_CODE_CONTEXT_WINDOW = 200_000;
export const CLAUDE_CODE_1M_CONTEXT_WINDOW = 1_000_000;
export const CODEX_CONTEXT_WINDOW = 272_000;

export function cliContextWindow(kind: ProviderKind, modelId: string): number | undefined {
  if (kind === "claude-code") {
    return /\[1m\]$|-1m$/i.test(modelId)
      ? CLAUDE_CODE_1M_CONTEXT_WINDOW
      : CLAUDE_CODE_CONTEXT_WINDOW;
  }
  if (kind === "codex") return CODEX_CONTEXT_WINDOW;
  return undefined;
}
