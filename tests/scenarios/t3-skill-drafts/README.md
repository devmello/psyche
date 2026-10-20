# T3 — agent-proposed skills

**Feature:** T3 (docs/03-feature-spec.md §T: "A repeated 5-step workflow becomes a one-line skill"); security docs/05 §11 ("Agent-proposed skills stay drafts until accepted").
**Runs:** `tests/integration/skills/t3-skill-drafts.test.ts`, offline: the real composed Gateway in a temp `$PSYCHE_HOME`, the desktop's own client, and a request-driven fake model that plays one tool call per request for a named routine. No `scenario.json`: the steps call `skills.drafts.*`, which the JSON runner has no step kind for.

```bash
pnpm --filter @psyche/integration-tests exec vitest run skills/ --maxWorkers=1
```

## Routines

- **receipts**: five read-only steps in the granted folder (`list_dir`, `read_file`, `search_files`, `read_file`, `list_dir`). The owner's first request names an email address and a card number.
- **tickets**: three read-only steps, used for the incognito and dismissal checks.

## Steps and assertions

1. One run of the routine: no draft.
2. The second run in the same thread: `skills.draft.updated` with an open draft (two occurrences, tainted because `list_dir` output is untrusted). It keeps the five steps and the tool names, and only input names (`path`, `query`). The email address, the card number, the granted path, search terms and file names are not in it. It is not in `skills.list`: drafts sit in quarantine (`$PSYCHE_HOME/skills/.drafts/`).
3. A third run: no new draft.
4. `skills.drafts.update`: the owner renames the draft; `edited` is set.
5. `skills.drafts.accept`: the replay check passes, and the draft is staged like `skills.proposeInstall`. The response carries the T2 proposal (trust `unknown`, no high findings) and a device-only, `once`-only `skill_install` approval with `proposedBy: agent`. `skills.install` without the answer fails with `approval_required`.
6. Approve once, then `skills.install`: the draft becomes `installed`, the skill is `active`, and `/weekly-receipts` is a command.
7. The next turn's system prompt lists the skill. Its description is marked as data from an unknown publisher (#281).
8. An incognito thread repeats a routine: no draft.
9. A routine proposed in one thread is dismissed; repeating it in another thread proposes nothing.
