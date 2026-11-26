# Night shift: prepare overnight, apply in the morning (2026)

> **Update 2026-11-25: chat channels removed.** Telegram, Slack-as-chat, Discord, WhatsApp, Signal, SMS, email-as-chat, the iMessage chat bridge and WebChat no longer exist (owner decision: the iPhone app is the mobile surface). Mentions of channels, channel delivery, channel senders and `dmPolicy` below are historical. Approvals and briefs go only to the Mac app and the paired iPhone. Reading Messages and Mail and the send-a-message tool stay. See security section 9 in docs/05-security-and-permissions.md.


Status: design, 2026-11-24. Owner request: "Overnight, Psyche prepares everything instead of acting
on it: reply drafts, calendar fixes, filed documents, follow-ups. You wake up to one review screen
with a checkbox per change and an 'Apply selected' button."

Builds on these in-flight PRs and does not redo them:
- #1653: wake detector, boot rerun, `needs_approval` end for unattended runs, live time zone.
- #1649: model retry.
- #1651: history prune and DB maintenance.
- #1644 and #1647: iOS refresh and paging.

Binding owner decisions:
- Approvals are a plain tap.
- Presence is for payments only.
- Browser and computer use are Host-only.
- Free signing (no APNs).
- Remote devices can't open Memory, Messages or Contacts.
- No hosted infrastructure.
- Five places (IA consolidation).

## 1. Decisions at a glance

| Question | Decision |
| --- | --- |
| Staging primitive | A **staging run**: the agent loop records every side-effecting call that passes policy as a `staged_action` (frozen args, binding hash, preview, precondition) and does not run it. It is not built on proposals and has no per-domain draft objects (§2.1). |
| What can be staged | Only an exact-name **allowlist** of write tools with a precheck adapter: mail drafts, calendar create and update on solo events, reminders, and file move and rename in rw-granted folders (§2.3). Everything else is refused in the run. |
| Never staged | Anything financial, a purchase, `AUTH_KINDS`, anything that requires authentication or matches money-intent, browser, computer use, exec, MCP, web fetch and deletes (§3.1). |
| Sends | A send is a separate **"Send it too"** checkbox under its draft. It is never ticked by default and never included in "Select all". It is bound to the draft's content hash (§3.2). |
| Apply | One `staged_apply` approval through the broker, whose children are exactly the selected items' binding hashes. The client answers it with the single-use token, the way `proposals.approve` works today. Every call is re-decided and prechecked at apply time (§3.3). |
| Scheduling | A system automation at the window start (default 01:00–05:00, owner's live zone). Runs only when the Mac is awake, idle and on power or a healthy battery. Never wakes the Mac (§4). |
| Budget | Per night, $0.50 by default, $5 maximum, plus a token ceiling. When nothing is worth doing, it makes no model call, writes no row and sends no notification (§4.4). |
| Review | Mac: a Home section "Prepared overnight" plus a review sheet. iOS: a Home card plus a review screen and a local notification. No new sidebar row (§5). |
| Expiry | Unreviewed items expire after 3 days. Closed reviews are purged after 30 days, and receipts are kept (§7). |
| Default | Off. Turned on in onboarding or in Settings → Daily → Night shift (§8). |

## 2. The staging primitive

### 2.1 Options weighed

| Option | For | Against | Verdict |
| --- | --- | --- | --- |
| **A. Staging run mode in the loop gate** | One interception point covers every domain. It reuses `describeCall`, `paramsHash`, `bindingHash`, the broker's `decide`, taint and the run trace. | Each tool needs a precheck adapter. Dependent chains can't be staged. | **Chosen** |
| B. Reuse `action_proposals` | Has an approval, an executor, per-call results and undo. | It is one approval per proposal with all or nothing per batch, and it refuses `send_email`. It has a 24 h TTL and a 30 s undo, no per-item status, no staleness and no preview. Every row would need four new columns and a different state machine. | No. Reuse its **executor** instead (§3.3). |
| C. One draft object per domain | Natural previews. | Four stores, four apply paths and four security reviews. A new domain means new tables. Nothing catches a tool the model calls outside the draft APIs. | No |

### 2.2 How a staging run works

- **The task carries `staging: {nightId}`, set by the server only.** The Night shift launcher sets it, the same way `runMode` is set today. `tasks.create` from a client can't set it, and the worker passes it to `AgentLoop` as `RunOptions.staging`, a `StagingSink`.
- **Order of checks.** In `#gate` (`packages/agent-core/src/loop.ts`), staging comes after `validate`, `describeCall`, the frozen `structuredClone` args, `paramsHash`, the `before_tool_call` hooks, the plugin hooks, `bindingHash`/`grantKey` and `broker.decide`. It comes before both the allow dispatch and the ask branch (`requestApproval`).
- **What staging does with each call:**
  - `deny`: unchanged. The model gets the denial.
  - `sideEffect` of `none` or `read`: unchanged. Reads run, with taint as usual.
  - Write or higher, not on the allowlist, or never-staged (§3.1): refused with `{staged:false, note:"can't be prepared overnight"}`. Nothing runs and no card is raised.
  - Otherwise `sink.stage(call)` runs and returns a `stagedId`. The model gets `{staged:true, stagedId, note:"recorded for the owner's morning review; it has not happened and returns no result"}` with `isError:false`.
- **Grants don't run anything overnight.** A live `always` grant that would normally let the write run is still staged. Grants and policy are checked again at apply.
- **No set-aside cards.** Staging runs raise no cards, so there is no deferred digest and no resume run for them.
- **The prompt** is `buildUnattendedPrompt` plus one paragraph: "Prepare, don't act. Each change is recorded for the morning and does not happen now. Make each change one complete call. Don't plan steps that need an earlier change's result. If nothing is worth doing, end with NO_REPLY."
- **`sink.stage` work** (Gateway side, `packages/proactive/src/night-shift/stager.ts`):
  - It runs the tool's precheck `capture` (read-only calls through the registry), which records the precondition, the "before" snapshot for the preview and the undo data.
  - It renders the preview.
  - It applies the one-per-target rule (§2.4).
  - It writes the row. A failed capture refuses the stage, and the model is told the change couldn't be prepared.

### 2.3 Stageable allowlist (exact tool names, after connector prefixing)

| Domain | Tools | Precondition captured | Stale when | Undo |
| --- | --- | --- | --- | --- |
| Mail | `mail_reply_draft`, `mail_draft`, `gmail_create_draft`, `mail_create_draft` | Thread's newest message id and count. Recipients must be the thread's participants. | A new message arrived in the thread, or the thread is gone. | None (no draft-delete tool). "Open in Mail" instead. |
| Mail send (recipe) | `mail_send_draft` / `gmail_send` on the draft the item saved | Draft content hash: to, cc and bcc, subject, body, in-reply-to and attachments | The saved draft doesn't match the hash. | None. A send is final. |
| Calendar | `calendar_create_event`, `calendar_update_event`, only for events with **no other attendees** | Event etag or `updatedAt`, plus the fields the update touches (the "before") | etag changed, event gone, or another attendee was added. For a create: an event with the same title and start already exists. | Update: restore the snapshot. Create: delete it (a destructive child, explicit tick). |
| Reminders | `reminders_create`, `reminders_update`, `reminders_complete` | Modification date plus a snapshot | Changed or gone. For a create: a duplicate title in the same list. | Create: delete. Complete: uncomplete. Update: restore the snapshot. |
| Files | `files_move`, `files_rename` inside rw-granted folders | Source `dev:ino`, size and mtime (fd-based, `psyche-permissions` §3d). Destination parent realpath. Destination absent. | Any of those differ, or the grant no longer covers the paths at use time | Move back if the destination's `dev:ino` still matches and the old path is free. |

Not stageable in v1:
- forward drafts (an exfiltration path);
- reply drafts that add a recipient;
- calendar changes to events with other attendees, because those notify people;
- deletes;
- Messages and iMessage;
- notes, `write_file` and `edit_file`;
- every MCP tool (unknown semantics);
- everything in §3.1.

A new tool joins only with an adapter (`capture`, `check`, `preview`, `inverse?`) and a test.

### 2.4 Dependencies, conflicts and replay

- **No model-made chains.** A staged call returns no result, so the model can't use a created id. The only dependent step is the system's own **send recipe**: draft first, then send the draft that call created, checked against the content hash.
- **One item per target per night.** The target key is the thread id, event id, reminder id or file `dev:ino`.
  - For calendar and reminders, a later call on the same target replaces the earlier one. The earlier one is marked `superseded` and is not shown.
  - Files fold instead: a move or rename whose source is an earlier item's staged destination folds into that item, with the final path.
- **Replay at apply.** Each selected item runs in this order:
  1. `check(precondition)`. Stale means not applied, with the reason shown. Nothing is rebased automatically.
  2. `broker.decide` under today's policy. Deny means `blocked`.
  3. The `staged_apply` approval (§3.3).
  4. Execution in staged order.

  A stale item can be dismissed or opened in Chat with a prefill. There is no "re-prepare" in v1.

## 3. Scope and safety

### 3.1 Never staged, never applied in bulk

The following are refused in the gate, refused again in `requestStagedApply`, and tested on both paths:
- `sideEffect: financial`;
- `kind: purchase` and every `AUTH_KINDS` kind;
- `requiresAuthentication`;
- money-intent (`isMoneyToolName`, `isMoneyText` on the summary and the string args).

Out of scope overnight: browser, computer use (including `MachineRouter` paired machines), exec, MCP and web fetch. These tools are **not registered** in staging tasks. A domain-limited toolset is built per job, which is stronger than refusing calls.

### 3.2 Sends to people

- **Two checkboxes per draft.** A reply draft item has "Save draft", ticked by default, and "Send it too", never ticked by default.
- **Protocol keeps sends separate.** `nightShift.apply` takes `sends: [{itemId, sendHash}]` apart from `items`. A client can't send by selecting all.
- **The approval lists each send.** Each send appears as its own row, "Send to a@x, b@y", in the approval details.
- **The send child binds content, not an id.** Its binding hash covers the content hash, not a draft id that doesn't exist yet. Before `mail_send_draft`, the executor reads the saved draft back and compares the hash. A mismatch means it is not sent.
- **The send needs its draft.** If the draft failed, the send is `skipped`.

### 3.3 Apply goes through the broker

**New broker method `requestStagedApply(children, details, context)`** in `packages/permissions/src/broker.ts`. It is modelled on `requestBatch`:
- 1–50 children, each re-decided with `decide`.
- **Per-child refusal.** A refused child is returned in `refused[]` instead of failing the whole batch.
  - Allowed: write children, and `send_email` (destructive) children only when they are marked `explicitSend` and carry recipients.
  - Refused: every other destructive child except an undo inverse (§5.4), plus §3.1 and the other `DEVICE_ONLY_KINDS`.
- **Approval fields:**
  - `kind: "staged_apply"` (new `ApprovalKind`);
  - `riskClass: "sensitive"` (never "Approve all routine");
  - `scopesOffered: ["once"]`, no grant;
  - `deviceOnly` when any child is destructive, so it is never answerable in a chat channel;
  - `requiresAuthentication` is always false (a child that would need it was refused);
  - TTL 10 min.
- **Children are minted like `batchChildren`, with `requestedBy.toolCallId` = the staged item id.** That satisfies the connector registry's `toolCallId === callId` check. Each child is consumed once by `verifyBinding` and re-checked by the connector executor. The receipt carries the child's `approvalId`.

**Execution.** The `#run` loop in `packages/proactive/src/proposals/service.ts` is extracted into `packages/proactive/src/exec/run-children.ts` and shared by proposals and Night shift. It returns per-child results, writes a receipt when the tool writes none, and records `uncertain` on a mid-flight throw.

**The answer path is the existing one.** `nightShift.apply` returns `{approval, answerToken, refused}`. The client then:
1. checks that the approval's `details.items[].bindingHash` set equals exactly what it showed and the owner ticked;
2. only then calls `approvals.answer` with the token.

The broker applies its usual answer rules: `local` from the connection, device-only, scope and lockout. No new answer path is added.

**Why the tap is the owner's approval for exactly those actions.** The review screen shows each action with its full preview, and its hash is the call's `bindingHash`. Several checks bind the tap to those actions:
- the approval binds the set of child hashes;
- the client refuses to answer if the set differs;
- `verifyBinding` and the connector re-check refuse any call whose args differ.

So a refreshed, edited or substituted call is not covered. This is a plain tap because nothing in the set can need presence (§3.1), which matches what an approval card's tap already approves today.

### 3.4 Prompt injection overnight

- **Mail jobs are tainted.** They read other people's mail, so their items carry `taint` and `taintSources`, and the review shows "Based on mail from x".
- **Stage-time limits** keep an injected instruction from widening reach: no forwards, no new recipients, calendar only on solo events, files only under rw grants.
- **Applies to new recipients carry a badge.** An apply that would send to an address the owner has never written to shows a "New recipient" badge.
- **"Why" lines** are one sentence, redacted then truncated, and never treated as instructions.

## 4. Scheduling

### 4.1 Window

- **Settings:** `nightShift.window.start` (default `01:00`) and `nightShift.window.end` (default `05:00`), in the owner's live zone from #1653.
- **The automation.** One system automation, `kind: cron`, prompt marker `[psyche:night-shift]`, at the window start. `withProactiveJobs` intercepts it and runs `NightShiftService.run()` in-process.
- **Jobs.** The service launches one small staging task per candidate, one at a time:
  - `mode: unattended`, `createdFrom: "automation"`;
  - per-job budget of 8 steps, 30k tokens and 120 s.
- **Stops** at the window end.
- **Restarts.** The candidate list is persisted on the night row, so the #1653 `rerunOnInterrupt` hook resumes after a Gateway restart inside the window.

### 4.2 Mac asleep

- **It never wakes the Mac.** No `pmset schedule` (it needs root and changes system settings), and no new IOPM assertions.
- **Awake at the window start:** for the length of its own run, Night shift asks the existing `KeepAwake` (`caffeinate -i -w <pid>`, `packages/scheduler/src/keep-awake.ts`) to hold idle sleep, **only on AC power**. This holds whatever `scheduled.keepAwake` says, and it is released when the run ends. A closed lid on battery still sleeps.
- **Asleep at the window start:**
  - The #1653 wake detector calls `scheduler.wake()`, which coalesces the missed tick.
  - The service runs only if the wake is **inside the window** and the gates pass.
  - Otherwise the night is recorded `skipped: asleep`, with no notification. Open question 2 covers this.

### 4.3 Power and thermal gates

These reuse `readSystemState()` (`apps/gateway/src/compose/everything-probe.ts`) the way the memory pass's `checkGates` does.
- **Start:**
  - on AC, or battery ≥ 50% and not in Low Power Mode;
  - thermal `nominal` or `fair`;
  - owner idle ≥ 10 min.
- **Between jobs, stop when:**
  - battery < 30%;
  - Low Power Mode is on;
  - thermal is `serious` or worse.
- **Owner active (idle < 2 min):** pause until idle again, within the window.
- **Stop reasons** are stored on the night row.

### 4.4 Budget and "nothing to do"

- **Spend cap.** `nightShift.budgetUsd`, default 0.50, with a schema maximum of 5.00.
  - Spend is metered from the jobs' usage events, priced by the model-router tables. `UsageLedger` is not wired in the Gateway today, so it isn't relied on.
  - No new job starts when what is left is below one job's worst case.
  - A ceiling of 400k tokens per night also binds local or unpriced models.
- **Retries.** Transient model errors use #1649.
- **Candidates are deterministic. No model is used to find work:**
  - Mail: quiet threads (`mailFollowups`, `no_reply` and `unanswered_question`), at most 8.
  - Follow-ups: commitments due from `daily.followups`, which become `reminders_create`, at most 6.
  - Calendar: overlapping or duplicate solo events in the next 3 days, at most 4.
  - Files: files older than 1 day at the top level of rw-granted Downloads or Desktop, at most 10.
- **No noise.**
  - Zero candidates: no model call, no visible row and no notification.
  - Zero staged items: the night is stored as `empty` for diagnostics only.
  - The brief and Home say nothing in either case.
  - A stop for budget or power adds one brief line only when something was still prepared.

## 5. The morning review

### 5.1 Mac (Electron and web)

- **Home section `night-shift`**, placed directly after `needs-you` and shown only while a review is `ready`:
  - title "Prepared overnight";
  - counts per domain ("3 reply drafts · 2 calendar fixes · 1 filed document");
  - the first 3 one-liners;
  - a **Review** button.

  It follows the ink direction: one accent, on Review.
- **Review sheet.** A modal over Home, with deep link `/home?review=<id>`. Search ⌘K gets a "Review overnight changes" command. No sidebar row.
- **Item rows.** Grouped by domain. Each row has a checkbox, a one-line summary, badges (Stale, Untrusted source, New recipient) and an expander:
  - Mail: recipients, subject and body.
  - Calendar: before → after for each changed field.
  - Files: from path → to path.
  - Reminders: the fields.

  Stale items show their reason and can't be ticked.
- **Footer:** "Select all" (never sends), **Apply selected (N)** and "Dismiss the rest".
- **After apply,** each row shows applied, failed (reason), uncertain ("Check in Mail") or skipped, plus **Undo** where an inverse exists.

### 5.2 iOS

- **Home card** "Prepared overnight", which pushes `NightShiftReviewView`. It is the same list with the same rules and uses #1644/#1647 refresh and paging.
- **Answering.** It uses the `approveSuggestion` pattern. When `detailsNeedMac` applies, it shows "Open on your Mac"; it never weakens.
- **Local notification:**
  - `BackgroundRefresh.backgroundCheck()` and app-foreground read `nightShift.status`.
  - When a review is `ready`, it posts one local notification (new category `review`, dedupe per review id), held until quiet hours end. Tapping it opens the review.
  - It is best effort, because BGAppRefresh may not run (no APNs, free signing).
- **No why lines from owner-only sources.** A remote device gets no "why" line that cites Memory, Messages or Contacts; the Gateway strips them.

### 5.3 Partial failure

- **Each child is independent,** except that a send depends on its draft.
- **A failure before any effect** (`BeforeEffectError`, #1653) returns the item to `ready`, so it can be ticked again.
- **A mid-flight throw** becomes `uncertain`, is never retried automatically, and points to the app.
- **The review's status** becomes `applied` or `partial`.

### 5.4 Undo

- **Availability.** Per item, for 24 h after apply, when the inverse in §2.3 exists and the target is unchanged since apply (precheck against the post-apply state).
- **It uses the same apply path:** a `staged_apply` approval of the inverse calls.
- **Exception to the no-destructive rule.** An inverse may be destructive: deleting an event or reminder that Night shift itself created. That is allowed only as an undo child bound to the created id, and it is always device-only.
- **No undo** for drafts or sends.

### 5.5 Expiry and the brief

- **Expiry.** Unreviewed items expire after `nightShift.expiryDays` (default 3, range 1–7). Expiry clears `params` and the preview and keeps the counts.
- **Brief line.** The morning brief gets `DailySectionId` `night_shift`, one line from a template: "Night shift prepared 6 changes: 3 reply drafts, 2 calendar fixes, 1 filed document." It links to the review and is absent when there's nothing.
- **Notifications.** The Mac notification is one `briefing` per night (`nightshift:<date>`), held through quiet hours.

## 6. Data model and protocol

### 6.1 Tables

One migration `<ts>_proactive_night-shift.sql` plus a drizzle mirror (`schema-parity.test.ts`), following the `packages/db` conventions.

**`night_shift_nights`:**
- `id`, `night` (local date, unique);
- `status` (`running|done|stopped|skipped|empty`), `stop_reason`;
- `candidates` (JSON), `spent_usd`, `tokens`;
- `review_status` (`none|ready|partial|applied|dismissed|expired`), `expires_at`;
- `started_at`, `finished_at`, `created_at`, `updated_at`.

**`staged_actions`:**
- `id`, `night_id` (FK), `seq`, `domain` (`mail|calendar|reminders|files`), `target_key`;
- `tool`, `kind`, `side_effect`, `target` (JSON), `params` (JSON), `params_hash`, `binding_hash`;
- `summary`, `preview` (JSON), `why`, `precondition` (JSON), `inverse` (JSON), `send` (JSON `{recipients, contentHash}`);
- `taint`, `taint_sources`;
- `status` (`ready|stale|superseded|applied|failed|uncertain|skipped|dismissed|expired|undone`), `result` (JSON `{receiptId, refs, error}`);
- `approval_id`, `task_id`, `tool_call_id`, `applied_at`, `created_at`, `updated_at`.

Uniqueness: `UNIQUE(night_id, target_key)` among live statuses, as a partial index.

### 6.2 Methods (`packages/protocol/src/methods/night-shift.ts`)

| Method | Scope | Side-effecting | Notes |
| --- | --- | --- | --- |
| `nightShift.status` | operator.read | no | enabled, next window, latest night summary, ready review id |
| `nightShift.review.get` | operator.read | no | the night plus items. Why lines from owner-only sources are stripped for non-desktop-shell callers. |
| `nightShift.apply` | operator.approvals | yes (idempotency key) | `{reviewId, items:[{itemId, bindingHash}], sends:[{itemId, sendHash}]}` returns `{approval, answerToken, refused}` |
| `nightShift.undo` | operator.approvals | yes | `{itemIds}` returns `{approval, answerToken, refused}` |
| `nightShift.dismiss` | operator.write | yes | `{reviewId, itemIds?}` |
| `nightShift.runNow` | operator.admin | yes, `callsModel` | Settings "Try it now". Same gates except the window and idle. Counts against the night's budget. |

Events: `nightShift.updated` `{night}` and `nightShift.item.updated` `{item}`. `ApprovalKind` gains `staged_apply`, and `DailySectionId` gains `night_shift`, with Swift exhaustive switches updated.

**Scopes.** An `operator.write` device can read and dismiss but can't apply. Apply needs `operator.approvals`, the scope `approvals.answer` itself needs, so a device can apply exactly what it could approve by tapping a card. Idempotency uses the existing `gateway_idempotency`: a replayed apply returns the same approval and token without minting a second one.

## 7. Privacy and logging

- **Read overnight,** under existing grants only:
  - candidate mail threads, through the existing tainted read tools;
  - solo calendar events in the next 3 days;
  - reminders;
  - names, metadata and first-page text of candidate files in rw-granted folders;
  - accepted Memory facts through the normal context.

  Messages and Contacts are not read. Incognito threads are never touched.
- **Stored:** staged args (draft bodies included), previews, the precondition snapshots, why lines, counts and spend. The mail bodies read stay only in the task transcript, under the existing tool-payload retention (`cleanupPeriodDays`).
- **Retention:**
  - Expiry clears args and previews.
  - Nights and items are deleted 30 days after the review closes, through #1651's `history-prune` batches.
  - Receipts and audit rows are never pruned (unchanged).
- **Logs** carry ids, counts, tool names and stop reasons, never args, previews or why lines. Staged calls appear in the run trace as `staged` events.

## 8. Settings and copy

Settings → Daily gets a new group "Night shift". Onboarding gets one optional, skippable card, "Prepare things overnight?", which is off unless the owner turns it on. Flat keys, like `daily.*`:

| Key | Default | Notes |
| --- | --- | --- |
| `nightShift.enabled` | `false` | The first-run text says what it reads and that nothing happens until Apply. `nightShift.consentedAt` is stored. |
| `nightShift.window.start` / `.end` | `01:00` / `05:00` | Must leave at least 1 h. Shown in the owner's zone. |
| `nightShift.domains.mail` / `.calendar` / `.reminders` / `.files` | `true` each (once enabled) | Files also needs an rw folder grant, and the group links to it. |
| `nightShift.budgetUsd` | `0.50` | Range 0.05–5.00 |
| `nightShift.expiryDays` | `3` | Range 1–7 |
| `nightShift.notify` | `true` | The Mac notification and the iOS local notification |

**Not a security setting.** Enabling it grants nothing, because apply still asks, so it is not sealed.

**Copy.** All copy goes in all 10 languages:
- `packages/ui` i18n under `nightShift.*`, `settings.nightShift.*`, `daily.section.night_shift` and `notice.nightShift.*`;
- iOS `Localizable.xcstrings`;
- `pnpm i18n:check`.

## 9. Builder wave plan

| Wave | Owns (files and packages) | Done means | Depends on | Security review |
| --- | --- | --- | --- | --- |
| **W0 Protocol and DB** | `packages/protocol/src/{methods/night-shift.ts,schemas/night-shift.ts,events.ts}`, `ApprovalKind` and `DailySectionId` additions, `packages/db/migrations/*_proactive_night-shift.sql`, the `packages/db/src/schema-*.ts` mirror, generated Swift, and the Swift exhaustive switches in `apps/mac-helper` and `apps/ios` | `protocol:check` and `schema-parity` pass. Real-SQLite write-then-read of every column. Swift builds. | none | no |
| **W1 Loop staging** | `packages/agent-core/src/loop.ts` (`#gate` staging branch), a new `packages/agent-core/src/staging.ts` (sink interface, allowlist, never-staged rules), and the server-only `staging` field in `packages/tasks` | Table tests: every allowlisted tool stages; near-misses (`mail_send`, `calendar_delete_event`, forward, MCP, money names, `purchase`, `AUTH_KINDS`) are refused. Grants don't run anything. Reads run. Hooks still block. A client can't set `staging`. | W0 | **yes** |
| **W2 Broker `requestStagedApply`** | `packages/permissions/src/broker.ts` (new method and children), `kinds.ts` (`staged_apply`), tests | Per-child refusal for every §3.1 class. `send_email` only when explicit. Destructive refused except undo inverses. Not bulk-routine. `deviceOnly` with sends. Child `toolCallId` = item id. `answer-lockout` and the batch suites pass, and `--related` runs. | W0 | **yes** |
| **W3 Prechecks and previews** | `packages/proactive/src/night-shift/adapters/{mail,calendar,reminders,files}.ts` (capture, check, preview, inverse) | Each adapter has stale and fresh rows. Files are fd-based with `dev:ino`, never fall back to a path, and use the §3d folding. Calendar refuses events with attendees. Mail refuses added recipients. | W0 | **yes** (files and mail recipient rules) |
| **W4 Service and scheduling** | `packages/proactive/src/night-shift/{service,candidates,stager,store,gates,budget}.ts`, `apps/gateway/src/compose/night-shift.ts`, the keep-awake hook in `packages/scheduler/src/keep-awake.ts`, the brief section in `packages/proactive/src/daily/service.ts`, the notification | Fake clock and fake connectors. Zero candidates make no model call. The budget stops new jobs. Gates (battery, thermal, idle) are covered. Asleep through the window records a skip. Restart resumes. The brief line appears only with items. | W0, W1, W3, and #1653 merged | no |
| **W5 Apply, undo, dismiss** | `packages/proactive/src/night-shift/{apply,handlers}.ts`, `packages/proactive/src/exec/run-children.ts` (extracted from `proposals/service.ts`), the prune hook (after #1651) | The send recipe checks the content hash before sending. Stale and denied items aren't applied. Partial results are correct. The proposals suites are unchanged. Idempotent replay. Undo through the same path. An e2e test (`apps/gateway/test/night-shift.test.ts`) stages, applies some, and undoes. | W2, W3, W4 | **yes** |
| **W6 Mac and web UI** | `packages/ui/src/night-shift/*` (Home section, review sheet, rows, previews, data hook and mock), the `HomeScreen.tsx` insert, the ⌘K command, the Settings group in `screens/settings/DailySection.tsx`, the onboarding card, 10-language i18n | Mock-backed tests. The client refuses to answer when the approval's hash set ≠ the selection. Select all skips sends. Stale rows can't be ticked. Browser-preview screenshots. | W0 (builds against mocks). Merges after W5. | yes (answer path only) |
| **W7 iOS** | `apps/ios/.../Home/NightShift*`, `GatewayBackend+NightShift.swift`, `FixtureBackend`, the `backgroundCheck` and `review` notification category, `Localizable.xcstrings` | Simulator run on fixtures. The same hash check before `approvals.answer`. `detailsNeedMac` goes to the Mac. One notification per review. | W0. Merges after W5. | yes (answer path only) |

Parallelism:
- W1, W2 and W3 run in parallel after W0.
- W6 and W7 run in parallel after W0, because their file sets are disjoint.
- W4 waits for W1, W3 and #1653.
- W5 is last before UI merges.
- `docs/05-security-and-permissions.md` gets a §3.x "Staged apply" section in W2.

## 10. Not in this version

- Editing a draft in the review (save the draft, edit it in Mail, send it yourself).
- Re-preparing stale items.
- Messages and iMessage drafts.
- Calendar changes that notify attendees, and declines.
- Deletes.
- Forwards.
- MCP tools.
- A model pass to find work.
- Waking the Mac on a schedule.
- Parked, never designed here: PayPal, per-store checkout, order tracking from mail.

## 11. Tests (beyond each wave's "done")

- **Two-way probe tables** for the allowlist and the never-staged rules: snake_case and camelCase names, connector-prefixed names, and money labels with amounts.
- **Each §3.1 prohibition gets a test** through every new path: gate, `requestStagedApply`, apply and undo.
- **The binding** refuses a changed arg, a swapped item, a replayed token and a second consume.
- **Remote callers** never get owner-only why lines.
- **Expiry** clears params.
- **Logs** contain no args.

## 12. Open questions for the owner

1. **Window.** Is 01:00–05:00 local right? *Default: yes.*
2. **Mac asleep through the window.** Should it skip that night, or run at the first wake before 09:00? *Default: skip.* A run at wake competes with you at the keyboard, and it never wakes the Mac.
3. **Budget.** Is $0.50 a night right (adjustable up to $5)? *Default: $0.50.*
4. **Domains when turned on.** All four (mail drafts, calendar fixes, filing, reminders), or mail drafts only at first? *Default: all four.* Filing still needs a folder grant.
5. **Expiry.** Should unreviewed items expire after 3 days or 7? *Default: 3.*
