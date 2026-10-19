# @psyche/skills

**Owner:** S16 (`prompts/s16-search-skills.md`). Feature ids: T1, T2, T5 (loading side) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

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

`FsSkillLoader` implements the `SkillLoader` contract (`list`, `load`, `search`, `proposeInstall`, `install`, `remove`) and adds `listDetailed()` (status, reasons, findings, overrides), `promptIndex({ budgetChars })`, `commands()`, `resolveReferences(text)`, `setEnabled(name, enabled, source?)`, `proposeUpdate(name, ref?)`, `proposeWorkspaceApproval(name)`, `getProposal(id)`, `refresh()`, `watch(debounceMs)` / `close()`.

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

`list()` returns every discovered skill with `enabled` = "active" (agent-core's context assembly filters on it). Without `watch()`, every read rescans (skill folders are a few KB); with it, `fs.watch` events reload after a debounce and emit `reloaded {added, removed, changed}`.

## Prompt index, tools, references, commands

- `promptIndex()` → `<available_skills>` with one `<skill name trust>description</skill>` line per active, model-invocable skill, workspace first, XML-escaped, under `budgetChars` (default 8 000, agent-core's `skillsIndex`). When skills do not fit, an `<omitted count="N">` line points at `skills_search` (feature C2: never silently). S20's twelve bundled skills take about 3 800 characters.
- `skills_search {query, limit}` and `skills_read {name}` (`sideEffect: none`). `skills_read` returns only the `SKILL.md` body of an active, model-invocable skill. **Provenance follows trust:** `bundled` and owner-approved `local` skills are trusted instructions; `verified` and `unknown` (third-party) text comes back `untrusted` and taints the turn (review design-24).
- `resolveReferences(text)`: `$skill-name` in an owner message → up to eight active skills to inject.
- `commands()`: active, user-invocable skills as `/name` for the composer.

## Install trust model (T2)

1. **Propose** (`skills.proposeInstall`): fetch into memory — a local folder / its `SKILL.md`, a `.zip` or Claude-style `.skill` archive, or a git URL at a ref. Nothing touches `$PSYCHE_HOME/skills/` yet.
   - Limits: 200 files, 1 MiB per file, 5 MiB per skill, 5 MiB archives; symlinks, special files, submodules and paths escaping the folder are refused; zip entry sizes are checked before inflating.
   - Git: `https://`, `ssh://` or `user@host:path` only (`file://` behind an option), refs validated, `git fetch --depth 1` into a temporary bare repo with protocol allowlist, hooks off and no credential prompts, then `ls-tree` + `cat-file` (no checkout, so no hooks, filters or symlinks on disk). The ref is resolved to a commit and pinned.
2. **Show and scan**: the proposal carries the full `SKILL.md`, every file (text, size, executable bit), the whole-tree hash and the findings of `scanSkillTree` — plus VirusTotal verdicts by SHA-256 when a key is configured (hashes only, never content; scripts first; 4 lookups per install by default).
3. **Approve**: the handler opens a `skill_install` card: `sideEffect: destructive`, so `once` only and device-only (a chat channel cannot approve it), summary says when high findings will keep it disabled. `bindingHash = sha256("psyche.binding.v1|skill_install|" + canonicalJSON({name, scope, source, treeHash}))`, `grantKey = skill_install|<name>`.
4. **Install** (`skills.install {proposalId, approvalId}`): refused without a broker, with an approval of another kind, a binding mismatch, a consumed or expired approval, or an expired proposal (30 min). Writes **exactly the scanned tree** (staged in `.staging/`, swapped atomically), pins it in `skills.lock.json` (0600; source, commit, version, tree hash, trust, approval id, finding counts), records a `skill_install` receipt. A skill with any `high` finding is installed **disabled** and `setEnabled` refuses it (`policy_denied`).
5. **Every load re-verifies** the whole-tree hash (paths + executable bit + content). A change disables the skill (`hash_mismatch`) until it is re-approved.
6. **Update** (`skills.proposeUpdate`): re-fetch from the pinned source (optionally a new ref), show `update.diff` (unified diff per file, mode changes), `upToDate` when nothing changed; installing needs a fresh approval.
7. **Disable / remove**: `setEnabled(false)` for any skill; `remove` deletes an installed skill and its lock entry, withdraws the approval of a workspace skill (its files stay), and refuses bundled skills (disable them instead). Both record receipts.

**Workspace skills need approval too** (review design-02, Critical): the agent can write `workspace/skills/**` through the `memory` tool, so a workspace `SKILL.md` is a `draft` until the owner approves it (`skills.proposeWorkspaceApproval` → same `skill_install` card with `scope: "workspace"`); edits after approval are `hash_mismatch`. The approval lives in the lock file outside the workspace, so the agent cannot forge it. `requireWorkspaceApproval: false` turns this off for development.

### Scanner rules

`high` (blocks enabling): `pipe-to-shell` (`curl … | sh/python/…`), `remote-exec` (`bash <(curl`, `eval "$(curl`, `iex`), `decode-and-exec`, `install-instructions` (brew/apt/pip/`npm -g`/`npx -y`/go/cargo/gem installs — declare them in `requires`, the owner installs them), `network-in-prerequisites` (fetch commands under a Prerequisites / Setup / Install heading), `gatekeeper-bypass` (`xattr -d com.apple.quarantine`, `spctl --master-disable`), `persistence` (LaunchAgents, `launchctl load`, crontab), `credential-access` (`~/.ssh`, keychain, browser cookies, cloud credentials), `exfiltration-endpoint` (webhook.site, ngrok, pastebin, Discord/Slack webhooks, Telegram bot API), `raw-ip-url`, `secret` (cloud, GitHub, Slack, Anthropic, OpenAI, Stripe, Google keys; the secret is never quoted in the finding), `agent-directed-instruction` (ignore previous instructions, hide from the owner, act without asking, bypass approvals, reveal prompts or keys), `invisible-characters` (zero-width, bidi controls, tag characters), `unpinned-download`, `invalid-frontmatter`, `missing-skill-md`, `virustotal-malicious`.
`warn`: `privileged-command`, `credential-placeholder`, `encoded-blob`, `hidden-comment`, `binary-file`, `broad-description` ("use for any task"), `declared-installer`, `overrides-bundled`, `virustotal-suspicious`. `info`: `script`, `network-reference` (hosts), `virustotal-*` availability.

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
