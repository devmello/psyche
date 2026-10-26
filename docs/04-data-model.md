# Psyche — Data Model and Storage Formats

Status: draft v0.1 (2026-10-18). Terms from [02-architecture.md](02-architecture.md). All relational data lives in one SQLite database (`$PSYCHE_HOME/state/psyche.sqlite`, WAL mode) managed by drizzle migrations, except secrets (`vault/vault.db`, SQLCipher) and the human-readable workspace (`workspace/`, Markdown). Large blobs (files, recordings, embeddings for big corpora) live on disk under `library/` and are referenced by id.

Conventions: ids are ULIDs (sortable, 26 chars); timestamps are ISO-8601 UTC strings; JSON columns are validated against the TypeBox schemas in `packages/protocol`; every table has `created_at`, and mutable tables have `updated_at`.

---

## 1. Identity, devices, nodes

```sql
devices (
  id TEXT PK, name TEXT, platform TEXT,            -- macos | ios | android | web | linux
  role TEXT,                                       -- client | node | both
  public_key BLOB, token_hash BLOB,                -- Ed25519 identity; hashed device token
  scopes TEXT JSON,                                -- ["operator.read","operator.write","operator.approvals","operator.admin","node"]
  paired_at, last_seen_at, revoked_at
)
nodes (
  id TEXT PK, device_id FK devices, kind TEXT,     -- mac-helper | vm-guest | remote | phone
  capabilities TEXT JSON,                          -- [{name:"computer.click", sideEffect:"write", targetKind:"app"}, ...]
  status TEXT, last_heartbeat_at
)
pairing_requests (
  id TEXT PK, kind TEXT,                           -- device | channel-sender
  code TEXT, device_id, channel_id, sender_id, display TEXT,
  status TEXT,                                     -- pending | approved | denied | expired
  expires_at, decided_at, decided_by_device_id,
  public_key_fingerprint TEXT NULL,                -- "sha256:<hex>" of the raw key the owner approves
  transport TEXT NULL, remote_address TEXT NULL    -- ws | unix; peer address (rate limits, pairing card)
)
```

## 2. Threads, messages, runs, tool calls

```sql
threads (
  id TEXT PK, kind TEXT,                           -- main | side | incognito | channel | automation | subagent
  title TEXT, title_source TEXT,                   -- user | auto
  parent_thread_id FK threads NULL,                -- side chats and subagents point at their parent
  forked_from_message_id FK messages NULL,
  session_key TEXT,                                -- e.g. "owner:main", "telegram:peer:12345", "cron:<jobId>"
  persona_overlay TEXT NULL,                       -- delegated persona name for designated-person threads
  permission_mode TEXT,                            -- plan | manual | balanced | auto
  model_ref TEXT NULL,                             -- user-pinned model for this thread
  pinned INTEGER, archived_at, expires_at NULL,    -- incognito threads expire
  created_at, updated_at, last_message_at
)
messages (
  id TEXT PK, thread_id FK, seq INTEGER,
  role TEXT,                                       -- user | agent | system | tool
  blocks TEXT JSON,                                -- ordered content blocks (see §9)
  provider_native TEXT JSON NULL,                  -- opaque provider turn (signed reasoning etc.), round-tripped verbatim
  provenance TEXT,                                 -- owner | agent | untrusted | system
  reply_to_message_id FK messages NULL,
  channel_ref TEXT JSON NULL,                      -- {channel, account, messageId} for inbound/outbound channel messages
  run_id FK runs NULL, created_at,
  lessons_applied TEXT JSON NULL                   -- LessonRef[]: lessons the Gateway put in this answer's prompt (teaching loop)
)
runs (
  id TEXT PK, thread_id FK, status TEXT,           -- running | done | failed | cancelled | awaiting_approval | awaiting_input
  model_ref TEXT, attempt INTEGER,
  started_at, ended_at, error TEXT NULL,
  usage TEXT JSON                                  -- {input, output, cacheRead, cacheWrite, reasoning, costUsd}
)
-- transcript write guard: thread.active_writer_run_id is stored on the thread row and
-- every message insert carries expected_writer_run_id; mismatch → write rejected.
tool_calls (
  id TEXT PK, run_id FK, message_id FK, tool TEXT,
  params_redacted TEXT JSON,                       -- placeholders kept, secrets never stored
  params_hash TEXT, side_effect TEXT, target TEXT JSON,
  decision TEXT, decision_rule TEXT,               -- allow | ask | deny ; which rule decided
  approval_id FK approvals NULL, taint_in INTEGER, taint_out INTEGER,
  result_ref TEXT NULL,                            -- library item or inline result id
  provenance_out TEXT, receipt_id FK receipts NULL,
  started_at, ended_at, status TEXT                -- ok | failed | uncertain | blocked
)
tool_payloads (                                    -- level-3 tool I/O, deleted after cleanupPeriodDays (§12)
  id TEXT PK, tool_call_id FK tool_calls, kind TEXT, -- params | result | screenshot
  mime TEXT, data BLOB, created_at                 -- tool_calls.result_ref = "payload:<id>"
)
chat_queue (                                       -- follow-ups queued mid-turn (feature E3)
  id TEXT PK,                                      -- becomes the user message id when it starts
  thread_id FK threads, position INTEGER, content TEXT, attachments TEXT JSON,
  device_id FK devices NULL, status TEXT,          -- queued | started | removed
  created_at, updated_at
)
```

## 3. Tasks

```sql
tasks (
  id TEXT PK, thread_id FK, title TEXT, goal TEXT,
  status TEXT,                                     -- queued | running | awaiting_input | awaiting_approval | paused | done | failed | cancelled
  created_from TEXT,                               -- chat | automation | idea | goal | channel | subagent
  plan TEXT JSON,                                  -- {approvedAt, steps:[{id,title,status,note}]}
  checklist TEXT JSON,                             -- harness-managed update_plan items
  current_step_id TEXT, attempt INTEGER,
  lease_owner TEXT NULL, lease_until NULL,
  browser_session_id NULL, sandbox_id NULL,
  summary TEXT NULL, outcome TEXT JSON NULL,
  created_at, updated_at, completed_at,
  lessons_applied TEXT JSON NULL                   -- LessonRef[]: lessons its runs' prompts used (teaching loop)
)
task_checkpoints (
  id TEXT PK, task_id FK, step_id TEXT, idx INTEGER,
  replay_safe INTEGER, status TEXT,                -- pending | running | done | failed | uncertain
  payload TEXT JSON, receipt_id FK NULL, created_at
)
task_actions (                                     -- the Activity log, three disclosure levels
  id TEXT PK, task_id FK, idx INTEGER, tool_call_id FK NULL,
  level1 TEXT,                                     -- one-line status ("Reading Gmail thread from Alice")
  level2 TEXT JSON,                                -- {tool, target, outcome}
  level3_ref TEXT NULL,                            -- raw tool I/O (library item)
  created_at
)
input_requests (
  id TEXT PK, task_id FK, thread_id FK, question TEXT JSON,   -- ask_user payload
  status TEXT, answer TEXT JSON NULL, created_at, answered_at, answered_by_device_id
)
```

## 4. Permissions

```sql
approvals (
  id TEXT PK, kind TEXT,                           -- exec | exec_host | send_email | calendar_write | message_send | browser_submit |
                                                   -- credential_fill | purchase | file_write | connector_action | computer_action |
                                                   -- new_origin | plan_exit | skill_install | mcp_tool | archive_thread |
                                                   -- … | task_start | apple_script | shortcut_run | git_write | git_push
  summary TEXT, details TEXT JSON, binding_hash TEXT, grant_key TEXT,
  device_only INTEGER, requires_authentication INTEGER, taint INTEGER,
  requested_by_run_id FK NULL, task_id FK NULL, thread_id FK NULL,
  surfaces TEXT JSON,                              -- ["desktop","notification","web","telegram:12345"]
  answer_tokens TEXT JSON,                         -- per-surface single-use tokens (hashed)
  status TEXT,                                     -- pending | approved | denied | expired | invalidated
  scope_granted TEXT NULL,                         -- once | task | site | session | always
  decided_by TEXT JSON NULL,                       -- {deviceId} or {channel, senderId}
  requested_at, expires_at, decided_at, grant_id FK grants NULL
)
grants (
  id TEXT PK, kind TEXT, scope TEXT,
  grant_key TEXT,                                  -- coarse match key: tool + target class (see 02-architecture §4.6)
  subject TEXT JSON,                               -- {origin} | {tool} | {path, mode} | {app, tier} | {recipient} | {argv, cwd} | {connector, action}
  binding TEXT JSON NULL, expires_at NULL, use_count INTEGER, last_used_at,
  created_from_approval_id FK NULL, created_at, revoked_at
)
policy_rules (                                     -- user-authored allow/deny rules (mirrors config.json policy section)
  id TEXT PK, priority INTEGER, match TEXT JSON, effect TEXT, note TEXT, created_at
)
```

### 4.1 ApprovalRequest (wire shape)

```json
{
  "id": "01JAX5...",
  "kind": "send_email",
  "summary": "Send reply to alice@example.com — \"Re: Permission slip\"",
  "details": {
    "account": "gmail:pranav@example.com",
    "to": ["alice@example.com"], "cc": [], "subject": "Re: Permission slip",
    "bodyPreview": "Hi Alice, attached is the signed…", "attachments": [{"name": "slip-filled.pdf", "sha256": "…"}]
  },
  "bindingHash": "sha256:…",
  "grantKey": "email.send|gmail:pranav@example.com|example.com",
  "requestedBy": {"runId": "01JAX4…", "taskId": "01JAX3…", "threadId": "01JAX2…", "agent": "Pip"},
  "surfaces": ["desktop", "notification"],
  "scopesOffered": ["once", "task"],
  "deviceOnly": true,
  "requiresAuthentication": false,
  "taint": true,
  "status": "pending",
  "requestedAt": "2026-10-18T20:11:05Z",
  "expiresAt": "2026-10-18T20:41:05Z"
}
```

### 4.2 Binding hash inputs by kind

Security §3.5 is the normative table; this one lists the same kinds. The implemented field set (the union of both, plus the S23 additions: email `replyTo` / `from` / headers / MIME hash, form `action` / method / hidden fields, exec `stdinSha256` / `cwdConfigHashes`) is in `packages/permissions/README.md`. Grant keys for `send_email` are account + the exact recipient set, never the recipient domain (S23 design-11). The `approvals` table also stores `side_effect`, `target`, `scopes_offered`, `request_input` (the decided call and context, so `reissue()` keeps taint), `consumed_at`, `run_revoked` and `boot_id`; `grants` stores `side_effect`, `task_id`, `session_id` (boot id), `thread_id`, `origin`, `max_uses`, `last_used_binding_hash`, `created_by_device_id` and `revoked_reason` (migration `202610200900_permissions_init.sql`).

| kind | hashed fields |
| --- | --- |
| exec / exec_host | normalized argv, cwd, selected env keys, resolved executable path + hash, sandbox id |
| send_email | account, sorted recipients, subject, body hash, attachment hashes |
| calendar_write | account, calendar id, canonical event payload hash, operation |
| message_send | channel, account, recipient id, body hash, attachment hashes |
| browser_submit | origin, path, sorted field names, digest of field values (secrets replaced by their placeholder ids), submit element ref |
| credential_fill | item id, origin, field selector, tab id |
| purchase | merchant origin, amount, currency, line-item hash, payment method id |
| file_write | absolute path, content hash, mode |
| connector_action / mcp_tool | server id, tool name, `tools/list` hash, params hash |
| computer_action | app bundle id, tier required, action, element ref hash |
| apple_script | tool (`apps.applescript` / `apps.jxa`), params hash (exact source and target bundle id) |
| shortcut_run | tool, params hash (exact shortcut name and input) |
| git_write | tool, params hash, repository real path, operation (`commit`: message and paths; `branch`: name, create) |
| git_push | tool, params hash, repository real path, remote name, remote URL, branch, commit SHA (never forced; `once` only) |
| new_origin | origin, task id |
| skill_install | skill name, scope, source (path / zip / git url + ref), commit, whole-tree hash, sorted declared tools, approval kinds and prompt files (grant key: name, scope; device-only, `once`) |

## 5. Receipts and audit

```sql
receipts (
  id TEXT PK, kind TEXT,                           -- same vocabulary as approvals.kind plus read kinds when useful
  task_id FK NULL, tool_call_id FK NULL, approval_id FK NULL,
  outcome TEXT,                                    -- ok | failed | uncertain
  summary TEXT, external_refs TEXT JSON,           -- {gmailMessageId, calendarEventId, stripeSpendRequestId, orderId, exitCode, ...}
  payload TEXT JSON, created_at
)
```

Audit entries are appended to `audit/YYYY-MM.jsonl` (one JSON object per line) and hash-chained:

```json
{"seq": 184233, "ts": "2026-10-18T20:11:09Z", "actor": {"type": "agent", "runId": "01JAX4…"},
 "event": "tool_call.decided", "data": {"tool": "email.send", "decision": "ask", "rule": "mode:balanced/write"},
 "prev": "sha256:…", "hash": "sha256:…"}
```

Event names: `device.paired`, `device.revoked`, `thread.created`, `tool_call.decided`, `tool_call.finished`, `approval.created`, `approval.decided`, `approval.expired`, `grant.created`, `grant.used`, `grant.revoked`, `credential.filled`, `credential.created`, `credential.deleted`, `purchase.requested`, `purchase.completed`, `message.sent`, `email.sent`, `calendar.changed`, `file.written`, `exec.finished`, `memory.written`, `memory.forgotten`, `connector.connected`, `connector.disconnected`, `channel.sender.paired`, `skill.installed`, `config.changed`, `vault.unlocked`, `export.created`, `reset.performed`. The Permission Broker also writes `approval.invalidated`, `approval.answer_rejected`, `binding.verified`, `binding.mismatch`, `classifier.labeled`, `classifier.circuit_open`, `receipt.recorded` and `receipt.reconciled`.

## 6. Credentials (vault)

`vault/vault.db` is SQLCipher (AES-256-CBC pages, PBKDF2-HMAC-SHA512 with a high iteration count, per-page HMAC). Its key is a random 32-byte value wrapped by the OS keychain (data-protection keychain item with `userPresence`/biometry access control via the mac helper; `safeStorage` elsewhere) plus a printed recovery key. Non-secret metadata is mirrored in the main database for listing without unlocking.

```sql
-- vault.db
items (
  id TEXT PK, kind TEXT,                           -- login | api_key | oauth_token | ssh_key | note | payment_link
  name TEXT, slug TEXT UNIQUE,
  secret TEXT JSON,                                -- {username, password, totpSecret} | {token, headerName} | {accessToken, refreshToken, expiresAt, scopes} | {privateKey} | {text}
  bindings TEXT JSON,                              -- [{origin:"https://github.com"}] | [{host:"api.example.com"}] | [{connector:"google:acct"}]
  created_at, updated_at
)
-- psyche.sqlite (metadata only, no secrets)
credential_meta (
  id TEXT PK, kind, name, slug, bindings TEXT JSON, owner_connector_id NULL,
  last_used_at, use_count INTEGER, created_at, updated_at
)
credential_uses (
  id TEXT PK, credential_id FK, task_id FK NULL, approval_id FK NULL,
  executor TEXT,                                   -- browser | connector | sandbox | ssh
  target TEXT,                                     -- origin/host
  outcome TEXT, created_at
)
```

Placeholder grammar: `{{cred:<slug>}}` (primary secret), `{{cred:<slug>.username}}`, `{{cred:<slug>.totp}}`, `{{cred:<slug>.header}}`. Resolution is performed only by executors and only when the target matches a binding.

## 7. Memory

```sql
memory_chunks (
  id TEXT PK, source TEXT,                         -- workspace path, e.g. "memory/2026-10-18.md" or "MEMORY.md"
  line_start INTEGER, line_end INTEGER, text TEXT,
  provenance TEXT,                                 -- owner | agent | untrusted | system
  claim_id FK memory_claims NULL, token_count INTEGER,
  embedding BLOB NULL,                             -- float32 vector (sqlite-vec virtual table mirrors this)
  created_at, updated_at
)
CREATE VIRTUAL TABLE memory_fts USING fts5(text, content='memory_chunks', content_rowid='rowid');
CREATE VIRTUAL TABLE memory_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[768]);
memory_claims (
  id TEXT PK, text TEXT, kind TEXT,                -- fact | preference | relationship | directive | event
  provenance TEXT, confidence REAL, sources TEXT JSON,
  superseded_by FK memory_claims NULL, retracted_at NULL, created_at, updated_at
)
memory_jobs (id, kind, status, started_at, ended_at, summary, created_at)   -- flush | dreaming | reindex | import; status running | ok | failed | skipped
memory_files (path PK, sha256, bytes, provenance, mtime_ms, indexed_at, created_at, updated_at)  -- per-file index state; external edits count as owner
memory_state (key PK, value JSON, updated_at)                    -- pause flag, vector width, first-run marker
memory_recalls (id INTEGER PK, chunk_id FK memory_chunks, query_hash, created_at)  -- memory_search hits; query stored as sha256 only (dreaming's recall gates)
```

`memory_chunks` also has `embedding_model` (the vector space of `embedding`) and an explicit `rowid INTEGER PRIMARY KEY` (so the FTS5 mapping survives VACUUM; `id` stays the unique text key); chunk ids derive from source, first line and text, so unchanged chunks keep their embedding and claim link across reindexes. `memory_vec` is created at run time when sqlite-vec loads (its width follows the embedder); without it search computes cosine in process. The migration is `packages/db/migrations/202610191230_memory_index.sql` (S07).

Ranking: `score = bm25_norm * 0.4 + cosine * 0.5 + recency(0.5^(ageDays/30)) * 0.1`, with a provenance filter (callers may exclude `untrusted`). Untrusted chunks are never promoted into `memory_claims` with `owner` provenance.

### 7.1 Workspace file formats

`IDENTITY.md`

```markdown
---
name: Pip
creature: a small teal dragon with round glasses
vibe: curious, dry, warm
tagline: "Let's get it done."
emoji: 🐉
avatar: library:01JAX…        # generated or bundled asset id
voice: kokoro:af_heart
---
Pip is …                      # free-form self-description the agent may refine with approval
```

`USER.md` (4,000-char budget)

```markdown
# About the owner
- Name: Pranav. Student at UCSC. Timezone: America/Los_Angeles.
## Directives (dated; latest wins)
- 2026-10-18 active: Keep replies short unless asked for detail.
- 2026-09-02 superseded by 2026-10-18: Always explain reasoning first.
```

`memory/YYYY-MM-DD.md` (append-only daily note; one bullet per entry; provenance tag required)

```markdown
- 09:14 [owner] Prefers window seats; flying to Chicago Nov 3–6.
- 09:31 [agent] Booked nothing yet; found UA 1442 at $218 (hold until approval).
- 14:02 [untrusted:email:alice@example.com] Alice says the slip is due Friday.
```

`MEMORY.md` (curated; written only by dreaming; every bullet ends with a source list)

```markdown
## People
- Alice (kid's teacher): prefers email; replies within a day. [2026-10-18, 2026-10-02]
## Preferences
- Window seats; morning flights; no basic economy. [2026-10-18]
```

`interests.md` (the Feed's interest ledger; editable; one topic per line with a weight and why)

```markdown
- robotics manipulation (0.9) — asked 6 times in Sept; saved 3 arXiv papers
- UCSC events (0.6) — calendar shows campus events
- !exclude: celebrity news — dismissed 4 posts
```

## 8. Connectors, channels, automations, proactive surfaces

```sql
connectors (
  id TEXT PK, type TEXT,                           -- google | microsoft | imap | jmap | stripe_link | mcp | apple:<app> | search:<provider>
  label TEXT, account TEXT, scopes TEXT JSON, scope_mode TEXT,   -- read | read_act
  action_matrix TEXT JSON,                         -- {"gmail.send":"ask","gmail.read":"allow","calendar.delete":"deny"}
  credential_id TEXT NULL, status TEXT, config TEXT JSON,        -- MCP: {transport,url|command,args,trustTier,toolsListHash}
  last_sync TEXT JSON, created_at, updated_at
)
channels (
  id TEXT PK, type TEXT,                           -- webchat | telegram | imessage | whatsapp | signal | slack | discord | email | sms
  account TEXT, dm_policy TEXT,                    -- pairing | allowlist | open | disabled
  allow_from TEXT JSON, group_allow_from TEXT JSON, require_mention INTEGER,
  owner_ids TEXT JSON, dm_scope TEXT,              -- main | per-peer | per-channel-peer
  node_id FK nodes NULL,                           -- iMessage runs on a Mac node
  status TEXT, config TEXT JSON, created_at, updated_at
)
identities (id TEXT PK, display TEXT, links TEXT JSON, delegated_persona TEXT NULL, tool_allow TEXT JSON NULL)
automations (
  id TEXT PK, kind TEXT,                           -- cron | interval | watch | heartbeat | briefing
  title TEXT, schedule TEXT, timezone TEXT,
  session_target TEXT,                             -- main | isolated | named:<id>
  delivery TEXT JSON,                              -- {thread?: id, channel?: id, webhook?: url, none?: true}
  prompt TEXT, scratch TEXT, enabled INTEGER,
  next_run_at, last_run_at, last_status TEXT, created_at, updated_at
)
automation_runs (id, automation_id FK, thread_id FK, started_at, ended_at, status, summary, notification_id NULL)
watches (id, automation_id FK, url TEXT, kind TEXT, selector TEXT, threshold TEXT JSON, last_value TEXT, last_checked_at, failures INTEGER)
feed_posts (
  id TEXT PK, title, body_md, citations TEXT JSON, cluster TEXT JSON,
  score REAL, reasons TEXT JSON,                   -- ["interest: robotics 0.9", "recency 2h", "exploration slot"]
  briefing_id NULL, feedback TEXT NULL,            -- like | save | not_interested | hide_source | follow_topic
  created_at
)
ideas (
  id TEXT PK, kind TEXT,                           -- task | automation | skill | goal | connector
  title, body_md, evidence TEXT JSON, effort TEXT, acceptance_prob REAL,
  status TEXT,                                     -- proposed | accepted | edited | dismissed | expired
  result_ref TEXT NULL, created_at, decided_at
)
goals (
  id TEXT PK, title, category TEXT,                -- health | finance | career | relationships | productivity | learning | home | other
  status TEXT, inferred INTEGER, confirmed_at NULL, plan TEXT JSON, cadence TEXT, next_checkin_at, archived_at, created_at, updated_at
)
goal_milestones (id, goal_id FK, title, due_at, done_at)
goal_links (goal_id FK, task_id FK NULL, automation_id FK NULL, watch_id FK NULL)
notifications (
  id TEXT PK, kind TEXT,                           -- approval | input_needed | task_done | task_failed | proactive | briefing | reminder | system
  title, body, task_id NULL, approval_id NULL, route TEXT NULL, actions TEXT JSON, surfaces TEXT JSON,
  delivered TEXT JSON, read_at, resolved_at,
  stale_at NULL, stale_reason NULL,                -- set by restart reconciliation
  dedupe_key TEXT NULL,                            -- unique among unresolved rows; default "<kind>:<task_id>"
  seq INTEGER,                                     -- inbox order; bumped when a de-duplicated notify replaces the content
  created_at, updated_at
)
notification_deliveries (                          -- one row per notification × surface
  notification_id FK notifications, surface TEXT,  -- desktop | web | notification | <channel>:<peerId>
  status TEXT,                                     -- pending | deferred (quiet hours) | delivered | failed | suppressed
  attempts INTEGER, due_at NULL, delivered_at NULL, detail TEXT NULL, created_at, updated_at,
  PRIMARY KEY (notification_id, surface)
)
```

## 9. Library and artifacts

```sql
library_items (
  id TEXT PK, kind TEXT,                           -- document | image | audio | video | artifact | download | recording | system
  name, mime, path TEXT,                           -- relative to library/
  size INTEGER, sha256 TEXT, origin TEXT,          -- upload | agent | download | connector | channel
  thread_id NULL, task_id NULL, tags TEXT JSON, text_extract_ref NULL, created_at
)
artifacts (id TEXT PK, library_item_id FK, type TEXT,   -- markdown | html | react | pdf | sheet | itinerary | dashboard
           title, version INTEGER, name_slug TEXT, source_ref TEXT, updated_at)
```

### 9.1 Message content blocks

`messages.blocks` is an ordered array of typed blocks; the UI renders each deterministically.

```json
[
  {"type": "text", "md": "Found three options…"},
  {"type": "tool_call", "toolCallId": "…", "tool": "browser.navigate", "status": "ok", "level1": "Opened united.com"},
  {"type": "plan", "planId": "…"},
  {"type": "checklist", "items": [{"text": "Search flights", "status": "completed"}, {"text": "Hold fare", "status": "in_progress"}]},
  {"type": "approval", "approvalId": "…"},
  {"type": "question", "inputRequestId": "…"},
  {"type": "artifact", "artifactId": "…", "preview": "itinerary"},
  {"type": "file", "libraryItemId": "…"},
  {"type": "receipt", "receiptId": "…"},
  {"type": "task", "taskId": "…"},
  {"type": "wrap_up", "recap": "…", "ask": "Hold the 7:05 flight?", "actions": [{"label": "Hold it"}, {"label": "Keep looking"}]}
]
```

## 10. Models, usage, settings, skills, sandboxes

```sql
model_profiles (id, provider TEXT, label, base_url NULL, credential_id NULL, capabilities TEXT JSON, probe_result TEXT JSON, created_at)
model_roles (role TEXT PK, model_ref TEXT, fallbacks TEXT JSON)              -- primary | utility | embedding | vision | speech
usage (id, run_id FK NULL, job TEXT NULL, model_ref, input, output, cache_read, cache_write, reasoning, cost_usd REAL, created_at)
settings (key TEXT PK, value TEXT JSON, updated_at)
skills (id, name, source TEXT, version, path, hash, trust TEXT, enabled INTEGER, installed_at, updated_at)
sandboxes (id, scope TEXT, backend TEXT, container_ref TEXT, workspace_path, network TEXT, status, created_at, last_used_at)
browser_profiles (id, name, partition TEXT, kind TEXT,  -- embedded | playwright | real_chrome
                  created_at, last_used_at)
browser_sessions (id, task_id FK, profile_id FK, tabs TEXT JSON, recording_ref NULL, created_at, closed_at)
vm (id TEXT PK, name, bundle_path, state TEXT, cpu INTEGER, memory_gb INTEGER, disk_gb INTEGER, guest_version TEXT, shares TEXT JSON, created_at)
```

`skills` holds one row per (source, name) with the owner's `enabled` switch and the last seen whole-tree `hash` (`sha256:` over sorted paths, executable bits and contents). The pins live in `$PSYCHE_HOME/skills/skills.lock.json` (`{version, skills: {"home:<name>" | "workspace:<name>": {origin, commit?, version?, treeHash, trust, approvalId, approvedAt, findings}}}`), outside the agent-writable workspace; a workspace or installed skill loads only while its tree hash matches its entry (`packages/skills/README.md`). The unified search index is derived data in `state/search.sqlite` (`search_docs`, `search_fts`, `search_flags`; `packages/search/README.md`).

## 11. Event frames (WS)

```json
{"type": "event", "event": "chat.delta",   "seq": 9912, "stateVersion": 4411, "payload": {"threadId": "…", "messageId": "…", "delta": "…"}}
{"type": "event", "event": "task.updated", "seq": 9913, "stateVersion": 4412, "payload": {"task": { "...": "…" }}}
{"type": "event", "event": "approval.created", "seq": 9914, "stateVersion": 4413, "payload": {"approval": { "...": "…" }}}
```

Results of side-effecting requests are stored in `gateway_idempotency (id, device_id, method, idempotency_key, params_hash, result JSON, created_at)`, unique per device + method + key, in the same transaction as the mutation; a retried key replays the result, a different params hash is `idempotency_conflict`. Kept 7 days.

`stateVersion` increases on every persisted mutation; a client whose last seen version is older than the server's oldest retained event performs a full refresh of the affected collections.

## 12. Retention and cleanup

| Data | Default retention | Control |
| --- | --- | --- |
| Threads and messages | indefinite; incognito 24 h | delete per thread; "also forget" stages memory retraction |
| Tool I/O level-3 payloads and screenshots | 30 days | `cleanupPeriodDays` |
| Browser recordings | off; 7 days when enabled | per task |
| Receipts and audit | indefinite (append-only) | export; never auto-deleted |
| Usage | indefinite (aggregated monthly after 1 year) | — |
| Feed posts | 90 days | — |
| Notifications | 90 days after resolution | — |
| Sandbox workspaces | until thread/project deletion | per sandbox |
| Credential use log | 1 year | — |

Backups include `state/`, `workspace/`, `vault/`, `library/`, `browser/profiles/` (optional) and channel session files; the vault remains encrypted inside the backup.
