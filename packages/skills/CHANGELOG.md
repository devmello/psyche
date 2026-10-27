# @psyche/skills

## Unreleased (pre-0.3.0)

### Minor Changes

- Agent-proposed skills (T3): routine detection over the loop's in-process hooks, redacted and rate-limited skill drafts that install only through the T2 trust card, and the "Suggested by" card in Settings → Skills.
- Background specialist roles: six bundled `specialist-*` skills with their `specialist` sections, acceptance scripts and examples; the loader validates the section, resolves role allowlists and lists roles (`specialistRoles()`), plus the base prompt's "Specialists" section (#684).

### Patch Changes

- Bundled skills map their capability names to the Gateway's real tools and say why they are unavailable; gating follows the live tool set; the psyched build fails without its skills folder and the smoke lists the shipped skills (#506).
- Apple app capability families for skill gating (`notes.*`, `reminders.*`, `contacts.*`, `music.*`, `files.*`, `shortcuts.*`) with Settings hints (part of #641).
- Bundled skills for the Apple app flows: morning-brief (with a default weekday automation the owner can turn on), email-to-task, meeting-prep and downloads-cleanup; inbox-triage and calendar-planning use the Apple Mail and Calendar tools and say that EventKit cannot invite attendees (part of #641).
- People and projects flows (PG3): meeting-prep on `meeting_prep` / `people_lookup`, people-aware inbox triage, Waiting on / You owe in the brief and the weekly review, People & projects in memory-hygiene, agent guidance for the five tools, and gating hints (part of #653).
- The teaching loop's store and routing (#679): feedback events and lessons in the Gateway database, the lesson router with deterministic refusals and one destination per lesson, writers for SOUL.md, AGENTS.md, USER.md, the people graph, skills' LESSONS.md and automations, `feedback.*` and `memory.lessons.*` in the Gateway, approval answers as implicit evidence, and nightly dreaming scheduled at compose time.
- Mail and meeting workflow skills (part of #671): six-group inbox triage with "Because:" and batches, reply drafts in the owner's voice (drafts only), follow-up-tracking, scheduling-over-email, meeting-notes, the meeting-prep §4.5 format, and the `speech.*` / `proposals.*` gating families.

## 0.3.0-alpha.0

### Minor Changes

- 06ae560: Unified search (FTS5 index, query language, grouped and permission-scoped results, event indexing, `search.query`) and the skills loader with install and trust (discovery, gating, prompt index, `skills_search` / `skills_read`, static scan, `skill_install` approvals, lock file, updates with diff); `skills` table migration.
- 534326e: Skills install and trust (T2): manifest validation and install policy (refused before any card), update detection, the Gateway's `skills.*` handlers and skill tools with third-party descriptions marked untrusted (part of #281), and Settings → Skills with the trust card.

### Patch Changes

- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [81cf744]
- Updated dependencies [1dc1561]
- Updated dependencies [4f8dff6]
- Updated dependencies [a43a514]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [e3ef188]
- Updated dependencies [2064c0c]
- Updated dependencies [2be1a8a]
- Updated dependencies [8e28cac]
- Updated dependencies [e87d482]
- Updated dependencies [42496a0]
- Updated dependencies [ecf0dd5]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [fa08fee]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [e83a19e]
- Updated dependencies [412aaa1]
- Updated dependencies [9a0cd76]
- Updated dependencies [4bc7113]
- Updated dependencies [1cf5421]
- Updated dependencies [1cc7f5a]
- Updated dependencies [0d9d34d]
- Updated dependencies [515b904]
- Updated dependencies [d74ccce]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [4d718e6]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [e4e6f97]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
  - @psyche/permissions@0.3.0-alpha.0
