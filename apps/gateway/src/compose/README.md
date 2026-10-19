# Gateway composition root (INT-1)

`composeGateway(options)` builds the real services and starts `psyched` with them; `main.ts` calls it. Owned by the integration sessions (INT-1..3), not S01.

| File | What it wires |
| --- | --- |
| `index.ts` | agent loop, model router or injected provider, Permission Broker + SQLite store, audit log, memory (with flush), task engine + worker pool, scheduler, notifier; mounts package handlers; forwards package events to the bus; applies `permissions.policy` changes |
| `handlers.ts` | adapters from package handler maps to `HandlerDef`; `questions.*` over the loop and the task engine |
| `approval-tokens.ts` | in-memory delivery of single-use answer tokens to the caller's surface (security §3.7) |
| `file-tools.ts` | stand-in `read_file` / `write_file` / `list_dir` until P9 ships (#49) |
| `models.ts` | `PSYCHE_MODEL` → router config with env keys (dev and live tests); `NO_MODEL` |

Status, gaps and timings: [docs/status/int-1.md](../../../../docs/status/int-1.md).
