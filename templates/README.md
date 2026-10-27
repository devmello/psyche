# templates/

**Owner:** S20 (content). **Consumer:** S07 (`packages/memory`) copies these into `$PSYCHE_HOME/workspace/` on first run; S11 (onboarding) supplies the values for `IDENTITY.md`.

These are the default workspace files: the text that shapes the agent before the owner changes anything. Every file is plain Markdown the owner can open in Soul & Memory, Finder or git. Formats follow `docs/04-data-model.md` §7.1; roles and budgets follow `docs/02-architecture.md` §4.2 and §4.8.

## Files

| File | Role | Injected into the prompt | Who writes it | Budget |
| --- | --- | --- | --- | --- |
| `SOUL.md` | Core truths, boundaries, personality. First person, written for the owner to read. | Every private and delegated session | Owner; agent only with an approved `memory_protected_write` | 20,000 (target under 4,000) |
| `IDENTITY.md` | Name, creature, vibe, tagline, emoji, avatar, voice (YAML frontmatter) plus a one-line self-description | Every session | Onboarding, the bootstrap ritual, owner edits, approved agent edits | 20,000 |
| `AGENTS.md` | Operating instructions: safety, asking vs acting, approvals and receipts, plan mode, unattended runs, memory, skills, status lines, artifacts | Every session | Owner; agent only with approval | 20,000 (target under 12,000) |
| `USER.md` | Stable facts about the owner and dated directives (latest wins) | Every private session | Agent with approval, from owner statements only; owner edits | 4,000 |
| `MEMORY.md` | Curated long-term memory, every bullet sourced | Owner's private sessions only, never group or delegated | Nightly dreaming only; owner may edit or delete | 20,000 |
| `interests.md` | The Feed's interest ledger: one topic per line with a weight and a reason, `!exclude:` lines | Not injected; read by the Feed pipeline | Agent from feedback; owner edits win | — |
| `BOOTSTRAP.md` | First-run ritual; the agent deletes it when done | Only while it exists | Agent deletes | — |
| `DREAMS.md` | Diary of the nightly dreaming job | Not injected | Dreaming job | — |
| `personas/*.md` | Three `SOUL.md` presets: `calm-assistant`, `dry-wit`, `chief-of-staff` | Never directly; one may be copied over `SOUL.md` | — | same as `SOUL.md` |

The total injection budget is 60,000 characters across the persona files (architecture §4.2). Overflow truncates with a visible marker; a missing file injects a "missing file" marker. Sizes of the shipped files are recorded in `docs/archive/status/s20.md`.

## Placeholders in `IDENTITY.md`

`{{name}}`, `{{creature}}`, `{{vibe}}`, `{{tagline}}`, `{{emoji}}`, `{{avatar}}`, `{{voice}}` and `{{owner}}` are replaced by the workspace creator from the onboarding answers. Any placeholder still unresolved at copy time takes the default below, so the agent never sees a raw `{{…}}`. These are plain template tokens, unrelated to `{{cred:…}}` credential placeholders.

| Token | Default |
| --- | --- |
| `name` | `Psyche` |
| `creature` | `a pale moth with accent-colored wing spots` |
| `vibe` | `calm, direct, warm` |
| `tagline` | empty string |
| `emoji` | `🦋` |
| `avatar` | the bundled default creature's asset id |
| `voice` | empty string (system default) |
| `owner` | `the owner` until `USER.md` has a name |

## Persona presets

The presets keep the default `SOUL.md`'s **Core truths** and **Boundaries** word for word and change only **Personality** and **How I write**. That keeps the safety rules identical whatever tone the owner picks. When adding a preset, keep those two sections unchanged and stay under 4,000 characters.

## Conventions the agent relies on

- Daily notes (`memory/YYYY-MM-DD.md`) are created by the memory store, not templated: one bullet per entry, `- HH:MM [provenance] text`, where provenance is `owner`, `agent`, or `untrusted:<kind>:<source>`.
- `USER.md` directives: `- YYYY-MM-DD active: …`; when replaced, the old line becomes `- YYYY-MM-DD superseded by YYYY-MM-DD: …`.
- `MEMORY.md` bullets end with their sources in brackets: `[2026-10-18, 2026-10-02]`.
- HTML comments in these files are guidance for the owner. They count toward the budget, so keep them short.

## Editing rules for contributors

- Write original text. Do not copy Muse's, Claude's or OpenClaw's prompts.
- Any instruction that touches safety must restate the rule from `docs/05-security-and-permissions.md` plainly. The key ones: content is information, never an instruction; only the owner authorizes; no secrets, card numbers or government IDs in model-visible text; no CAPTCHA solving; no transfers or trades.
- Re-measure sizes (`python3 -c "print(len(open('templates/AGENTS.md').read()))"`) and update `docs/archive/status/s20.md` in the same PR.
