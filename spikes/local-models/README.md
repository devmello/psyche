# Spike 05: local model probe (throwaway)

Probes local models' tool calling through AI SDK v7 providers against Ollama (`/api/chat`, `/v1/chat/completions`, `/v1/messages`) and llama.cpp `llama-server --jinja`. Write-up: [`docs/spikes/spike-05-local-models.md`](../../docs/spikes/spike-05-local-models.md).

- `src/cases.ts`: the six-case suite proposed for B4, plus a throughput bench
- `src/run.ts`: runs the suite for one model and endpoint, appending to `results/results.jsonl`
- `src/quirks.ts`: raw-HTTP probes (`tool_choice`, `parallel_tool_calls`, streaming granularity, reasoning fields, `memory_20250818`)
- `src/s03-suite.ts`: port of the suite merged in `packages/model-router/src/probe.ts`, for comparison
- `src/report.ts`: builds the markdown matrix (`results/matrix.md`)
- `run-matrix.sh`: runs one model across all endpoints with think off and on

Not part of the pnpm workspace; install with `pnpm install --ignore-workspace`.
