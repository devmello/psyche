# Archive

This folder is the history of how Psyche was built. Psyche was built by many parallel AI sessions, and everything they wrote down along the way is kept here for reference. **None of it is current.** For what Psyche does and how it works today, read the numbered documents in [docs/](../) and the guides in [docs/guides/](../guides/README.md).

| Folder | What it holds |
| --- | --- |
| [prompts/](prompts/README.md) | The brief each build session started from, plus the shared rules they followed |
| [plans/](plans/) | One plan per session, written before the work started |
| [status/](status/) | One status log per session: what worked, what was stubbed, blockers, known-red areas |
| [reviews/](reviews/README.md) | The adversarial design and PR reviews (S23) |
| [spikes-docs/](spikes-docs/) | Write-ups of the early risk-retiring spikes |
| [spikes/](spikes/README.md) | The spikes' prototype code. Throwaway, never imported by a package, and not part of the pnpm workspace; Biome ignores it |
| [reports/](reports/) | The research report, the M3 dependency audit and threat-model review, the v1 bundle-size report |
| [research-notes/](research-notes/) | The sourced research files behind the landscape report |

Files here are kept as they were written. Where they name a path such as `prompts/s05-permissions-audit.md`, `docs/status/s05.md` or `spikes/dictation`, that path is now under `docs/archive/` (`docs/spikes/` became `docs/archive/spikes-docs/`). Relative links between files were updated when the folders moved.
