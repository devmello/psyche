# Fork a plan: work out two futures side by side (2026)

> **Update 2026-11-25: chat channels removed.** Telegram, Slack-as-chat, Discord, WhatsApp, Signal, SMS, email-as-chat, the iMessage chat bridge and WebChat no longer exist (owner decision: the iPhone app is the mobile surface). Mentions of channels, channel delivery, channel senders and `dmPolicy` below are historical. Approvals and briefs go only to the Mac app and the paired iPhone. Reading Messages and Mail and the send-a-message tool stay. See security section 9 in docs/05-security-and-permissions.md.


Status: design, 2026-11-24. Owner request: "Split a chat into two plans ('move to Austin' vs 'stay').
Psyche works out both and compares them side by side: costs, dates, which people are affected, what
you'd give up." The owner said: "Do fork a plan."

Builds on these and does not redo them:
- [night-shift-2026.md](night-shift-2026.md) (#1656): the **staging run**, `StagingSink`, the
  stageable allowlist, `staged_actions`, `requestStagedApply` and the shared executor
  `packages/proactive/src/exec/run-children.ts`. A fork is a staging run that carries a fork id
  instead of a night id, and "Take this plan" is a staged apply.
- `threads.fork` (`apps/gateway/src/handlers/threads.ts`) and `copyMessagesForFork`: history up to a
  message, copied verbatim with provider-native turns.
- Specialists (`apps/gateway/src/compose/specialists.ts`): a `subagent` thread plus a task, run in
  their own `TaskWorkerPool` claimed by origin.
- `forViewer` (`apps/gateway/src/compose/life-answer-chat.ts`): a cited fact is shown to a
  connection only if it can open every source the fact cites.

Binding owner decisions:
- Approvals are a plain tap. Presence is for payments only.
- Browser and computer use are Host-only.
- Remote devices can't open Memory, Messages or Contacts.
- No hosted infrastructure. Free signing (no APNs).
- Five places. This lives inside Chat, with no new sidebar row.
- Parked, not designed here: PayPal, per-store checkout, order tracking.

## 1. Decisions at a glance

| Question | Decision |
| --- | --- |
| Fork model | A **plan fork** hangs off one message of a chat. Each branch is a hidden child thread (kind `subagent`) holding the parent's history up to that message, plus one premise. The parent gets one fork card at the fork point (§2). |
| Branches | 2 to 4, default 2. Each has a short label ("Move to Austin") and a premise ("Assume we move to Austin by June"). |
| How they run | One leased task per branch, all queued at once, in a dedicated `fork` worker pool (2 slots, 1 for a local model). Each branch is **one task turn**, then a single comparison pass (§2.3). |
| Safety | Each branch is a **staging run** with `staging: {kind:"fork", forkId, branchId}`, set by the server only. Reads run. Writes on the Night shift allowlist are staged with previews. Other writes are refused and become plan steps. Nothing happens in the world while a fork runs (§3). |
| Not registered in branches | Browser, computer use, paired machines, exec, MCP, and every tool Night shift §3.1 never stages. `web_fetch` only fetches a URL a `web_search` in the same branch returned (§3.2). |
| No cards | A branch never raises an approval card. A read that would ask is refused and turns into an open question (§3.3). |
| Report | Each branch ends by calling `fork_report` once: steps, costs, dates, people, trade-offs, risks and open questions, each with citations to tool calls in that branch (§4.1). |
| Citations | The Gateway checks every citation against the stored tool results. A cost or date the sources don't contain is labelled **Estimate**. A person links to a Memory person only by a validated id (§4.2). |
| Comparison | One model call, no tools, over the checked reports. It aligns items into rows and writes short notes. It never writes a number: values and totals come from the reports and from code (§4.3). |
| Take this plan | One tap on a branch. Its selected staged items go through `requestStagedApply` (one `staged_apply` approval, the Night shift path). The rest of its steps go into the parent chat as a plan, and Psyche carries them out with the usual per-action approvals (§3.4). |
| Cost | Per fork, $1.00 by default, $5 maximum, plus a 400k-token ceiling. The estimate shows before you start. Cancel stops every branch at once (§6). |
| Mac UI | "Fork a plan…" in the message menu and `/compare` in the composer. A fork card in the transcript opens the **Plans** view in the chat pane: lanes, comparison, Take (§5.1). |
| iOS | View forks and comparisons, start one from a message, and Take. Items that cite Memory, Messages or Contacts are withheld from the phone (§5.2). |
| Default | On. Nothing runs until you fork. |

## 2. Fork model

### 2.1 Options weighed

| Option | For | Against | Verdict |
| --- | --- | --- | --- |
| **A. One child thread per branch** | Reuses `copyMessagesForFork`, the task engine, leases, cancel and restart recovery. Each branch's premise and tool results stay out of the other branches and out of the parent. Run trace and taint work per thread unchanged. | N copies of the history rows. Branch threads must be kept out of the sidebar, search and Memory learning. | **Chosen** |
| B. Branches inside one thread | No copies. One transcript. | The loop has one writer per thread (`active_writer_run_id`), so branches can't run in parallel. Premises leak between branches through the shared context. Taint from one branch would taint the whole chat. | No |
| C. Subagents in one parent turn (`subagent.spawn`, `context: "fork"`) | Already exists. | Subagents have no approval authority and die with the parent turn. They can't outlive the turn, be cancelled one at a time, or keep their own budget. | No |

### 2.2 Creating a fork

- **The fork point is a message** in a `main` or `side` thread the owner owns. Forks are refused on incognito, `channel`, `automation` and `subagent` threads, and on a thread with a run writing (`active_writer_run_id`). The owner waits for the reply or stops it.
- **Premises.** The owner gives 2 to 4 options. Each has a label (1–40 characters) and a premise (1–280 characters).
  - The sheet prefills two options from the thread with one cheap utility-model call (`planForks.suggest`). The owner edits them before starting. This call is optional, and its output is only a suggestion in the sheet.
  - `/compare Move to Austin | Stay` fills the labels from the command and skips the suggestion.
- **What `planForks.create` does**, in one transaction:
  1. writes the `plan_forks` row and one `plan_fork_branches` row per option;
  2. for each branch, creates a `subagent` thread with `parent_thread_id` = the parent, `forked_from_message_id` = the fork point, the parent's `spaceId`, `modelRef` and `permissionMode`, and copies the history with `copyMessagesForFork`;
  3. creates one task per branch with `createdFrom: "fork"`, `mode: unattended`, the server-only `staging` field and the branch budget (§6);
  4. appends a `plan_fork` block to the parent thread at the end (not at the fork point, which keeps `seq` append-only). The block holds only `{forkId}` and the UI reads the rest.
- **One running fork per thread** (partial unique index, §7.1), and at most 3 forks running at once overall.
- **The parent stays usable.** A fork is a snapshot at the fork point. Messages sent in the parent later are not seen by the branches.

### 2.3 How a branch runs

- **One task turn.** The worker runs the turn with `RunOptions.staging` set to a `ForkStagingSink` (§3.1). There is no second turn. A branch that hits its step cap without a report gets one forced `fork_report` call from the budget reserve (tool choice pinned). If that fails, the branch is `failed: no_report`.
- **The prompt** is `buildUnattendedPrompt`, then the Night shift paragraph ("Prepare, don't act…"), then a fork paragraph:
  > You are working out one option the owner is weighing. Assume, for this plan only: «premise». It is a hypothesis, not a fact: don't record it anywhere as true. Find what the option would cost, the dates and deadlines it sets, the people it affects and what it gives up, using the owner's memory, calendar, mail and the web. Cite the tool results you used. When a number isn't in a result, mark it as an estimate. Finish by calling fork_report once.

  The premise goes in a fenced block with its value JSON-quoted (`psyche-permissions` §3e). It is the owner's text, so it isn't tainted, but it is framed as a hypothesis.
- **Parallel, capped.** All branches are queued at once. The `fork` pool runs 2 at a time, or 1 when the thread's model is local (a local model in parallel would overload the Mac). The chat task pool gets `excludeOrigins: ["subagent", "fork"]`, so forks never take a chat task's slot.
- **Kept out of everything else.** A branch's transcript is speculative ("assume we move"). Branch threads are left out of:
  - `threads.list` and the sidebar (`NOT EXISTS` on `plan_fork_branches.thread_id`);
  - the search index and Search ⌘K;
  - Memory learning, daily notes and thread-end extraction;
  - Home, Feed and nudges.

  A test covers each consumer. Fork data reaches Memory only when you take a plan, and then only through the parent chat.

### 2.4 States

- **Fork:** `running` → `comparing` → `ready` → `taken` | `dismissed` | `expired`, plus `cancelled` and `failed` from any live state.
- **Branch:** `queued` → `running` → `reported` | `failed` | `cancelled` | `budget_stopped`.
- **Comparing** starts when every branch has ended and at least 2 have `reported`. With fewer than 2 reports, the fork is `failed` and the card shows each branch's reason. "Retry branch" re-queues a failed branch once, inside what is left of the budget.
- **Ready forks expire** after `forks.expiryDays` (default 7). Expiry ends their staged items the Night shift way (params and previews cleared). The comparison stays readable until the fork is purged (§8).

## 3. Safety

### 3.1 A branch is a staging run

This is the Night shift primitive (night-shift-2026.md §2.2), with one change: the task's `staging` field is a discriminated union.

```ts
type Staging =
  | { kind: "night"; nightId: string }
  | { kind: "fork"; forkId: string; branchId: string };
```

- **Set by the server only.** `planForks.create` sets it. `tasks.create` from a client can't. The worker passes `RunOptions.staging`.
- **Same place in `#gate`**: after `validate`, `describeCall`, the frozen args, `paramsHash`, hooks, plugins, `bindingHash` and `broker.decide`. Before the allow dispatch and the ask branch.
- **Same rules per call:**
  - `deny`: unchanged.
  - `none` or `read`: runs, with taint as usual (but see §3.3 for reads that would ask).
  - A write on the Night shift stageable allowlist (§2.3 there): staged through the same adapters (`capture`, `check`, `preview`, `inverse`). It is a `staged_actions` row whose origin is this branch.
  - Any other write or higher: refused with `{staged:false, note:"not prepared in a plan; add it as a step"}`. The model lists it as a `fork_report` step instead.
- **Grants run nothing.** A live `always` grant still stages.
- **The one-per-target rule is per branch.** Two branches may stage the same target. Only the taken branch's items can be applied, and the others are `dismissed` on Take.
- **Only the sink differs.** `ForkStagingSink` (`packages/proactive/src/forks/stager.ts`) writes rows with `fork_branch_id` set instead of `night_id`. It calls the same adapter functions as the Night shift stager, from the same module. There is no second allowlist, no second adapter set and no second apply path.

### 3.2 The branch toolset

The tools are built per branch, which is stronger than refusing calls (Night shift §3.1):

| Registered | Notes |
| --- | --- |
| `memory_recall` and the Memory read tools, people lookup | Read |
| Calendar reads: `calendar_list_calendars`, `calendar_list_events`, `calendar_free_busy`, `calendar_find_free_time` | Read |
| Mail search and read: `mail_search`, `mail_search_messages`, `gmail_search_threads` and the read-thread tools | Read, tainted |
| Contacts and Messages reads, where connected | Read. Owner-only sources for remote viewers (§4.4). |
| `web_search` | Read, tainted |
| `web_fetch` | Only for a URL that a `web_search` result in the same branch returned, by exact match after canonicalisation. A model-built URL is refused, which closes the exfiltration path of a tainted branch writing Memory facts into a query string. |
| The Night shift stageable tools | Staged, never run |
| `fork_report` | `FORK_ONLY`, like `PLAN_ONLY`: hidden outside fork runs, `sideEffect: none` |

Not registered: browser, computer use (including `MachineRouter` machines), exec, MCP, `write_file`/`edit_file`, notes, `ask_user`, `exit_plan_mode`, `task.start`, `subagent.spawn`, `specialist.spawn`, `schedule`, `notify`, Memory writes (`remember`, `forget`), and everything in Night shift §3.1 (`financial`, `purchase`, `AUTH_KINDS`, `requiresAuthentication`, money-intent names and text). Those are also refused again in the gate, so a tool registered by mistake still can't run.

### 3.3 No cards while a fork runs

- A branch raises no approval cards, set-aside cards or questions, so there is no resume run.
- **A read whose `decide` is `ask`** (an ungranted folder, an outbound check, a tainted turn's fetch) is refused with `{ok:false, note:"needs the owner's OK; list it under open questions"}`. The model adds an open question, and the Plans view shows it as "Needs your OK to check".
- **A hook that asks** is refused the same way (Night shift's "no cards" applied to hook approvals too).

### 3.4 Take this plan

Taking a plan is the owner's tap on one branch. It reuses the Night shift apply path end to end:

1. **The Take sheet** lists the branch's steps. Staged items have checkboxes, ticked by default when fresh. Sends have the separate, unticked "Send it too" box (Night shift §3.2). Steps that weren't staged are listed as "Psyche does this after you take the plan" or "You do this".
2. **`planForks.take`** `{forkId, branchId, items:[{itemId, bindingHash}], sends:[{itemId, sendHash}], continue: boolean}`, idempotent:
   - re-checks that the fork is `ready` and the branch `reported`;
   - runs each item's `check(precondition)` (stale items aren't applied);
   - calls `requestStagedApply` with exactly those children, unchanged from Night shift §3.3 (one `staged_apply` approval, `riskClass: sensitive`, `once`, `deviceOnly` with sends, TTL 10 min);
   - returns `{approval, answerToken, refused}`. With no items selected, it returns `{approval: null}` and goes straight to step 4.
3. **The client** checks that the approval's `details.items[].bindingHash` set equals what it showed and the owner ticked, then answers with `approvals.answer`. That is the existing answer path, with `local` from the connection and the usual lockout. Execution uses `run-children.ts`.
4. **When the approval resolves approved** (or there was none):
   - the fork becomes `taken`, the other branches' items `dismissed`, and their running tasks are cancelled (authority revoked);
   - the parent thread gets a `plan_taken` block: the branch label, the checked report and the apply results;
   - with `continue: true` (default), the Gateway starts one parent turn with the remaining Psyche steps. The plan is attached as a fenced, JSON-quoted block, never as the owner's words. The input carries the branch's `taintSources`, so a plan built from mail or the web runs tainted: grants and Auto shortcuts don't apply, and every action asks as usual. The steps seed the turn's `update_plan` checklist.
5. **Declined or expired approval:** nothing is applied, and the fork stays `ready`.

Take never adds a presence step. A staged item that would need one can't exist (Night shift §3.1).

### 3.5 Prompt injection

- Mail and web reads taint the branch. The branch's taint and `taintSources` are stored on its row and carried into the staged items, the Take approval and the parent turn.
- Reports and comparison notes are data. The comparison pass gets the checked reports as JSON in a fenced block, with the instruction that they are content, not instructions.
- Stage-time limits are Night shift's: no forwards, no new recipients, calendar only on solo events, files only under rw grants. The "New recipient" badge shows on Take.

## 4. Reports and comparison

### 4.1 `fork_report` (`packages/protocol/src/schemas/plan-forks.ts`)

```ts
ForkReport {
  summary: string                       // ≤ 600
  steps:   { id, text /*≤200*/, who: "psyche" | "you", when?: IsoDate, stagedId?: string }[]   // ≤ 20
  costs:   { id, label /*≤80*/, amount: number, currency: string /*ISO 4217*/,
             period: "once" | "month" | "year", estimate: boolean, basis?: string /*≤200*/, cites: Cite[] }[]  // ≤ 20
  dates:   { id, label, date: IsoDate | IsoDateTime, kind: "deadline" | "event" | "milestone",
             estimate: boolean, cites: Cite[] }[]                                       // ≤ 20
  people:  { id, personId?: string, name /*≤80*/, effect /*≤200*/, cites: Cite[] }[]    // ≤ 20
  tradeoffs: { id, gain?: string, giveUp: string /*≤160*/, cites: Cite[] }[]            // ≤ 12
  risks:   { id, text /*≤200*/, likelihood: "low" | "medium" | "high", cites: Cite[] }[] // ≤ 10
  openQuestions: { id, text /*≤200*/ }[]                                                // ≤ 8
}
Cite { callId: string, ref: string }   // ref: a Memory fact or person id, mail message id, event id or URL
```

Ids are unique within the report. A second `fork_report` call is refused.

### 4.2 Checking citations (`packages/proactive/src/forks/report-check.ts`)

The Gateway checks the report before storing it. The model's own flags are never trusted.
- **A cite is valid** only if `callId` is a tool call of this branch's run that ended `ok` with `sideEffect` `none` or `read`, and `ref` appears in that call's stored result as an id field or URL. Each valid cite gets a `source` from the tool's class: `memory`, `mail`, `calendar`, `contacts`, `messages`, `web` or `files`. Invalid cites are dropped.
- **Costs.** A cost stays `estimate: false` only if its amount appears in a cited result. The match covers formatting variants (`1,850`, `1850.00`, `$1.85k`). Otherwise it becomes `estimate: true`, and an empty `basis` gets "Psyche's estimate". Currency stays as given. There is no conversion.
- **Dates** follow the same rule against ISO and common written forms.
- **People.** `personId` must resolve in Memory's people store. Otherwise it is dropped and the name stays unlinked.
- **Steps.** `stagedId` must be a live staged item of this branch. Otherwise it is dropped and the step stays plain.
- **Other items** that lost every cite keep their text and get `unsourced: true`, shown as "No source".
- **Tests** are table-driven: real amounts and lookalikes (`$185` vs `$1,850`), a cite to another branch's call, a cite to a write call, a hallucinated id.

### 4.3 The comparison pass

- **One model call**, the thread's model, no tools, at most 4k output tokens, from the budget reserve.
- **Input:** the labels, premises and checked reports as JSON in a fenced block. Branch transcripts are not sent.
- **Output** (`PlanComparison`):

```ts
PlanComparison {
  headline: string                                    // ≤ 200
  rows: { dimension: "cost" | "dates" | "people" | "tradeoffs" | "risks" | "open",
          label: string /*≤80*/,
          cells: { branchId, itemIds: string[], note?: string /*≤160*/ }[],
          differs: boolean }[]                        // ≤ 24
  betterIf: { branchId, text: string /*≤160*/ }[]     // "Better if you want…", never "You should"
}
```

- **Checked like a report** (`comparison-check.ts`). Every `itemId` must exist in that branch's report. A note that contains a number not present in its cell's items is dropped. A row with no valid cell is dropped.
- **Numbers come from code, not the model.** Cells render the items' own values and Estimate labels. Totals per branch are computed in code, per currency and per period (one-time, monthly, yearly), with "includes estimates" when any part is one. People are aligned across branches by `personId`. The earliest deadline per branch is computed in code.
- **No pick.** The comparison shows "Better if…" per branch, never a recommendation.
- **If the pass fails,** the Plans view still shows the reports side by side with the code-computed rows (totals, deadlines, people), without notes.

### 4.4 Remote viewers

`planForks.get` scrubs for every connection that isn't the desktop shell, using the `forViewer` rule:
- **Items.** An item with any cite whose `source` is in `OWNER_ONLY_SOURCES` (`memory`, `messages`, `contacts`) is withheld whole. The cell shows "1 more on your Mac".
- **Totals** are shown only when every item in them is visible. Otherwise "Total on your Mac".
- **People** linked to a Memory person keep the name only when the item passes the rule above.
- **Model-written text** (summary, headline, notes, "Better if") is withheld when the branch read any owner-only source through a tool. It is replaced with "Open on your Mac to read this".
- **Withheld text never reaches the phone.** The scrub runs in the Gateway, and the `planFork.updated` event carries only ids and states. Clients fetch with `planForks.get`.

## 5. UI

### 5.1 Mac (Electron and web, `packages/ui`)

- **Entry points.**
  - The message menu (`MessageView.tsx`) gets "Fork a plan…" below the existing "Fork".
  - The composer gets `/compare` (`commands.ts`), taking an optional `A | B | …` argument. `/fork` stays the plain thread fork.
  - Search ⌘K gets "Fork a plan from this chat" while a chat is open.
- **Start sheet.** 2 option rows (add up to 4), each with a label and a premise. Below: "Up to about $0.40 · reads your memory, calendar, mail and the web · changes nothing until you take a plan", then **Start**.
- **Fork card** in the transcript (`plan_fork` block). The title is the labels ("Move to Austin vs Stay"). While running, there is one line per branch with its live step ("Searching mail for the lease"), elapsed time and spend against the cap, plus **Cancel**. Once ready, it shows the headline, the totals per branch and **Compare**.
- **Plans view.** It opens in the chat pane, replacing the transcript (back returns to it), with deep link `/chat/<threadId>?fork=<forkId>`. No new sidebar row.
  - **Lanes:** one column per branch, with its summary, steps (staged ones marked "Prepared"), open questions and a link to its read-only transcript. On narrow windows the lanes become tabs.
  - **Comparison:** one row per dimension, one cell per branch. Estimates carry an "Estimate" tag with the basis on hover. Each source chip opens the memory fact, mail, event or page. Rows that differ are on by default, and "Show all rows" shows the rest.
  - **Take this plan** at the foot of each lane, which opens the Take sheet (§3.4).
- **Ink direction:** one accent per view (Take in the Plans view), with the paper grays. Lanes use the motion tokens from `motion.md`, and reduced motion is respected.

### 5.2 iOS (`apps/ios`)

- **Viewing.** The fork card renders in the thread. Tapping it pushes `PlanForkView`:
  - a segmented control per branch for the lanes;
  - a Compare tab with rows stacked by dimension (not a wide table), one block per branch inside each row.
- **Starting.** The message context menu gets "Fork a plan…", which opens the same sheet with the same suggestion. `planForks.create` needs `operator.write`, the same scope as `chat.send`.
- **Take.** The same sheet and the same hash check before `approvals.answer`. When `detailsNeedMac` applies, it shows "Open on your Mac" and never weakens.
- **Scrubbed** as §4.4. Withheld items show the count line.
- **Live state** comes from `planFork.updated` events and the #1647 refresh. There is no notification in v1: a fork finishes in minutes while you are in the chat.

## 6. Cost and progress

- **Budget per fork.** `forks.budgetUsd`, default 1.00, range 0.10–5.00. Spend is metered from usage events and priced with the model-router tables, like Night shift §4.4, and a 400k-token ceiling binds unpriced and local models.
  - 10% is reserved for the comparison pass and forced reports.
  - The rest is split evenly across branches.
- **Per branch task budget:** `maxSteps` 16, `maxTokens` 120k and `maxWallMs` 240 s, lowered when the money share is smaller. A branch that hits its share is `budget_stopped`. A report it already filed still counts.
- **The estimate before Start** is the worst case from the model's prices and the caps: "Up to about $0.40". Unpriced models show "Up to about 300k tokens".
- **Cancel.** `planForks.cancel {forkId, branchId?}` stops one branch or all of them through the worker's `stop("cancelled")`, which revokes run authority at once. A cancelled fork keeps whatever reports were filed, and its staged items are `dismissed`.
- **While it runs**, the card and lanes show the current step per branch (from `run.step`), elapsed time, spend so far against the cap, and "Waiting for a slot" for a queued branch.
- **Owner-wide caps:** 3 running forks, 1 per thread.

## 7. Data model and protocol

### 7.1 Tables

One migration `<ts>_gateway_plan-forks.sql` plus the drizzle mirror (`schema-parity.test.ts`).

**`plan_forks`:**
- `id`, `thread_id` (FK, cascade), `fork_message_id` (FK messages, set null);
- `status` (`running|comparing|ready|taken|dismissed|expired|cancelled|failed`), `error`;
- `budget_usd`, `spent_usd`, `tokens`;
- `comparison` (JSON), `taken_branch_id`, `take_approval_id`;
- `created_by_device_id`, `expires_at`, `created_at`, `updated_at`, `finished_at`.
- Partial unique index: one row per `thread_id` with status `running` or `comparing`.

**`plan_fork_branches`:**
- `id`, `fork_id` (FK, cascade), `ord` (0–3, `UNIQUE(fork_id, ord)`), `label`, `premise`;
- `thread_id` (FK threads, cascade), `task_id`;
- `status`, `error`, `report` (JSON, checked), `read_owner_only` (0/1, for §4.4);
- `taint`, `taint_sources`, `spent_usd`, `tokens`;
- `started_at`, `finished_at`, `created_at`, `updated_at`.

**`staged_actions` (Night shift's table) gets an origin.** `night_id` becomes nullable, a nullable `fork_branch_id` (FK, cascade) is added, and a CHECK requires exactly one of the two. The live-target uniqueness becomes two partial indexes, `(night_id, target_key)` and `(fork_branch_id, target_key)`.
- If Night shift W0 hasn't merged when fork F0 starts, F0's brief asks for this shape in Night shift W0 (one shared migration).
- If it has merged, F0 rebuilds the table in its migration: create the new table, copy the rows, drop, rename and re-index, with a real-SQLite test.

**Message blocks:** `plan_fork` `{forkId}` and `plan_taken` `{forkId, branchId}`. These are new block types in the protocol message-block union, rendered from `planForks.get`.

### 7.2 Methods (`packages/protocol/src/methods/plan-forks.ts`)

| Method | Scope | Side-effecting | Notes |
| --- | --- | --- | --- |
| `planForks.suggest` | operator.write | no, `callsModel` | `{threadId, messageId}` returns 2 suggested `{label, premise}`. Utility model. Nothing stored. |
| `planForks.estimate` | operator.read | no | `{threadId, branches}` returns the worst-case cost or tokens |
| `planForks.create` | operator.write | yes, idempotency key, `callsModel` | `{threadId, messageId, branches:[{label, premise}]}` returns `{fork}` |
| `planForks.get` | operator.read | no | the fork, its branches and the comparison, scrubbed per §4.4 |
| `planForks.list` | operator.read | no | `{threadId}` returns the forks of a thread, newest first |
| `planForks.cancel` | operator.write | yes, idempotency key | `{forkId, branchId?}` |
| `planForks.retryBranch` | operator.write | yes, idempotency key, `callsModel` | Once per branch, within the budget |
| `planForks.take` | operator.approvals | yes, idempotency key | §3.4. Returns `{approval, answerToken, refused}`. A replay returns the same approval and token, like `nightShift.apply`. |
| `planForks.dismiss` | operator.write | yes | Ends the fork and dismisses its staged items |

- **Events:** `planFork.updated` `{forkId, threadId, status, branches:[{id, status, step?}], spentUsd}`, with ids and states only and never report text. Live steps reuse `run.step` on the branch runs.
- **No new `ApprovalKind`.** Take uses `staged_apply`.
- **`DailySectionId`, Home and Feed are unchanged.** Add the new block types to the Swift exhaustive switches.
- **Scopes match Night shift.** A device that can chat can fork, read and cancel. Take needs `operator.approvals`, the scope `approvals.answer` itself needs.
- **Idempotency** uses `gateway_idempotency`. List every new side-effecting method in `apps/ios/Tests/side-effecting-methods.json` and in the protocol check.

## 8. Privacy and retention

- **Read** under existing grants only: Memory, calendar, mail, contacts and Messages where connected, and the web. Incognito threads can't be forked.
- **Stored:** premises, branch transcripts (tool payloads under the existing `cleanupPeriodDays`), checked reports, the comparison and staged items.
- **Retention:**
  - Staged items follow Night shift expiry. A fork's items expire with the fork (§2.4).
  - Branch threads of `dismissed`, `expired`, `cancelled` and `failed` forks are deleted 30 days after the fork ends, through #1651's `history-prune` batches. The fork row and comparison go with them.
  - A taken fork keeps its fork row (the parent's `plan_taken` block points at it). Its branch threads are deleted after 30 days, and "Open transcript" then says "Removed after 30 days".
  - Clear chat and deleting the parent cancel running forks and delete them (`endSession` through the real handlers).
- **Logs** carry ids, counts, tool names, states and spend. They never carry premises, reports, notes or args.

## 9. Settings and copy

Settings → Chat gets a small "Fork a plan" group:

| Key | Default | Notes |
| --- | --- | --- |
| `forks.budgetUsd` | `1.00` | Range 0.10–5.00. Not a security setting, so not sealed. |
| `forks.expiryDays` | `7` | Range 1–30 |
| `forks.suggestOptions` | `true` | The utility-model suggestion in the start sheet |

**Copy** goes in all 10 languages: `packages/ui` i18n under `planFork.*`, `chat.message.forkPlan`, `chat.command.compare` and `settings.forks.*`, plus iOS `Localizable.xcstrings`, with `pnpm i18n:check`. Key strings:
- "Fork a plan…", "Compare plans", "Option", "Assume…", "Start", "Cancel", "Compare", "Take this plan";
- "Up to about {amount}", "Reads your memory, calendar, mail and the web. Changes nothing until you take a plan.";
- "Estimate", "No source", "Prepared", "Psyche does this after you take the plan", "You do this", "Needs your OK to check";
- "Better if…", "1 more on your Mac", "Total on your Mac", "Open on your Mac to read this", "Waiting for a slot";
- "Forks aren't available in incognito chats."

## 10. Shared with Night shift

| Piece | Built by | Fork's use |
| --- | --- | --- |
| `#gate` staging branch and `packages/agent-core/src/staging.ts` | Night shift W1 | F1 widens `staging` to the union, adds `FORK_ONLY` and the "read that would ask" refusal, and adds the fork rows to the probe tables |
| Adapters `packages/proactive/src/night-shift/adapters/*` | Night shift W3 | Imported unchanged. Moving them to `packages/proactive/src/staged/adapters/` is a pure move in F2, with re-exports. |
| `requestStagedApply`, `staged_apply` | Night shift W2 | Unchanged |
| `run-children.ts` and the apply module | Night shift W5 | F4 calls the apply module with a fork-branch source. If W5 built it night-specific, F4 makes it take `{kind, id}` with no behaviour change, and the Night shift suites stay green. |
| Spend meter | Night shift W4 (`budget.ts`) | F2 moves it to `packages/proactive/src/staged/meter.ts` if it's night-specific |

Fork waves that need a Night shift wave wait for it to merge. Neither feature gets a second copy of a shared piece.

## 11. Builder wave plan

| Wave | Owns (files and packages) | Done means | Depends on | Security review |
| --- | --- | --- | --- | --- |
| **F0 Protocol and DB** | `packages/protocol/src/{methods/plan-forks.ts, schemas/plan-forks.ts, events.ts}`, the `plan_fork`/`plan_taken` block types, `packages/db/migrations/*_gateway_plan-forks.sql` (plus the `staged_actions` origin, §7.1), the `packages/db/src/schema-*.ts` mirror, generated Swift, the Swift exhaustive switches, `side-effecting-methods.json` | `protocol:check` and `schema-parity` pass. Real-SQLite write-then-read of every column. The CHECK rejects both or neither origin. Swift builds. | Night shift W0 | no |
| **F1 Loop and registry** | `packages/agent-core/src/staging.ts` (the union and fork rules), the `#gate` read-ask refusal, `registry.ts` (`FORK_ONLY`, `fork_report`), `packages/tasks` (`staging` union, `createdFrom: "fork"`) | Two-way probe tables: allowlisted tools stage under a fork origin, near-misses are refused, a read that decides `ask` is refused with no card, a hook ask is refused, `fork_report` is hidden outside forks, and a client can't set `staging`. The Night shift rows still pass. | F0, Night shift W1 | **yes** |
| **F2 Branch runner** | `packages/proactive/src/forks/{service,stager,toolset,prompt,budget}.ts`, `apps/gateway/src/compose/forks.ts` (the `fork` pool, claims, `excludeOrigins`), the `web_fetch` same-branch URL rule | The toolset test lists exactly the §3.2 tools, with browser, computer, MCP, exec and money tools absent. A model-built URL is refused and a search-result URL is fetched. One slot for a local model. The budget split and reserve hold, with a forced report at the cap. Restart recovery with a fake clock. Cancel revokes authority. | F0, F1 | **yes** (toolset and fetch rule) |
| **F3 Reports and comparison** | `packages/proactive/src/forks/{report-check,comparison,comparison-check,totals,viewer}.ts` | Table tests for cites (§4.2), amounts and lookalikes, dates, `personId` resolution, notes with invented numbers dropped, per-currency totals, the fallback with no comparison. `viewer.ts` withholds owner-only items, totals and text for a non-desktop caller, with a positive control on the desktop shell. | F0 | no |
| **F4 Handlers and Take** | `apps/gateway/src/handlers/plan-forks.ts`, the threads exclusions (`listThreadsPage`, search indexer, learner, daily notes, thread-end), the apply module source change, the parent turn with `taintSources` | E2E (`apps/gateway/test/plan-forks.test.ts`): create, two branches stage, compare, take with some items, the apply runs through `staged_apply`, the parent turn starts tainted and asks for an unstaged write. Idempotent replays. A declined approval leaves the fork `ready`. Clear chat cancels. Each exclusion consumer has a test. `--related` runs. | F1, F2, F3, Night shift W2 and W5 | **yes** (promotion and apply) |
| **F5 Mac and web UI** | `packages/ui/src/plan-fork/*` (start sheet, fork card, Plans view, lanes, comparison, Take sheet, data hook, mock), the `MessageView.tsx` item, the `/compare` command in `commands.ts`, the ⌘K command, the Settings group, 10-language i18n | Mock-backed tests. The client refuses to answer when the approval's hash set differs from the selection. Sends are never preticked. Estimates are labelled. Narrow-window tabs. Browser-preview screenshots. | F0 (builds against mocks). Merges after F4. | yes (answer path only) |
| **F6 iOS** | `apps/ios/.../Chat/PlanFork*`, `GatewayBackend+PlanForks.swift`, `FixtureBackend+PlanForks.swift`, the message context-menu item, `Localizable.xcstrings` | Simulator run on fixtures. The same hash check before `approvals.answer`. `detailsNeedMac` goes to the Mac. Scrubbed fixtures show the count lines. | F0. Merges after F4. | yes (answer path only) |

**Parallelism:**
- F0 first.
- F1 and F3 run in parallel after F0. F3 touches only new files.
- F5 and F6 run in parallel after F0, because their file sets are disjoint.
- F2 waits for F1. F4 waits for F1, F2, F3 and Night shift W2 and W5.
- `docs/05-security-and-permissions.md` gets a "Plan forks" paragraph under Night shift's "Staged apply" section, in F4.

## 12. Tests (beyond each wave's "done")

- **Every Night shift §3.1 prohibition** is tested through each fork path: the gate under a fork origin, `planForks.take`, and the parent turn after Take (an unstaged payment step asks with presence as today and is never applied in bulk).
- **Nothing happens during a fork.** A fake connector records zero write calls across a full fork run with writes attempted.
- **Binding:** a changed arg, an item swapped from the other branch, a replayed token or a second consume is refused.
- **Isolation:** a branch never sees another branch's messages or the parent's later messages.
- **Remote viewers:** no owner-only item, total or text, with a desktop control.
- **Logs** contain no premise or report text.

## 13. Not in this version

- More than 4 branches, nested forks, or forking a branch.
- Several turns per branch, or chatting inside a branch.
- Editing a branch's plan before Take (take it, then change it in the chat).
- Merging two branches.
- Currency conversion.
- Forks in automations or channels.
- A notification when a fork finishes.
- Parked, never designed here: PayPal, per-store checkout, order tracking.

## 14. Open questions for the owner

1. **Budget.** Is $1.00 per fork right (adjustable from $0.10 to $5)? *Default: $1.00.* Two branches on a mid-price model usually cost $0.20–$0.50.
2. **Start from the iPhone.** Should the phone be able to start a fork, not just view one? *Default: yes.* It needs the same scope as sending a chat message, and branches only read on the Mac.
3. **After Take.** Should Psyche start carrying out the remaining steps at once, asking for each action as usual? Or should it post the plan and wait for you? *Default: start at once* (the "continue" box is ticked in the Take sheet).
4. **Phone scrub.** When a branch read Memory, Messages or Contacts, should the phone hide the model-written summary and notes, not just the cited items? *Default: hide.* It's the strict reading of "remote devices can't open Memory".
5. **How long branches are kept.** Keep branch transcripts 30 days after a fork ends? *Default: 30 days.* The comparison of a taken plan stays with the chat.
