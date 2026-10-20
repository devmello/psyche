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
| `google` | `@ai-sdk/google` 4.0.99 | Interactions, `store: false` (default) or `googleApi: "generate-content"` (`streamGenerateContent`) | signatures on steps and tool calls | implicit | yes | yes | `x-goog-api-key` |
| `openrouter` | `@openrouter/ai-sdk-provider` 3.1.0 | Chat Completions | `reasoning_details` | upstream | yes | yes | Bearer |
| `openai-compatible` | `@ai-sdk/openai-compatible` 3.0.71 | Chat Completions at `baseURL` | `reasoning_content` deltas | server | server | yes | optional |
| `anthropic-compatible` | `@ai-sdk/anthropic` 4.0.82 | Messages at `baseURL` | server | no | base64 | no | optional |
| `ollama` | `ollama-ai-provider-v2` 4.0.1 | native `/api/chat` | `thinking` deltas | no | base64 | `/api/embed` | none |
| `llamacpp` | `@ai-sdk/openai-compatible` 3.0.71 + compat fixes | Chat Completions, default `http://127.0.0.1:8080/v1` | `reasoning_content` deltas | server prompt cache (`cached_tokens`) | if `--mmproj` | `--embeddings` | optional (`--api-key`) |
| `lmstudio` | `@ai-sdk/openai-compatible` 3.0.71 + compat fixes | Chat Completions, default `http://127.0.0.1:1234/v1` | `reasoning` / `reasoning_content` deltas | no | VLMs | yes | optional |

Every kind supports streaming and parallel tool calls. Keys for hosted kinds come from the vault.

### Feature coverage (fixture tests)

Every row passes the shared conformance suite offline (`describeModelProviderConformance`).

| Kind | Text stream | Parallel tools | Tool results / images in | Reasoning round-trip | Usage by class | Error mapping | Cancel | Tool-name rule | Capabilities source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `google` (Interactions) | ✓ | ✓ | ✓ / ✓ | ✓ | ✓ priced | 400 ctx, 401, 403, 404, 429, 500, 503 | ✓ | 64 chars, letter or `_` first | catalog, probe listing |
| `google` (generate-content) | ✓ | ✓ | ✓ / — | ✓ (`thoughtSignature`) | ✓ priced | 400 ctx, 403, 404, 429, 500, 503 | ✓ | 64 chars, letter or `_` first | catalog, probe listing |
| `openrouter` | ✓ | ✓ | ✓ / ✓ | ✓ | ✓ provider cost | 400 ctx, 401, 429, 500, 503, midstream | ✓ | 64 chars | probe listing (context, modalities, `tools`) |
| `llamacpp` | ✓ | ✓ (+ quirk repair) | ✓ / ✓ | ✓ | ✓ (or from `timings`) | 400 ctx, 401, 500, 503, midstream, no `--jinja` | ✓ | 64 chars | `/props`, `/v1/models`, names |
| `lmstudio` | ✓ | ✓ | ✓ / — | ✓ | ✓ | 400 ctx, 401, 404, 500 (string errors) | ✓ | 64 chars | `/api/v1` or `/api/v0` models, names |

Tool names are mapped per provider family (`toolNameRuleFor`): Anthropic accepts `[a-zA-Z0-9_-]{1,128}`, OpenAI and the servers that copy it 64 characters, Gemini 64 characters starting with a letter or `_`. The map is reversible per request; the loop only sees real names.

### Subscription CLIs: `claude-code` and `codex`

These providers run on the owner's own plans through the installed CLIs: Claude Code (`claude -p`, a Claude Pro or Max plan) and the OpenAI Codex CLI (`codex exec`, a ChatGPT plan). No API key is involved. Refs are `claude-code/<model>` (`default`, `opus`, `sonnet`, `haiku` or a full model id) and `codex/<model>` (`default` or a model id). `default` leaves the choice to the CLI.

- **Tool bridge.** Psyche's tools are offered to the CLI as a stdio MCP server named `psyche`.
  - That server is `src/cli/mcp-stdio-bridge.mjs`. It relays each call to a loopback endpoint in the router (`ToolBridge`).
  - The bearer token is read from a 0600 file, never from argv, the environment or the CLI's config.
  - A model call ends at the CLI's tool calls (`finish{tool_calls}`) while the CLI process waits. The agent loop runs the tools behind the Permission Broker as usual, and the next model call hands the results back to that same process.
  - The CLI never runs a Psyche tool itself.
- **The CLI's own tools are off.**
  - **Claude Code:** `--tools ""`, `--strict-mcp-config`, `--allowedTools mcp__psyche`, `--permission-mode dontAsk`, `--setting-sources ""`. CLAUDE.md and auto-memory are disabled.
  - **Codex:** shell, browser, computer use, apps, plugins, image tools and web search are disabled. Runs use `--sandbox read-only`, `--ignore-user-config` and an empty working directory. Codex has no switch for `apply_patch`, but the read-only sandbox leaves it nothing to change.
- **System prompt.** Psyche's system prompt replaces Claude Code's (`--system-prompt`). For Codex it goes in as `developer_instructions`.
- **Sessions.** Each turn stores the CLI session id as an opaque `reasoning` envelope (`kind: "cli-session"`). The next turn resumes it (`--resume` / `exec resume`) and sends only what is new. A thread that started on another model is sent as a transcript.
- **Streaming and usage.**
  - Claude Code streams text and thinking deltas (`--include-partial-messages`). Usage comes per message.
  - `codex exec --json` streams no text deltas, so each agent message arrives whole. Its usage totals are cumulative, so each turn reports the difference.
  - Cost is 0: the plan pays.
- **Environment.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and their relatives are removed from the CLI's environment, so the subscription login is what runs. Claude Code's telemetry and error reporting are switched off.
- **Errors.** These map to router kinds:
  - not signed in → `auth`;
  - plan or usage limit → `rate_limited`;
  - CLI missing → `model_not_found`;
  - Codex starting its own command → `bad_request` (the run is stopped).
- **Probe.** `probeEndpoint` runs `--version` plus `claude auth status --json` or `codex login status`.
  - It reports installed, signed in, and the sign-in method with the plan name. It never reports the email, the organisation or a token.
  - It makes no model call, so it spends no quota.

**Limits, honestly.**
- The CLI must be installed and signed in on the Gateway's machine.
- Rate limits and usage caps are the plan's. A heavy agent turn uses the same quota as interactive use.
- Each turn starts a CLI process, which takes about 1–2 s.
- A run waiting on an approval keeps its process alive for up to 4 h. After a Gateway restart, it resumes from the stored session id.
- The CLIs' output formats can change between versions; this was built against Claude Code 2.1.286 and codex-cli 0.162.0.
- When a tool call is refused (for example, arguments changed after approval), Claude Code models tend to retry the same call where API Haiku stops. The retry is a new tool call with the arguments the model knows, so it needs a fresh approval, and the provider never re-sends the old one (#500).

### Tool input schemas (#414)

Every provider needs a tool's input schema to be one object at the top level (`{"type": "object", …}`). A top-level union (TypeBox `Type.Union`, so `{"anyOf": [...]}`) would make the provider refuse the whole request.

- `normalizeToolSchema` turns a top-level `anyOf` / `oneOf` / `allOf` of object variants into one object.
  - Properties are merged. Where the variants disagree on a property, it becomes an `enum` of their constants, or an `anyOf` of their schemas.
  - `required` is what every variant requires; for `allOf`, what any variant requires.
  - The variants stay visible to the model as a summary in `description`.
- The tool's executor still validates against the real union.
- Any tool still not an object after this fails the request locally with `bad_request: tool "<name>" input schema must be {"type": "object", …}`. Nothing is sent. `toolSchemaProblem(spec)` gives that same message to callers that want to check their own schemas.

### Local-server quirks (`compat.ts`)

`llamacpp` and `lmstudio` run on `@ai-sdk/openai-compatible` with fixes at the HTTP boundary:

- **Named tool choice.** llama-server reads `tool_choice` only as `auto` / `none` / `required` and silently treats an object as `auto`; LM Studio documents only the strings. `{tool: "x"}` goes out as `"required"` with only tool `x`.
- **Tool-call deltas.** Parallel calls that reuse one `index` with different `id`s get distinct indices; an empty continuation `id` is dropped; object `arguments` are stringified; `finish_reason: "stop"` after tool calls becomes `tool_calls`.
- **Usage.** A final chunk with llama.cpp `timings` and no `usage` (older builds) gets `usage` from `prompt_n`, `cache_n` and `predicted_n`.
- **Errors.** LM Studio's `{"error": "message"}` is reshaped so the message survives. `tools param requires --jinja flag` (HTTP 500) maps to `bad_request`: no cooldown, no silent fallback.
- **Assistant turns** that only call tools go out with `content: ""`.

Anthropic specifics:

- **Thinking replay (#306).** A signed thinking block is bound to the prefix it was produced under: the system prompt plus the tools.
  - Each thinking envelope carries a fingerprint of that prefix (`thinkingPrefix`).
  - On replay, a completed turn's block is dropped when the fingerprint no longer matches, for example after a tool is withheld in plan mode or an unattended run, or after the system prompt changes.
  - With thinking off, no earlier thinking is sent at all.
  - The tool loop in flight keeps its block, as do envelopes stored before the fingerprint existed. For those, requests that replay thinking carry `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`), so the API drops what it still rejects. Turn this off with `thinkingBlockBinding: false`.

- Adaptive thinking is on by default for Claude 4.6+ and 5.x.
- `providerTools: { memory: true, computer: true }` replaces tool specs named `memory` / `computer` with `memory_20250818` / `computer_toolset_20260801`.

Anything in `providerOptions[<provider id or package key>]` passes through untouched.

## Configuration examples

```ts
{ id: "ollama", kind: "ollama" }                                                                // Ollama ≥ 0.40, http://127.0.0.1:11434/api
{ id: "ollama-anthropic", kind: "anthropic-compatible", baseURL: "http://127.0.0.1:11434/v1" } // Ollama /v1/messages
{ id: "llamacpp", kind: "llamacpp" }                                                           // llama-server -m m.gguf --jinja --port 8080 (default baseURL)
{ id: "lmstudio", kind: "lmstudio" }                                                           // lms server start (proprietary; default baseURL :1234/v1)
{ id: "gemini", kind: "google", googleApi: "generate-content" }                                // stable Gemini API instead of Interactions
{ id: "openrouter", kind: "openrouter", attribution: { url: "https://example.org", title: "Psyche" } } // opt-in app attribution
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

## Endpoint probe (B4, Settings → Model & providers)

`probeEndpoint(config, {fetch, keys, prices, clock, timeoutMs})` asks one provider what it serves and never throws:

| Kind | Requests | Facts |
| --- | --- | --- |
| `anthropic`, `anthropic-compatible` | `GET /v1/models` (`x-api-key`) | ids, display names; catalog |
| `openai`, `openai-compatible` | `GET /models` (Bearer) | ids; catalog |
| `google` | `GET /v1beta/models` (`x-goog-api-key`) | `inputTokenLimit`, `generateContent` / `embedContent`, `thinking` |
| `openrouter` | `GET /api/v1/models` | `context_length`, `input_modalities`, `supported_parameters` (`tools`, `reasoning`) |
| `llamacpp` | `GET /v1/models`, `GET /props` | runtime `n_ctx`, `modalities.vision`, `chat_template_caps.supports_tool_calls` |
| `lmstudio` | `GET /api/v1/models`, else `/api/v0/models`, else `/v1/models` | type, load state, loaded context, `vision`, `trained_for_tool_use` |
| `ollama` | `GET /api/tags`, `/api/ps`, `/api/version`, `POST /api/show` (first 25) | `capabilities`, `<arch>.context_length`, loaded |

The result is `{state, probedAt, latencyMs, server, models, error}` with `state` one of `not_probed` (`NOT_PROBED`, before anyone asks), `reachable`, `unreachable`, `auth_failed`, `error`. Each model's `capabilities` merges, lowest authority first, a name heuristic (`guessFromName`), the catalog (price table), the listing and the provider config, and names the strongest `source`. Keys go through the adapters' `KeySource`; neither the key nor the sentinel appears in a result. `KeyValueEndpointProbeStore` keeps results as `models.endpoint.<provider id>` settings rows, and `AiSdkAdapter.learn(models)` feeds the facts into `capabilities()`.

## Tests

- **Adapter tests.** Wire fixtures (`test/fixtures/<kind>/*.json`, holding SSE or NDJSON bodies) are replayed through an injected `fetch`, so the real provider packages parse them. Tests assert on the outgoing request. Each kind covers streaming text, parallel tool calls, tool results and images in, reasoning round-trip, usage and cost, error mapping and cancellation.
- **Router tests** run on `FakeModelProvider` with `FakeClock`.
- **Conformance.** The shared `describeModelProviderConformance` suite runs against the router and each adapter.
- **Live tests** (`test/live.test.ts`) need `PSYCHE_LIVE_TESTS=1` plus env keys or a local server.

The fixtures are hand-written from documented wire formats and the packages' parsers. The live tests re-check them against real providers.

## Not done yet

- **Usage on aborted calls.** A call that is cancelled, times out, or fails after content records no usage row. AI SDK v4 stream parts carry usage only on `finish`, so the prompt tokens the provider still bills are not counted.

- **Speech.** The `speech` role can be bound, but there are no speech calls (S17).
- **M2:** vision and speech wired to real providers, OpenRouter BYOK, Anthropic server-side compaction (pass `providerOptions.anthropic.compaction` for now), and health panel data beyond `health()`.
