# Spike 05: local models for agent work on Apple Silicon

Date: 2026-10-19. Time box: one day. Code: [`spikes/local-models/`](../../spikes/local-models/) (throwaway). Raw results: `spikes/local-models/results/*.jsonl`, generated matrix: `results/matrix.md`.

## Answer in one paragraph

On a 16 GB Apple Silicon Mac the agent loop runs locally on **`qwen3.5:9b` under Ollama 0.40.6 with thinking off**. It passed every case on every run through Ollama's native `/api/chat` and through llama.cpp `llama-server --jinja` (Q4_K_M GGUF). **`gemma4:12b`** also passes, through Ollama's `/v1/chat/completions` and `/v1/messages`. **`gpt-oss:20b` technically loads but is not usable on 16 GB**: 6.5 tok/s, 12 GB of swap, and 300 s timeouts on multi-step cases. The 27–31B models (Qwen3.8-27B, Gemma 4 26B/31B, GLM-4.7-Flash) do not fit at all. **The B4 suite currently merged in `packages/model-router/src/probe.ts` does not separate capable models from incapable ones**: it rates the 0.8B negative control `agent-capable` 6/6 on all six of its runs. The six cases below do separate them, because three of them (multi-step checklist plan, refusal when no tool fits, schema-exact JSON) defeat the small model on nearly every run. S03 should adopt the suite and criteria in [§ Final probe suite for S03](#final-probe-suite-for-s03-b4). **For INT-1**, Ollama works on this Mac and the model to use is `qwen3.5:9b` (see [§ INT-1](#int-1-live-run)).

## Setup

| Item | Version / detail |
|---|---|
| Machine | Apple M5, 16 GB unified memory, macOS 27.0. Shared with ~10 other Psyche sessions and spike-06's macOS VM, so throughput is pessimistic and noisy (the 0.8B bench varied 19–104 tok/s). The desktop app crashed twice and the machine restarted once during the day; every run below completed and was written to disk before those events. |
| Ollama | **v0.40.6** (GitHub release `ollama-darwin.tgz`, latest as of 2026-10-16; Homebrew still ships 0.40.4). Run with `OLLAMA_CONTEXT_LENGTH=16384 OLLAMA_FLASH_ATTENTION=1 OLLAMA_MAX_LOADED_MODELS=1`, one model loaded at a time. |
| llama.cpp | **b11723** release binary (`llama-server` reports `0.7.0-dev`), `--jinja -c 16384 -fa on`, GGUF blobs reused from Ollama's store. |
| AI SDK | `ai@7.0.143`, `@ai-sdk/openai-compatible@3.0.71`, `@ai-sdk/anthropic@4.0.82`, `ollama-ai-provider-v2@4.0.1` (Apache-2.0, talks to `/api/chat`), `zod@4.6.7`. Same pins as `packages/model-router` on main. |
| LM Studio | **Not run.** The cask (0.4.26) is proprietary and its first run requires the user to accept the EULA, which a session can't do on the user's behalf. It speaks the same OpenAI-compatible protocol as `llama-server`, so the `lmstudio` endpoint in `endpoints.ts` is wired but unrun. |

### Models (tags verified against registry.ollama.ai manifests)

| Tag | Download | Format on Apple Silicon | Resident at 16K ctx | Status |
|---|---|---|---|---|
| `qwen3.5:0.8b` | 1.24 GB | MLX safetensors (mxfp8), MLX runner | 5.3 GB | run (negative control) |
| `qwen3.5:0.8b-q8_0` | 1.02 GB | GGUF | – | run on llama-server |
| `qwen3.5:9b` | 7.64 GB | MLX safetensors, MLX runner | 7.7 GB | run (largest Qwen3.x that fits 16 GB) |
| `qwen3.5:9b-q4_K_M` | 6.55 GB | GGUF | – | run on llama-server |
| `gemma4:12b` | 7.71 GB | MLX safetensors, MLX runner | ~9.0 GB peak | run on Ollama (largest Gemma 4 that fits); **not run** on llama-server (time) |
| `gpt-oss:20b` | 13.79 GB | GGUF (MXFP4), llama.cpp runner | 11.2 GB, swaps | run, trimmed (see matrix); **not run** on llama-server (memory/time) |
| `qwen3.8:27b` | 17.74 GB (`-mlx` 18.17) | – | does not fit 16 GB | **not run** |
| `gemma4:26b` (A4B) / `gemma4:31b` | 18.73 / 20.39 GB | – | does not fit | **not run** |
| `glm-4.7-flash:latest` (q4_K_M) | 19.02 GB | – | does not fit | **not run** |

Note: on Apple Silicon, Ollama's default tags for Qwen 3.5 and Gemma 4 now resolve to **MLX safetensors**, not GGUF. llama.cpp can't reuse those blobs, so llama-server testing needs the explicit `-q4_K_M` / `-q8_0` tags (a second download).

## Matrix: models × endpoints × probe cases

Cells give passes per run: 3 runs per cell, 2 for gemma4:12b, and 1 for gpt-oss outside native (cut because each multi-step case hit the 300 s cap under swap). "think" is the AI SDK `reasoning` option: `none` turns thinking off and `medium` turns it on. A config is **agent-capable** only if every case passed on every run. tok/s and TTFT come from one streamed 5-sentence prose prompt after a warm-up (TTFT counts the first reasoning or text token). The last column is the median wall time per case.

| model | endpoint | think | single | parallel | follow-up | json | plan | refuse | score | verdict | tok/s | TTFT ms | median case s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gemma4:12b | ollama-anthropic | medium | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 6/6 | **agent-capable** | 34.6 | 285 | 8.1 |
| gemma4:12b | ollama-anthropic | none | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 6/6 | **agent-capable** | 23.7 | 149 | 2.0 |
| gemma4:12b | ollama-native | medium | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | 5/6 | chat-only | 33.0 | 273 | 11.1 |
| gemma4:12b | ollama-native | none | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | 5/6 | chat-only | 23.2 | 185 | 2.0 |
| gemma4:12b | ollama-openai | medium | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 5/6 | chat-only | 22.4 | 523 | 7.0 |
| gemma4:12b | ollama-openai | none | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 6/6 | **agent-capable** | 21.6 | 120 | 2.6 |
| gpt-oss:20b | ollama-anthropic | medium | 1/1 | 0/1 | 1/1 | 0/1 | 0/1 | 1/1 | 3/6 | chat-only | – | – | 300.8 |
| gpt-oss:20b | ollama-native | none | 3/3 | 0/3 | 3/3 | 2/3 | 0/3 | 3/3 | 3/6 | chat-only | 6.5 | 1709 | 66.7 |
| gpt-oss:20b | ollama-openai | medium | 1/1 | 0/1 | 0/1 | 0/1 | 0/1 | 1/1 | 2/6 | chat-only | – | – | 300.7 |
| qwen3.5:0.8b | llama-server | medium | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 | 1/3 | 3/6 | chat-only | 96.2 | 36 | 5.1 |
| qwen3.5:0.8b | llama-server | none | 3/3 | 3/3 | 3/3 | 2/3 | 0/3 | 0/3 | 3/6 | chat-only | 103.6 | 56 | 2.0 |
| qwen3.5:0.8b | ollama-anthropic | medium | 3/3 | 3/3 | 2/3 | 2/3 | 0/3 | 0/3 | 2/6 | chat-only | 30.3 | 161 | 6.5 |
| qwen3.5:0.8b | ollama-anthropic | none | 3/3 | 3/3 | 2/3 | 0/3 | 0/3 | 0/3 | 2/6 | chat-only | 43.7 | 56 | 2.8 |
| qwen3.5:0.8b | ollama-native | medium | 2/3 | 2/3 | 2/3 | 0/3 | 0/3 | 0/3 | 0/6 | chat-only | 92.0 | 53 | 1.1 |
| qwen3.5:0.8b | ollama-native | none | 3/3 | 3/3 | 1/3 | 0/3 | 0/3 | 0/3 | 2/6 | chat-only | 51.9 | 627 | 3.3 |
| qwen3.5:0.8b | ollama-openai | medium | 3/3 | 2/3 | 3/3 | 0/3 | 0/3 | 0/3 | 2/6 | chat-only | 49.5 | 442 | 8.1 |
| qwen3.5:0.8b | ollama-openai | none | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 3/6 | chat-only | 19.1 | 252 | 6.8 |
| qwen3.5:9b | llama-server | medium | 3/3 | 3/3 | 3/3 | 2/3 | 2/3 | 3/3 | 4/6 | chat-only | 23.1 | 68 | 14.5 |
| qwen3.5:9b | llama-server | none | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 6/6 | **agent-capable** | 23.2 | 68 | 3.1 |
| qwen3.5:9b | ollama-anthropic | medium | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 | 3/3 | 4/6 | chat-only | 26.8 | 139 | 8.2 |
| qwen3.5:9b | ollama-anthropic | none | 3/3 | 3/3 | 2/3 | 3/3 | 3/3 | 3/3 | 5/6 | chat-only | 18.7 | 1703 | 6.0 |
| qwen3.5:9b | ollama-native | medium | 3/3 | 3/3 | 2/3 | 3/3 | 2/3 | 3/3 | 4/6 | chat-only | 17.6 | 34382 | 21.2 |
| qwen3.5:9b | ollama-native | none | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 6/6 | **agent-capable** | 25.1 | 270 | 3.1 |
| qwen3.5:9b | ollama-openai | medium | 3/3 | 3/3 | 1/3 | 3/3 | 1/3 | 3/3 | 4/6 | chat-only | 25.8 | 144 | 9.4 |
| qwen3.5:9b | ollama-openai | none | 3/3 | 3/3 | 3/3 | 1/3 | 3/3 | 2/3 | 4/6 | chat-only | 25.5 | 87 | 4.5 |

Per-run failure reasons are in `results/matrix.md`. What the failures mean:

- **The negative control fails the same three cases everywhere.** qwen3.5:0.8b passes single, parallel and follow-up almost always. It fails **plan** on 24/24 runs (wrong order, `run_command` loops, invalid cron expressions, no final summary), fails **refuse** on 23/24 (it calls `get_weather`/`get_time` and then improvises, or claims it can book), and fails **json** on 20/24 (dates like `March 3, 2027`, titles like `Travel & Admin Notification`). These three cases carry the discrimination.
- **Thinking on hurts local agents.** For qwen3.5:9b with think on, the final turn after the tool results often comes back with **empty text**, because the answer stays in the reasoning channel. This hit follow-up 0/3 on `/v1/messages` and 1/3 on `/v1/chat/completions`. Thinking on also makes cases 3–5× slower. With think off, the same model is 6/6 on two endpoints.
- **Copy fidelity.** qwen3.5:9b twice copied the tracking number with a digit dropped (`1Z9X4E77031234567`). The follow-up case catches this. A `contains` check would not.
- **gemma4:12b on native `/api/chat` stops early on plan.** It ends with empty text after the 6th tool result (2/2), but passes plan on both `/v1` endpoints. Probable cause: `ollama-ai-provider-v2` sends tool results as `{role:'tool', tool_call_id, content}` without the `tool_name` field Ollama's native API documents, so Gemma's template loses which tool answered. Not isolated further.
- **gpt-oss:20b**: never made two calls in one turn (0/5 on parallel), sent checklist items with invented field names (`task`, `description`, `step`), once called a non-existent `task.create` tool, and hit the 300 s cap on plan. Most of this is memory pressure (11.2 GB resident plus a VM on a 16 GB machine, 12 GB of swap). Re-run it on a 32 GB machine before judging the model.

Ollama endpoints differ mainly in the provider layer, not in the model. Of the agent-capable configs, qwen3.5:9b passes on native and llama-server, while gemma4:12b passes on `/v1/chat/completions` and `/v1/messages`. No single Ollama endpoint was best for both models.

## Tool-call format quirks (raw HTTP probes, `src/quirks.ts`)

| Behaviour | Ollama `/api/chat` | Ollama `/v1/chat/completions` | Ollama `/v1/messages` | llama-server `--jinja` |
|---|---|---|---|---|
| `tool_choice` | not in the API | **ignored**: `required` and named don't force a call; `none` still allowed calls (all 4 models) | **ignored**: `{type:'any'}` and `{type:'tool'}` don't force a call | `none` honoured; `required` honoured for 0.8B but not for 9B; named not honoured |
| `parallel_tool_calls:false` | n/a | ignored (2 calls returned) | n/a | honoured (1 call) |
| Tool-argument streaming | each call arrives whole in one NDJSON chunk | each call arrives whole (1 delta per call) | each call arrives whole (1 `input_json_delta`) | true incremental deltas (18 chunks for 2 calls) |
| Reasoning field | `message.thinking` | `delta.reasoning` | `thinking_delta` blocks | `delta.reasoning_content` |
| Thinking off | `think:false` | `reasoning_effort:"none"` works | `thinking:{type:'disabled'}` | `reasoning_effort:"none"` works |
| gpt-oss thinking off | – | `reasoning_effort:"none"` still returns reasoning | – | not run |
| Reasoning tags leaking into `text` | never seen | never seen | never seen | never seen |

Two more provider-layer quirks:

- **Default thinking differs by provider.** `ollama-ai-provider-v2` sends `think:false` unless `reasoning` is set, while the OpenAI- and Anthropic-compatible providers send nothing and let the model template decide (Qwen 3.5 thinks by default). The router must always set `reasoning` explicitly for local models, or the same model behaves differently per endpoint.
- **`@ai-sdk/anthropic` against Ollama** warns `unsupported reasoning metadata` on every call. Harmless.

### `memory_20250818` through Ollama's Anthropic endpoint

Ollama accepts the `{type:'memory_20250818', name:'memory'}` definition (HTTP 200, with or without the `context-management-2025-06-27` beta header), but **only the name gets through, not the command schema**. The model sees a tool called `memory` with no parameters and invents arguments: `{memory_name, save_to_directory, message}`, `{key, value}`, `{content: "…"}`, or `{}`. Through `anthropic.tools.memory_20250818()` every call fails AI SDK validation (`AI_InvalidToolInputError`) on all four models, so nothing executes. **Conclusion for S03 / S07:** never send provider-defined Anthropic tools to a non-Anthropic endpoint. For local models, expose the memory command set as a plain function tool with an explicit JSON schema (`command: view|create|str_replace|insert|delete|rename`, plus the per-command fields).

## RAM-fit guidance and recommended defaults

Measured on 16 GB. Larger tiers are inferred from the registry download sizes (verified above) plus ~25% for KV cache at 16K context and the OS; only 16 GB was measured.

| RAM | What fits for agent work | Recommended default (agent `primary`) | `utility` model | Notes |
|---|---|---|---|---|
| 16 GB | ≤ 12B at 4-bit; MLX 9–12B uses 7.7–9 GB at 16K ctx | **`qwen3.5:9b`**, think off, Ollama native or llama-server | same model; no room for two | gemma4:12b works through `/v1/chat/completions`. gpt-oss:20b loads but swaps (6.5 tok/s): don't offer it. 27–31B models don't fit. |
| 32 GB | 27–31B dense at 4-bit (17.7–20.4 GB) or 26–30B MoE | `qwen3.8:27b` or `gemma4:31b`; `gemma4:26b` / `glm-4.7-flash` for speed (3–4B active) | same model; a 9B can't stay loaded alongside a 27B | gpt-oss:20b (13.8 GB) should run properly here. Re-run this suite before shipping these as defaults. |
| 64 GB | 27–35B with long contexts; `qwen3.5:35b` (22 GB); two models loaded | `qwen3.8:27b` + `qwen3.5:9b` utility | `qwen3.5:9b` | not measured |
| 96–128 GB | 120B-class MoE: `gpt-oss:120b` (65 GB), `qwen3.5:122b` (81 GB), Mistral Small 4 | `gpt-oss:120b` | `qwen3.5:9b` | not measured |

This matches the B4 text (16 GB → ~9B, 32 GB → 27–31B, 96–128 GB → 120B MoE). One correction for the settings copy: **gpt-oss:20b is not a 16 GB option in practice**, even though its model card says "within 16GB".

## Final probe suite for S03 (B4)

The suite now merged in `packages/model-router/src/probe.ts` (single_tool_call, typed_arguments, parallel_calls, no_tool_needed, uses_tool_result, json_only; pass mark 5/6 plus three required cases) was ported verbatim to `spikes/local-models/src/s03-suite.ts` and run on the same models:

| model | endpoint | think | merged-suite verdict (runs) |
|---|---|---|---|
| qwen3.5:0.8b | ollama-native | none | 6/6 agent-capable ×3 |
| qwen3.5:0.8b | ollama-native | medium | 6/6 agent-capable ×3 |
| qwen3.5:9b | ollama-native | none / medium | 6/6 agent-capable ×3 each |
| qwen3.5:9b | llama-server | none | 6/6 agent-capable |
| gemma4:12b | ollama-native | none / medium | 5/6 / 6/6 agent-capable |
| gpt-oss:20b | ollama-native | default | 5/6 agent-capable (missed parallel) |

It passes everything, including the negative control. Its cases are all single-turn (the tool result is pre-filled), "Reply OK, do not call any tool" is an instruction rather than a judgement, and `extractJson` forgives fences and prose. **Replace it with these six cases** (implemented in `spikes/local-models/src/cases.ts`; copy the prompts and checks verbatim).

**Shared system prompt** (all cases): *"You are Psyche, a personal agent running on the user's Mac. Use the provided tools when they help. Call tools by their exact names with arguments that match their schemas. If no provided tool can do what the user asks, say so plainly instead of pretending. Today is 2026-10-19."*

**For every case:** stream the response; `maxOutputTokens` 4096; per-case timeout 120 s (300 s for plan); tools execute with canned results; and any stream error, schema-invalid tool input or reasoning tags in `text` count as a failure.

| # | id | Tools | Prompt (abridged) | Pass when |
|---|---|---|---|---|
| 1 | `single_tool` | `get_weather{city, unit: enum celsius\|fahrenheit}`, `get_time{timezone}` | "What is the weather in Lisbon right now? Use celsius." | exactly 1 call, `get_weather`, city ~ Lisbon, `unit === 'celsius'` (enum honoured) |
| 2 | `parallel_tools` | same | "…weather in Paris in celsius, and the current time in Tokyo. Call both tools in this same turn, in parallel." | both calls in step 1 with correct args |
| 3 | `tool_result_followup` | `lookup_order{order_id}` → `{carrier:'UPS', tracking_number:'1Z9X4E770312345678'}`, `track_package{carrier: enum, tracking_number}` → `{location:'Reno, NV'}`; up to 4 steps | "Where is my order 4471 right now? Look up the order, then track its package." | `track_package` called in a later step than `lookup_order`, tracking number **byte-identical**, carrier `UPS`, final text mentions Reno (catches empty final answers) |
| 4 | `strict_json` | none; `Output.object` with `{title, priority: enum low\|medium\|high, due: string (ISO date), tags: string[]}` | "Extract a task from: 'remind me to renew my passport by March 3rd 2027, it's urgent, tag it travel and admin'. Use priority high for urgent things." | parses through the provider's structured-output path with **no repair**, title mentions passport, `priority === 'high'`, `due` starts with `2027-03-03`, tags ⊇ {travel, admin}, no code fence |
| 5 | `plan_checklist` | `update_checklist{items:[{id:int, text, status: enum pending\|in_progress\|done}]}`, `make_dir`, `write_file`, `schedule_cron{schedule, command}`, `run_command`; up to 16 steps | four-step weekly backup: record the plan first, do steps in order, mark each done, one-line summary | first call is `update_checklist` with ≥4 non-done items; first uses of the four work tools in order; ≥3 checklist updates; final checklist all `done`; cron matches `^0 2 \* \* (0\|7\|sun)$`; script contains `rsync`; non-empty summary |
| 6 | `no_hallucination` | `get_weather`, `get_time` only; up to 3 steps | "Book me a table for two at Nopa in San Francisco tonight at 8pm." | **zero** tool calls, no fake tool syntax in text, non-empty answer, no claim of having booked |

### `agent-capable` criteria for the model router

- Run each case once and retry each failed case once. A case passes if it passed on the first try or the retry (at most 12 model calls; ~45 s total for qwen3.5:9b with think off).
- **`agent-capable` iff cases 1, 3, 5 and 6 pass.** These are the ones the negative control could not pass. Otherwise **`chat-only`**.
- Cases 2 and 4 don't gate the verdict. They set capability flags stored with the verdict in `model_profiles.probe_result`: `parallelToolCalls: boolean` (if false, the loop expects sequential calls) and `structuredOutput: boolean` (if false, the model can't be the `utility` model for JSON jobs such as the evaluator or feed ranking).
- A verdict is keyed by `(model ref, endpoint, reasoning mode)`. Probe in the mode the thread will use; a think-on verdict doesn't carry over to think-off.
- If a case can't reach the model (server down, timeout on load), the result is inconclusive and isn't stored. This keeps S03's existing `inconclusive` handling.

On this rule, qwen3.5:9b (think off, native or llama-server) and gemma4:12b (think off, `/v1`) are agent-capable, and qwen3.5:0.8b is chat-only on every endpoint. gpt-oss:20b on 16 GB is also chat-only, which is the right answer for that machine.

### Router rules the probe results imply (S03)

1. Always pass `reasoning` explicitly for local providers, and default local agent threads to `reasoning: 'none'`.
2. Treat an empty final text after tool results as a failed turn (retry once, or surface it). Don't render it as a blank answer.
3. Don't rely on `tool_choice` or `parallel_tool_calls` with Ollama on any endpoint. Enforce "must call a tool" in the loop, and if needed re-prompt once instead of forcing it in the request.
4. Wrap `ollama-ai-provider-v2` to add `tool_name` to tool-result messages (via a custom `fetch` that rewrites the body), or prefer Ollama's `/v1/chat/completions` for Gemma-family models. Re-probe after the change.
5. Don't send provider-defined Anthropic tools (`memory_20250818`, `computer_*`) to Ollama's `/v1/messages`. Map them to function tools with explicit schemas.
6. Expect whole-call tool arguments from Ollama: no incremental `tool-input-delta` streaming, so the UI's "typing arguments" state is skipped. llama-server streams real deltas.

## INT-1 live run

Ollama works on this Mac. Use **`qwen3.5:9b`** (MLX, 7.64 GB, already pulled into `~/.ollama/models`) through the native endpoint with `reasoning: 'none'`:

```bash
OLLAMA_CONTEXT_LENGTH=16384 ollama serve
```

Model ref `ollama/qwen3.5:9b`, base URL `http://127.0.0.1:11434/api`. Expect ~25 tok/s and 0.1–0.3 s TTFT when the machine isn't loaded. The `ollama` binary used here was the v0.40.6 release tarball unpacked in a session scratch folder, so it isn't on `PATH` and no server is left running. Install one with `brew install ollama` (0.40.4, same API) or the Ollama app; the pulled models are in the standard store and will be reused.

## Limits of this spike

- One machine (16 GB), shared with heavy parallel work, so tok/s numbers are lower bounds and noisy.
- **Not run:** LM Studio (EULA needs the user), mlx-lm, Qwen3.8-27B, Gemma 4 26B/31B and GLM-4.7-Flash (don't fit 16 GB), and llama-server for gemma4:12b and gpt-oss:20b (time). gpt-oss:20b was trimmed to one run per non-native endpoint.
- Runs use model-default sampling (temperature unset) and 2–3 repeats. A larger N would tighten the flaky cells (qwen3.5:9b json/refuse on `/v1/chat/completions`).
- The strict_json `due` check originally required exactly `2027-03-03`. Rows recorded before it accepted a date-time on that day are re-scored in `report.ts`, which affected two qwen3.5:9b runs (native, think off).
- The gemma `tool_name` explanation is a hypothesis from reading the provider source, not a confirmed root cause.

## Reproduce

```bash
cd spikes/local-models && pnpm install --ignore-workspace
LLAMA_SERVER_BIN=/path/to/llama-server ./run-matrix.sh qwen3.5:9b ~/.ollama/models/blobs/<q4_K_M blob> 3
npx tsx src/s03-suite.ts --endpoint ollama-native --model qwen3.5:0.8b --reasoning none --repeat 3
npx tsx src/report.ts > results/matrix.md
```
