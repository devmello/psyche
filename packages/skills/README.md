# @psyche/skills

**Owner:** S16 (`docs/archive/prompts/s16-search-skills.md`). Feature ids: T1, T2, T5 (loading side) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

How `SKILL.md` files are discovered, checked, indexed into the prompt, read by the agent, installed and trusted. A skill is instructions for a job; **it never grants a tool or a permission**.

## Public API

```ts
import { createSkillLoader, createSkillTools, createSkillsHandlers, SqliteSkillStateStore } from "@psyche/skills";

const skills = createSkillLoader({
  workspaceDir: `${home}/workspace/skills`,
  homeDir: `${home}/skills`,            // installed skills + skills.lock.json
  bundledDir: `${appRoot}/skills`,      // S20's bundled skills
  state: new SqliteSkillStateStore(db.sqlite),
  broker,                               // PermissionBroker: verifies skill_install, records receipts
  gate: () => ({ ...defaultGateContext(), tools: registry.list().map((t) => t.name) }),
  virusTotal: vtKey ? createVirusTotalClient({ apiKey: vtKey }) : undefined,
  onChange: (e) => bus.emit("skills.changed", e),
});
skills.watch();                               // hot reload
for (const t of createSkillTools(skills)) registry.register(t); // skills_search, skills_read
const handlers = createSkillsHandlers(skills, { broker });       // skills.* methods
```

`FsSkillLoader` implements the `SkillLoader` contract (`list`, `load`, `search`, `proposeInstall`, `install`, `remove`) and adds `listDetailed()` (status, reasons, findings, overrides), `promptIndex({ budgetChars })`, `commands()`, `resolveReferences(text)`, `setEnabled(name, enabled, source?)`, `proposeUpdate(name, ref?)`, `proposeWorkspaceApproval(name)`, `getProposal(id)`, `refresh()`, `watch(debounceMs, rescanMs)` / `close()`.

Building blocks are exported too: `parseSkill`, `evaluateGates`, `buildPromptIndex`, `extractSkillReferences`, `scanSkillTree`, `fetchSource` / `unzipSkill` / `fetchGit`, `readSkillDir` / `treeHash`, `readLock` / `writeLock`, `unifiedDiff`, `skillInstallBinding`.

## Skill format

A folder `<name>/` with `SKILL.md`: YAML frontmatter, then Markdown. Other files (references, scripts) may sit beside it; only `SKILL.md` is ever given to the model, and never `acceptance.md`.

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | required | 1–64 chars, lowercase letters, digits, single hyphens; must equal the folder name; becomes `/name` |
| `description` | required | ≤ 1 024 chars; what goes into the prompt index (clipped to 280 there) |
| `user-invocable` | `true` | listed as a composer slash command |
| `disable-model-invocation` | `false` | only the owner can start it: not in the index, refused by `skills_read` |
| `requires.bins` / `requires.anyBins` | — | binaries on `PATH` (all / at least one) |
| `requires.env` | — | environment variables that must be set and non-empty |
| `requires.os` (or top-level `os`) | any | `darwin`, `linux` |
| `requires.tools` / `requires.anyTools` | — | registered and enabled tools (all / at least one); `email.*` matches a family (S20's proposal, adopted) |
| `metadata.openclaw.requires.*`, `metadata.openclaw.os` | — | OpenClaw spellings, merged with the above |
| `version`, `license`, `homepage`, `allowed-tools` | — | informational (`allowed-tools` never widens policy) |
| `metadata.psyche.*` | — | informational (S20: priority, features, approvals) |

YAML is parsed with the core schema, unique keys and at most 20 aliases; frontmatter is capped at 16 KiB. A skill whose gates fail is `ineligible`: listed in Settings with the reason, absent from the prompt, the commands and `skills_read`.

## Discovery, precedence and status

Sources in order: workspace `skills/` → `$PSYCHE_HOME/skills/` → bundled. The first **approved, valid** skill of a name wins; the others are `shadowed` and the winner lists what it `overrides` (Settings: "overrides bundled"). Drafts and broken skills neither win nor shadow, so an unapproved workspace file cannot hide a bundled skill.

| Status | Meaning | In prompt |
| --- | --- | --- |
| `active` | valid, approved, eligible, enabled, no high finding | yes |
| `disabled` | the owner switched it off (`skills` table) | no |
| `ineligible` | `requires.*` fails here | no |
| `blocked` | a `high` scan finding | no; cannot be enabled |
| `draft` | workspace skill without an owner approval | no |
| `unlocked` | folder in `$PSYCHE_HOME/skills/` not installed through Psyche | no |
| `hash_mismatch` | files changed since approval; `onChange({type: "hash_mismatch"})` fires once per new hash | no |
| `invalid` | unreadable, symlinked, oversized or bad frontmatter | no |
| `shadowed` | a higher-precedence skill has the name | no |

`list()` returns every discovered skill with `enabled` = "active" (agent-core's context assembly filters on it). Without `watch()`, every read rescans (skill folders are a few KB); with it, `fs.watch` events reload after a debounce and emit `reloaded {added, removed, changed}`, a failed reload is retried, an erroring watcher is re-created, and a full re-hash runs every `rescanMs` (30 s) so a missed event cannot keep changed files active for long. Installs pause watcher reloads until the files and the lock agree.

## Prompt index, tools, references, commands

- `promptIndex()` → `<available_skills>` with one `<skill name trust>description</skill>` line per active, model-invocable skill, workspace first, XML-escaped, under `budgetChars` (default 8 000, agent-core's `skillsIndex`). When skills do not fit, an `<omitted count="N">` line points at `skills_search` (feature C2: never silently). S20's twelve bundled skills take about 3 800 characters.
- `skills_search {query, limit}` and `skills_read {name}` (`sideEffect: none`). `skills_read` returns only the `SKILL.md` body of an active, model-invocable skill. **Provenance follows trust:** `bundled` and owner-approved `local` skills are trusted instructions; `verified` and `unknown` (third-party) text comes back `untrusted` and taints the turn (review design-24).
- `resolveReferences(text)`: `$skill-name` in an owner message → up to eight active skills to inject.
- `commands()`: active, user-invocable skills as `/name` for the composer.

## Install trust model (T2)

1. **Propose** (`skills.proposeInstall`): fetch into memory — a local folder / its `SKILL.md`, a `.zip` or Claude-style `.skill` archive, or a git URL at a ref. Nothing touches `$PSYCHE_HOME/skills/` yet.
   - Limits: 200 files, 1 MiB per file, 5 MiB per skill, 5 MiB archives (regular files only, checked before reading); symlinks, special files, submodules, paths escaping the folder and paths that differ only in case are refused; zip entry sizes are checked before inflating.
   - Git: `https://`, `ssh://` or `user@host:path` only (`file://` behind an option), no credentials in the URL, refs validated, `git fetch --depth 1` into a temporary bare repo with protocol allowlist, hooks off and no credential prompts, then `ls-tree` + `cat-file` (no checkout, so no hooks, filters or symlinks on disk). The ref is resolved to a commit and pinned.
2. **Manifest and policy** (M3): the frontmatter declares what the skill needs — `allowed-tools` + `requires.tools` + `requires.anyTools` (tools), `permissions` (approval kinds such as `send_email`, `file_write`) and `prompts` (Markdown prompt files in the folder). `manifestOf` validates it (known approval kinds, tool names or `family.*` globs, prompt files that exist and are text, at most 64 of each); an invalid manifest is refused (`invalid_params`) and an installed skill with one is `invalid`. `policyViolations` checks it against the install policy (`installPolicy` option): `exec_host`, `skill_install`, `policy_change`, `pairing` and `memory_protected_write` are never allowed, `skills.*` mutations and `policy.*` tools never, plus the owner's tool-only `deny` rules (the Gateway passes `deniedToolsFromPolicy(broker.policy)`). A proposal that asks for more fails with `policy_denied` and `details.violations` **before any card exists**; `install` re-checks, and an installed skill that no longer fits a tightened policy is `blocked`. Declaring is not granting: every call still goes through the broker.
3. **Show and scan**: the proposal carries the full `SKILL.md`, every file (text, size, executable bit), the whole-tree hash and the findings of `scanSkillTree` — plus VirusTotal verdicts by SHA-256 when a key is configured (hashes only, never content; scripts first; 4 lookups per install by default).
4. **Approve**: the handler opens a `skill_install` card on device surfaces only (chat surfaces such as `telegram:123` are dropped), `sideEffect: destructive` so `once` only; `skills.getProposal` serves the full text, files and diff to every device showing the card; summary says when high findings will keep it disabled. The binding is the Permission Broker's own `skill_install` table (`@psyche/permissions` `bindingFor`): `{name, scope, source, commit?, treeHash, tools, permissions, prompts}`, lists sorted; grant key `{name, scope}`. The card's details list `permissions`, `tools` and `prompts` first (`none` when empty).
5. **Install** (`skills.install {proposalId, approvalId}`): refused without a broker, with an approval of another kind, a binding mismatch, a consumed or expired approval, or an expired proposal (30 min). Writes **exactly the scanned tree** (staged in `.staging/`, swapped atomically), pins it in `skills.lock.json` (0600; source, commit, version, tree hash, trust, approval id, finding counts), records a `skill_install` receipt. A skill with any `high` finding is installed **disabled** and `setEnabled` refuses it (`policy_denied`).
6. **Every load re-verifies** the whole-tree hash (paths + executable bit + content). A change disables the skill (`hash_mismatch`) until it is re-approved.
7. **Update detection** (`checkUpdates`, `skills.checkUpdates`): re-fetches every installed skill from its pinned source (a git ref is resolved again), compares the tree hash and the manifest with the lock, never writes; the handler's `onUpdate` feeds the Gateway's `skills.updated` event and Settings shows "Update available" (`manifestChanged` when it would ask for different things). A source that cannot be fetched is an `error` on that skill.
8. **Update** (`skills.proposeUpdate`): re-fetch from the pinned source (optionally a new ref), show `update.diff` (unified diff per file, mode changes), `upToDate` when nothing changed; installing needs a fresh approval.
9. **Disable / remove**: `setEnabled(false)` for any skill; `remove` deletes an installed skill and its lock entry, withdraws the approval of a workspace skill (its files stay), and refuses bundled skills (disable them instead) and folders Psyche did not install. Both record receipts. A `high` finding recorded in the lock (e.g. VirusTotal) keeps blocking after install.

**Workspace skills need approval too** (review design-02, Critical): the agent can write `workspace/skills/**` through the `memory` tool, so a workspace `SKILL.md` is a `draft` until the owner approves it (`skills.proposeWorkspaceApproval` → same `skill_install` card with `scope: "workspace"`); edits after approval are `hash_mismatch`, and the re-approval card diffs against a snapshot of the approved tree kept in `$PSYCHE_HOME/skills/.approved/workspace/`. The approval lives in the lock file outside the workspace, so the agent cannot forge it. `requireWorkspaceApproval: false` turns this off for development.

### Agent-proposed skills (T3)

`SkillDrafts` (`drafts.ts`) drafts a skill from a routine detected by agent-core's `attachRoutineDetector`. A routine is the same tool sequence ending the owner's attended turns at least twice in one thread.

- **Contents**: tool names; input names, never values; the owner's words through the vault and audit redactors, with emails, links and long numbers generalized; `permissions` inferred for side-effecting steps.
- **Limits**: one proposal per thread per day; five open drafts; never the same routine twice (proposed, installed or dismissed); 14-day expiry.
- **`update`**: the owner's edit, re-validated.
- **`accept`**: replays the draft (no tools or approval kinds the routine never used, every tool still available). It then stages the draft from `.drafts/<id>/<name>/` (never loaded) through `proposeInstall`, and the handler opens the usual device-only `skill_install` card with `proposedBy: agent`.
- **`dismiss`**: remembers the routine so it is not proposed again.
- **`installed`**: marks the accepted draft once the loader installs it.
- **Audit**: everything is reported to the `audit` hook.

### Scanner rules

Lines are matched both as written and shell-normalized (continuations joined, quotes and backslashes dropped, `/usr/bin/env` and absolute command paths stripped, `| tee x |` collapsed). Files that are not valid UTF-8 are scanned with a lossy decode; a script among them is itself `high`.

`high` (blocks enabling): `pipe-to-shell` (`curl … | sh/python/…`), `remote-exec` (`bash <(curl`, `eval "$(curl`, `iex`), `decode-and-exec`, `install-instructions` (brew/apt/pip/`npm -g`/`npx -y`/go/cargo/gem installs — declare them in `requires`, the owner installs them), `network-in-prerequisites` (fetch commands under a Prerequisites / Setup / Install heading), `gatekeeper-bypass` (`xattr -d com.apple.quarantine`, `spctl --master-disable`), `persistence` (LaunchAgents, `launchctl load`, crontab), `credential-access` (`~/.ssh`, keychain, browser cookies, cloud credentials), `exfiltration-endpoint` (webhook.site, ngrok, pastebin, Discord/Slack webhooks, Telegram bot API), `raw-ip-url`, `download-and-run` (a download saved to a file plus a line that runs it or `chmod +x`), `broad-description` ("use for any task", design-24 #4), `binary-file` for scripts, `secret` (cloud, GitHub, Slack, Anthropic, OpenAI, Stripe, Google keys; the secret is never quoted in the finding), `agent-directed-instruction` (ignore previous instructions, hide from the owner, act without asking, bypass approvals, reveal prompts or keys), `invisible-characters` (zero-width, bidi controls, tag characters), `unpinned-download`, `invalid-frontmatter`, `missing-skill-md`, `virustotal-malicious`.
`warn`: `privileged-command`, `credential-placeholder`, `encoded-blob`, `hidden-comment`, `binary-file` (non-scripts), `wide-description` ("any question"), `declared-installer`, `overrides-bundled`, `virustotal-suspicious`. `info`: `script`, `network-reference` (hosts, without URL credentials), `virustotal-*` availability.

Scanners lag campaigns (security §2); the scan is one layer. The others are the approval, the lock, the untrusted provenance of third-party text and the rule that a skill never widens tool policy.

## Storage

- `skills` table (data model §10; migration `packages/db/migrations/202610191300_skills_init.sql`, mirror `packages/db/src/schema-s16.ts`): one row per (source, name) with the owner's `enabled` switch, last seen hash, trust and version. `MemorySkillStateStore` for tests.
- `$PSYCHE_HOME/skills/skills.lock.json`: the pins (`home:<name>` installs, `workspace:<name>` approvals). A corrupt lock file makes every read fail loudly; it is never rewritten silently.

## How this maps to the docs

Architecture §13 (skills extension point), §4.3 ("an approved skill never widens tool policy"), §12 (`skills/` storage); security §11 (supply chain), §3.5 (binding hash), §3.6 (taint); data model §10 (`skills`), §4 (`skill_install`); features T1, T2, T5, C2 (index truncation marker); reviews design-02 and design-24.

## What is stubbed

- `skills.*` wire schemas: the handlers are typed locally until the `protocol:` PR adds them.
- Registry / marketplace client (ClawHub-style) and `verified` trust: M2. Today every install is `unknown`.
- Agent-proposed skill drafts (T3, with S15) and replay verification: M2.
- Trigger-keyword gating of third-party skills (design-24 #4) is for S02's skill selection; the index marks third-party skills `trust="unknown"` and clips descriptions.
