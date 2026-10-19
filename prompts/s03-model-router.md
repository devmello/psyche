# Session S03 — Model router

You are building Psyche (read `README.md`). You are session **S03 — Model router**: `packages/model-router`, the only code that talks to model providers. Work in your own worktree on branch `ws/s03-model-router`. You own `packages/model-router/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §4.4
3. `docs/03-feature-spec.md` rows B1–B7
4. `docs/07-tech-decisions.md` ADR-003
5. Contracts: `ModelProvider`, `CredentialBroker` (for keys); fakes in `packages/testing`
6. Research: `research_notes/Psyche personal agent landscape/models_memory_mcp_ui_feed.md` sections "Models — 1" through "Models — 6" (AI SDK v7 facts, current model ids, Ollama Anthropic-compatible endpoint, llama.cpp `--jinja`, local model list, usage normalization, how OpenClaw/Goose route)

## Mission (M1)
- **Adapters** on AI SDK v7 provider packages (verify current versions with `npm view`): Anthropic (Messages API; adaptive thinking; prompt caching; pass through `memory_20250818` and computer-use toolsets when enabled), OpenAI (Responses API), Google (Interactions API), OpenRouter, OpenAI-compatible (`baseURL`: llama.cpp `llama-server`, LM Studio, vLLM), Anthropic-compatible (`baseURL`: Ollama `/v1/messages`), Ollama native. Each adapter implements `ModelProvider.stream()` producing the normalized event stream (text delta, tool call delta/complete, opaque reasoning block, usage, finish reason) and returns provider-native assistant turns as opaque blobs for verbatim round-tripping.
- **Router**: `provider/model` refs; roles `primary`, `fallbacks[]`, `utility`, `embedding`, `vision`, `speech`; per-provider cooldown after failures; auth-profile rotation inside a provider before falling back; strict mode for user-pinned models (fail visibly); per-thread overrides; `prepareStep`-style model swap hook for the agent loop.
- **Usage ledger**: tokens by class (input, output, cache read, cache write, reasoning), cost from a vendored price table (script `pnpm prices:update` pulls LiteLLM's `model_prices_and_context_window.json` and normalizes it; commit the normalized JSON), provider-reported cost when present (OpenRouter); write `usage` rows through a repository interface; expose `usage.summary` for the UI's meter and a monthly budget alert.
- **Capability probe** (B4): a six-case tool-calling/JSON suite run on first use of a model; persist `agent-capable | chat-only`; RAM-fit guidance table and suggested local models (Qwen3.8-27B, Gemma 4, gpt-oss-20b/120b, GLM-4.7-Flash, Mistral Small 4; re-verify names against Ollama's library at build time).
- **Embeddings**: `embed(texts)` through Ollama/llama.cpp (nomic-embed-text-v1.5 with task prefixes, Qwen3-Embedding-0.6B) or a hosted provider; dimension reported for the memory index.
- **Keys**: read provider credentials only through `CredentialBroker` placeholders resolved at request time; never log headers.

## Out of scope
The agent loop (S02), memory (S07), UI (S12).

## Definition of done
- Contract tests per adapter using recorded fixtures (no network in CI): streaming text, parallel tool calls, tool results in, images in, reasoning round-trip, usage, error mapping (429/5xx/timeouts → cooldown), cancellation. Live tests behind `PSYCHE_LIVE_TESTS=1` with env keys.
- Router tests: fallback within one request, cooldown expiry, strict mode, role resolution, per-thread override.
- Probe test against a fake and a documented manual run against Ollama.
- README: provider matrix (what each supports), config examples for Ollama/llama.cpp/LM Studio, price-table update procedure; `docs/status/s03.md`.

## Suggested subagents
One per adapter family to read current provider docs and write fixtures; one to build the price-table normalizer; one to review usage accounting against the AI SDK v7 usage shape.

## M2 follow-ons
Vision and speech roles wired to real providers; OpenRouter BYOK; server-side compaction beta for Anthropic; provider health panel data.
