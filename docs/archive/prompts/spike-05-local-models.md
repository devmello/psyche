# Spike 05 — Local models for agent work on Apple Silicon

Time box: one day. You are a Psyche engineer (read `README.md`) running a throwaway TypeScript prototype in `spikes/local-models/` with a write-up in `docs/spikes/spike-05-local-models.md`. Branch `spike/05-local-models`. Do not touch any package.

## Read first
`prompts/_shared-rules.md`; `docs/02-architecture.md` §4.4; `docs/03-feature-spec.md` row B4; `research_notes/Psyche personal agent landscape/models_memory_mcp_ui_feed.md` sections "Models — 4" and "Models — 5".

## Question to answer
Which local models and servers can run Psyche's agent loop (parallel tool calls, JSON arguments, multi-step plans) on this Mac, through which endpoint (Ollama native, Ollama `/v1/messages`, llama.cpp `llama-server --jinja`, LM Studio), and what probe suite reliably separates `agent-capable` from `chat-only`?

## Build
1. Install or point at Ollama (current release) and llama.cpp `llama-server`; pull or load: Qwen3.8-27B (or the largest Qwen3.x that fits), Gemma 4 26B-A4B or 31B, gpt-oss-20b, GLM-4.7-Flash, and one small model (≤9B) as a negative control. Record exact tags and sizes (verify names against the registries; do not trust memory).
2. A probe suite of six cases through the AI SDK v7 provider packages (verify versions): single tool call with typed args; two parallel tool calls; tool result → follow-up call; strict JSON output; a 4-step plan with a checklist tool; a refusal-to-hallucinate case (asks for a tool that is not available).
3. Measure tokens/s, time to first token, and pass/fail per case per endpoint; note tool-call format quirks (streaming deltas, `tool_choice` support, reasoning tags).
4. Try the Anthropic-compatible endpoint of Ollama with the Anthropic provider to see whether `memory_20250818`-style tool definitions pass through.

## Report
A matrix of models × endpoints × probe cases, RAM-fit guidance for 16/32/64/128 GB, recommended defaults per tier, and the final probe suite definition for S03 (B4).
