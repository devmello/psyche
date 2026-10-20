# T2 — skills install and trust

**Feature:** T2 (docs/03-feature-spec.md §T); security docs/05 §11 (supply chain), §3.5 (binding), §3.7 (device-only cards).
**Runs:** `tests/integration/skills/t2-skills-trust.test.ts` (offline: the real composed Gateway in a temp `$PSYCHE_HOME`, the desktop's own client, a scripted fake model). No `scenario.json`: the steps call `skills.*` methods, which the JSON scenario runner has no step kind for.

```bash
pnpm --filter @psyche/integration-tests exec vitest run skills/ --maxWorkers=2
```

## Fixtures

- `fixtures/skills/pdf-merge/` — a well-behaved skill: declares `list_dir`, `read_file`, `write_file`, the `file_write` approval kind and one prompt file.
- `fixtures/skills/greedy-shell/` — asks for `exec_host` and declares `skills.install`; the install policy refuses it.

## Steps and assertions

1. `skills.list` — `pdf-merge` is not there; the agent's system prompt does not mention it.
2. `skills.proposeInstall {source: {kind: "path"}}` — returns the staged proposal (full `SKILL.md`, every file, findings, manifest) and a `skill_install` approval: device-only, `once` only, details list `permissions`, `tools` and `prompts`; the desktop card text puts them right after name, source and hash. `approval.created` reaches the desktop.
3. `skills.install` before answering — `approval_required`; nothing is written.
4. The owner approves once on the desktop; `skills.install` writes exactly the scanned tree, pins it in `skills.lock.json` with the manifest, records a receipt; `skills.changed {type: installed}`.
5. `skills.list` shows `pdf-merge` `active` with its manifest; `skills.commands` lists `/pdf-merge`.
6. The agent sees it: the next turn's system prompt lists it in the skills index, and `skills_read` returns its instructions (provenance `untrusted`: a third-party skill is information, not the owner's instruction).
7. Refusal: `skills.proposeInstall` for `greedy-shell` fails with `policy_denied` and `details.violations`; no approval card is opened and nothing is installed.
8. Update detection: the fixture is copied to a temp folder for install; editing it makes `skills.checkUpdates` report `updateAvailable` and `manifestChanged` and emit `skills.updated`, while the approved files keep loading.
9. `skills.remove` — the skill, its lock entry and its `/pdf-merge` command are gone; `skills.changed {type: removed}`.
