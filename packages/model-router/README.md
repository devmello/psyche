# @psyche/model-router

**Owner:** S03. Features B1–B6 ([docs/03-feature-spec.md](../../docs/03-feature-spec.md)), architecture §4.4, ADR-003. Plan: [docs/plans/s03.md](../../docs/plans/s03.md). Status: [docs/status/s03.md](../../docs/status/s03.md).

The only code in Psyche that talks to model providers. It contains:

- **Provider adapters** on AI SDK v7 packages: `AiSdkAdapter`, one per provider config.
- **The router** (`ModelRouter`): roles, fallbacks, cooldowns, auth-profile rotation and strict mode.
- **The usage ledger**, with the price table.
- **The capability probe** for local models.

Every adapter, and the router itself, implements `ModelProvider` (`packages/protocol/src/contracts/ModelProvider.ts`).

## Public API

```ts
import { createModelRouter, UsageLedger, SqliteUsageRepository, KeyValueProbeStore, accumulate } from "@psyche/model-router";

const router = createModelRouter(
  {
    providers: [
      { id: "anthropic", kind: "anthropic", profiles: [{ id: "main", credential: "{{cred:anthropic-key}}", approvalId: grantId }] },
      { id: "ollama", kind: "ollama", embeddingModels: ["nomic-embed-text:v1.5"] },
    ],
    roles: {
      primary: { model: "anthropic/claude-sonnet-5-5", fallbacks: ["ollama/qwen3.8:27b"] },
      utility: { model: "anthropic/claude-haiku-5-5" },
      embedding: { model: "ollama/nomic-embed-text:v1.5" },
    },
    probeOnFirstUse: true,
  },
  { clock, credentials: vault, ledger, probes },
);

const turn = await accumulate(router.stream({ model: "router/primary", messages, tools }, { threadId, runId, signal }));
// turn.message() is the assistant ModelMessage to store; turn.finish is the last event.
```

### Refs

- **Model refs** are `provider/model`, split at the first slash. `openrouter/anthropic/claude-sonnet-5-5` is provider `openrouter`, model `anthropic/claude-sonnet-5-5`.
- **Role refs** are `router/<role>`. Roles: `primary`, `utility`, `embedding`, `vision`, `speech`.
  - `utility` and `vision` fall back to the primary chain when they are not bound.

### Router calls

| Call | What it does |
| --- | --- |
| `stream(request, { threadId, runId, job, strict, step, prepareStep, signal })` | Never throws. Ends with exactly one `finish`. On error, `finish.error` is `<kind>: <message>`. |
| `setRole(role, { model, fallbacks }, { override })` | Refuses a `chat-only` model as `primary` unless `override` is set (B4). |
| `setThreadModel(threadId, ref)` | Per-thread `/model`. Strict: no fallback, fails visibly. |
| `prepareStep` (router option or per call) | Swaps the model or `providerOptions` for one step. Ignored for pinned models. |
| `embed(texts, { model, task })` | Embeds through the `embedding` role. nomic task prefixes are applied. |
| `embeddingInfo()` | Returns `{ model, dimensions }` for the memory index. |
| `probe(ref)` | Runs the six-case suite. |
| `probeResult(ref)` | Reads a saved probe verdict. |
| `capabilities(ref)` | Model facts. `toolCalling` is `false` for a `chat-only` model. |
| `allowsAutoMode(ref)` | Whether the model is on the `auto` permission-mode allowlist. |
| `health()` | Providers with their live cooldowns. |

### The assistant turn

`TurnAccumulator` builds the assistant turn in arrival order.

- `reasoning` events with `data: null` carry `textDelta`. They are for display only.
- Every other `reasoning` event is an opaque envelope: signed thinking, encrypted reasoning, or Gemini signatures on tool calls. Send it back unchanged.
- Envelopes are tagged with the provider and model that produced them. Adapters drop envelopes from another provider or model, so a fallback never sends one vendor's signatures to another.

### Usage

`UsageLedger` writes one row per call through `UsageRepository`. Two repositories are included: in-memory, and SQLite against `packages/db`'s `usage` table.

- `summary()` reports the current UTC month by model, with budget percent used and remaining.
- `onBudgetAlert` fires once per month at 80% and at 100%.

Token classes are disjoint:

- `input` counts uncached input tokens.
- `cacheRead` and `cacheWrite` count cached input tokens.
- `output` includes `reasoning`.

Cost = `input×in + cacheRead×read + cacheWrite×write + output×out`. OpenRouter's reported cost wins when present. Local kinds cost 0.

## Provider matrix

| Kind | Package | API | Reasoning round-trip | Prompt caching | Images in | Embeddings | Key |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `anthropic` | `@ai-sdk/anthropic` 4.0.82 | Messages | signed / redacted thinking | system + last message (`cacheTtl` 5m/1h) | yes | no | `x-api-key` |
| `openai` | `@ai-sdk/openai` 4.0.96 | Responses, `store: false` | reasoning items with `encrypted_content` | automatic | yes | yes | Bearer |
| `google` | `@ai-sdk/google` 4.0.99 | Interactions, `store: false` | signatures on steps and tool calls | implicit | yes | yes | `x-goog-api-key` |
| `openrouter` | `@openrouter/ai-sdk-provider` 3.1.0 | Chat Completions | `reasoning_details` | upstream | yes | yes | Bearer |
| `openai-compatible` | `@ai-sdk/openai-compatible` 3.0.71 | Chat Completions at `baseURL` | `reasoning_content` deltas | server | server | yes | optional |
| `anthropic-compatible` | `@ai-sdk/anthropic` 4.0.82 | Messages at `baseURL` | server | no | base64 | no | optional |
| `ollama` | `ollama-ai-provider-v2` 4.0.1 | native `/api/chat` | `thinking` deltas | no | base64 | `/api/embed` | none |

Every kind supports streaming and parallel tool calls. Keys for hosted kinds come from the vault.

Anthropic specifics:

- Adaptive thinking is on by default for Claude 4.6+ and 5.x.
- `providerTools: { memory: true, computer: true }` replaces tool specs named `memory` / `computer` with `memory_20250818` / `computer_toolset_20260801`.

Anything in `providerOptions[<provider id or package key>]` passes through untouched.

## Configuration examples

```ts
{ id: "ollama", kind: "ollama" }                                                                // Ollama ≥ 0.40, http://127.0.0.1:11434/api
{ id: "ollama-anthropic", kind: "anthropic-compatible", baseURL: "http://127.0.0.1:11434/v1" } // Ollama /v1/messages
{ id: "llamacpp", kind: "openai-compatible", baseURL: "http://127.0.0.1:8080/v1" }             // llama-server -m m.gguf --jinja --port 8080
{ id: "lmstudio", kind: "openai-compatible", baseURL: "http://127.0.0.1:1234/v1" }             // lms server start (proprietary)
{ id: "vllm", kind: "openai-compatible", baseURL: "http://gpu-box:8000/v1" }                   // vllm serve <m> --enable-auto-tool-choice --tool-call-parser <p>
```

Local kinds:

- **Longer timeouts.** Default 5 min to the first event, to cover model load. Set `timeouts` to change it.
- **Zero cost** in the ledger.
- **No key required.**

To rotate between two accounts, give one provider several `profiles`.

### RAM-fit guidance

| Unified memory | Class | Suggested (`SUGGESTED_LOCAL_MODELS`) |
| --- | --- | --- |
| 16 GB | ~9B | `gemma4:e4b`, `gemma4:12b`, `gpt-oss:20b` |
| 32 GB | 27–31B | `qwen3.8:27b`, `gemma4:31b`, `gemma4:26b`, `glm-4.7-flash:q4` |
| 96–128 GB | 120B MoE | `gpt-oss:120b`, Mistral Small 4 (GGUF via llama.cpp) |

Names were checked against ollama.com/library on 2026-10-19. Mistral Small 4 is not in Ollama's library. Embedding models: `nomic-embed-text:v1.5` (768 dimensions) and `qwen3-embedding:0.6b` (1024).

## Keys (B6)

Each profile names a `{{cred:slug}}` placeholder and the id of a standing `credential_fill` grant (scope `site`, bound to the provider origin). The grant is created when the owner enters the key in Settings.

At request time:

- **Sentinel key.** Provider packages are built with a sentinel key, so they never hold the real key and never read env vars.
- **Per-request resolution.** `keyInjectingFetch` resolves the secret through `CredentialBroker.resolve`, once per HTTP request. The target is that request's origin, so the vault's origin binding applies.
- **Header injection.** The secret goes into the header inside `ResolvedSecret.use`.
- **Redaction.** Error text passes through `broker.redact`. Headers and request bodies are never logged.
- **Vault refusal.** A refusal is an `auth` error, and the router rotates to the next profile.

## Errors and cooldowns

| Kind | From | Router |
| --- | --- | --- |
| `rate_limited`, `auth`, `billing` | 429, 401/403, 402/quota, vault refusal | Next profile, then fall back. Cooldowns: billing 10 min; `retry-after` honoured. |
| `overloaded`, `server_error`, `timeout`, `network`, `unknown` | 529, 5xx, stalls, connection errors | Provider cooldown, then fall back. |
| `model_not_found`, `context_overflow` | 404, overflow messages | Fall back, no cooldown. |
| `bad_request`, `content_filter` | other 400s, filtered output | Stop. |
| `cancelled` | the caller's signal | `finish{cancelled}`. |

Cooldowns escalate 30 s → 1 min → 5 min, and success resets them. Fallback happens only before the first content event. After content has streamed, the stream ends with the error.

## Price table

`src/data/prices.json` is LiteLLM's `model_prices_and_context_window.json`, normalized:

- **Units:** USD per million tokens.
- **Providers:** anthropic, openai, gemini (listed as `google`), mistral, xai, deepseek.
- **Extra data:** long-context tiers and catalog facts.

To update it each release:

```bash
pnpm --filter @psyche/model-router prices:update
```

Review the diff and commit it. To use a saved copy instead of downloading, run `node scripts/prices-update.ts --input file.json` from this package. The JSON is only parsed, never executed.

Two more rules:

- `Prices.override` takes owner-supplied prices.
- Models without an entry cost $0 and are listed in `summary().unpricedModels`.

## Capability probe (B4)

The suite has six cases:

1. A single tool call.
2. Typed arguments.
3. Two parallel calls.
4. No tool call when none is needed.
5. Using a tool result.
6. A JSON-only answer.

A model is `agent-capable` if it passes at least 5 cases, including 1, 2 and 5. Otherwise it is `chat-only`.

- **When it runs:** the first time a local model is used with tools (`probeOnFirstUse`), or on demand with `probe(ref)`.
- **Where verdicts go:** `KeyValueProbeStore` saves them as `models.probe.<ref>` settings rows.

Manual run against Ollama: start the model, then run the live tests.

```bash
ollama pull qwen3.8:27b && ollama serve
```

```bash
PSYCHE_LIVE_TESTS=1 PSYCHE_LIVE_OLLAMA=1 PSYCHE_LIVE_OLLAMA_MODEL=qwen3.8:27b pnpm --filter @psyche/model-router test:live
```

The verdict and each case print to stderr.

## Tests

- **Adapter tests.** Wire fixtures (`test/fixtures/<kind>/*.json`, holding SSE or NDJSON bodies) are replayed through an injected `fetch`, so the real provider packages parse them. Tests assert on the outgoing request. Each kind covers streaming text, parallel tool calls, tool results and images in, reasoning round-trip, usage and cost, error mapping and cancellation.
- **Router tests** run on `FakeModelProvider` with `FakeClock`.
- **Conformance.** The shared `describeModelProviderConformance` suite runs against the router and each adapter.
- **Live tests** (`test/live.test.ts`) need `PSYCHE_LIVE_TESTS=1` plus env keys or a local server.

The fixtures are hand-written from documented wire formats and the packages' parsers. The live tests re-check them against real providers.

## Not done yet

- **Speech.** The `speech` role can be bound, but there are no speech calls (S17).
- **M2:** vision and speech wired to real providers, OpenRouter BYOK, Anthropic server-side compaction (pass `providerOptions.anthropic.compaction` for now), and health panel data beyond `health()`.
