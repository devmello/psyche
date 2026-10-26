# System messages

Status: v0.1 (2026-10-19). Owner: S20. Strings for approval cards, question cards, notifications, receipts, banners, toasts, empty states and errors. Screens: `docs/06-ui-design.md` §3.3, §3.4, §3.14–3.20, §4.13. Voice: [voice.md](voice.md). Everything here is in Psyche's voice.

Placeholders: `{agent}`, `{owner}`, `{task}`, `{site}` (bare domain), `{url}` (full URL), `{account}`, `{n}`, `{time}`, `{countdown}` (`mm:ss`), `{amount}` (with currency, for example "$189.00 USD"), `{reason}`.

## 1. Approval cards

### Shared chrome

| Element | Text |
| --- | --- |
| Header | **Approval needed** · "expires in {countdown}" (danger color under 60 s) |
| Requested by | "{agent} · task "{task}" ({from chat \| from automation "{name}" \| from {channel} \| from an Idea})" |
| Why asked | One line built from the Broker's reason, joined with "; ": "balanced mode" · "manual mode" · "first time on {site}" · "sends outside your account" · "irreversible" · "spends money" · "this turn read content from {sources}" · "sensitive site" · "outside your standing grants" |
| Taint notice (when tainted) | "{agent} read content from {sources} in this task. Check the details came from you, not from that content." |
| Binding line | "Binding {hash-prefix}… · any change above voids this card" |
| Scopes | **Allow once** · **Allow for this task** · **Allow for this site** ({site}) · **Always allow** until [**this session ends** · 1 h · 24 h · 30 days · until revoked] · **Deny** |
| Buttons | **Deny** · **Allow with scope** (label becomes **Allow once**, **Allow for this task** etc. when a scope is picked) |
| Device-only note | "Approve this on your Mac or in the web app. It isn't sent to chat apps." |
| Touch ID note | "Touch ID required." |
| Also sent to | "Also sent to: {surfaces}" |

### States

| State | Text |
| --- | --- |
| Approved | "Allowed {scope} by you on {surface} · {time}" |
| Denied | "Denied by you on {surface} · {time}" |
| Answered elsewhere | "Answered on {surface} · {time}" |
| Expired | "Expired after 30 min. Denied. {agent} can ask again when you resume the task." |
| Voided | "Voided because the details changed. A new card follows if {agent} still needs it." |
| Stale after restart | "Psyche restarted, so this card was re-issued. Use the new one." |
| Too early | (buttons disabled for 400 ms; no text) |
| Late / replayed answer (toast) | "That approval was already answered or expired. Nothing changed." |

### Summary line and detail rows by kind

Summary lines are verb + exact object. Detail rows are key: value, never truncated for recipients, commands, amounts or URLs.

| Kind | Summary | Detail rows |
| --- | --- | --- |
| `send_email` | "Send an email to {recipients}" (reply: "Send reply "{subject}" to {recipients}") | To · Cc · Bcc · Subject · Body ({n} paragraphs, **View**) · Attachments (name, size) · Account |
| `message_send` | "Send a {channel} message to {recipient}" | To (name and handle or number) · Channel · Account · Message (**View**) · Attachments · Voice note ({seconds} s) |
| `calendar_write` | Create: "Add "{title}" to {calendar}, {when}" · Update: "Move "{title}" to {when}" · Delete: "Delete "{title}" on {when}" | Calendar · Account · Title · When (day, date, time, timezone) · Where · Attendees ("{n} people will be notified": list) · Operation |
| `browser_submit` | "Submit the form on {site}" | Page ({url}) · Fields ({name}: {value}; credential fields as "saved login {item}") · Button ("{label}") |
| `new_origin` | "Let {agent} act on {site}?" | Site · Task · Reached from ({previous site} or "your request") |
| `credential_fill` | "Fill your saved {field} for {site}" | Item ({item name}) · Bound to ({bound origin}) · This page ({current origin}) · Fields · Task. Buttons replace scopes: **I'll type it myself** (default) · **Fill from vault once** · **Fill from vault for this site** · **Deny** |
| `purchase` | "Pay {amount} to {merchant}" | Merchant ({name}, {site}) · Items (name × qty @ unit price, one row each) · Shipping · Tax · **Total {amount}** · Pay with ({Link one-time card}) · Deliver to ({address label}). Note: "Next, approve the same amount in Link within 30 minutes." |
| `exec` | "Run `{command}` in the sandbox" | Command (full argv) · Folder (cwd) · Environment (names only) · Network (none \| allowlisted proxy) · Sandbox |
| `exec_host` | "Run `{command}` directly on this Mac" | Command · Folder · Environment (names) · Executable (path and hash). Warning: "This runs outside the sandbox with your user's access." |
| `file_write` | "Write {path}" (edit: "Change {path}"; new: "Create {path}") | Path · Operation · Changes (**View diff**) · Size |
| `connector_action` | "{Action} in {connector}: {target}" (for example "Archive 22 emails in Gmail") | Connector · Account · Action · Target · Arguments (**View**) |
| `mcp_tool` | "Use {tool} on {server}" | Server · Trust (bundled \| verified \| unknown) · Tool · Arguments (full JSON, **View**) · Tool list hash |
| `computer_action` | "{Action} in {app}" (for example "Click "Send" in Mail") | App · Action · Element · Access needed (Read only \| Read and interact) |
| `plan_exit` | "Start working on the plan "{title}"" | Steps ({n}, **View plan**) · Approvals it expects · What it won't do. Buttons: **Keep planning** · **Approve plan** |
| `skill_install` | "Install the skill "{name}"" | Source · Version / hash · Scan ({n} findings, highest severity) · Full text (**Read**) · Tools it mentions. Warning when any finding is high: "The scan found {finding}. Read the skill before installing." |
| `memory_protected_write` | "Change {agent}'s {file}" (for example "Change Wren's USER.md") | File · Changes (**View diff**) · Based on ("you said on {date}" or "{agent}'s suggestion") |
| `archive_thread` | "Archive the side chat "{title}"" | Thread · Last message {time} |
| `pairing` | "Pair {device or sender} with Psyche" | Device or sender · Channel · Code ({code}) · Fingerprint · Access requested |
| `policy_change` | "Change a permission setting: {setting}" | Setting · From · To. Note: "Only you can change this, in Settings. {agent} can't." |

Scopes offered follow the Broker: `destructive` kinds show only **Allow once** and **Allow for this task**; `purchase` shows only **Allow once**.

### Site-permission prompt (browser pane)

- Title: "Let {agent} act on {site}?"
- Body: "{agent} wants to click and type on {site} for "{task}"."
- Buttons: **Deny** · **Allow once** · **Always allow**

### Chat-channel approval messages

Sent only for kinds a chat surface may answer (never device-only kinds).

- Text: "Approval needed: {summary}. Task: {task}. Expires {time}. Reply in Psyche for full details."
- Telegram buttons: **Allow once** · **Deny**
- iMessage / Signal: "Reply 👍 to allow once or 👎 to deny." (iMessage poll where supported: options "Allow once", "Deny")
- Fallback: "Or reply /approve {id} once, or /approve {id} deny."
- After answer: "Allowed once. {agent} is continuing." / "Denied. {agent} won't do it."
- Late: "That approval already expired or was answered."
- Device-only attempt (never sent; shown in Activity): "Waiting for your approval on your Mac or the web app."

## 2. Question cards (`ask_user`)

| Element | Default text |
| --- | --- |
| Header (one question) | "{agent} has a question" |
| Header (several) | "{agent} needs {n} answers before continuing" |
| Recommended tag | "recommended" (followed by the option's reason) |
| Multi-select hint | "pick any" |
| Other row | "Other:" with placeholder "Type an answer" |
| Buttons | **Skip for now** · **Answer** |
| Answered (collapsed) | "{header}: {answer}" · **Change** |
| Skipped | "Skipped. {agent} will continue with what it has, or ask again later." |
| Background task waiting | "Waiting for your answer: {first question}" (in Activity and Upcoming) |

## 3. Notifications

### In-app inbox rows and OS notifications

The leading symbol in each inbox row stands for the kind icon; it is not part of the text.

| Kind | Inbox row | OS title / body | Actions |
| --- | --- | --- | --- |
| `approval` | "! Approval · {summary} · {countdown}" | "{agent} needs your approval" / "{summary}" | Approve · Deny (purchases and fills open the full card) |
| `input_needed` | "? Input · {task}: {question}" | "{agent} has a question" / "{task}: {question}" | Answer (text reply when there is one free-text question) |
| `task_done` | "✓ Done · {task}: {result}" | "{task} is done" / "{result}" | Open |
| `task_failed` | "✕ Failed · {task}: {reason}" | "{task} didn't finish" / "{reason}. {what Psyche did}." | Open · Retry |
| `proactive` | "{title} · Because: {evidence}" | "{agent}: {title}" / "Because: {evidence}" | Open · Dismiss |
| `briefing` | "Brief ready · {name}" | "Your {name} is ready" / "{first line}" | Open |
| `reminder` | "Reminder · {text} · {time}" | "Reminder" / "{text}" | Done · Snooze 1 h |
| deferred approval | "Deferred · {automation} wanted to {summary}" | "{automation} is waiting for you" / "It wanted to {summary}. Nothing was done." | Run with approval |
| attention needed | "Paused · {task} needs you to watch" | "{task} paused" / "{site} is a sensitive site. Open Psyche to let {agent} continue while you watch." | Open |
| CAPTCHA / take control | "Paused · {task}: {site} wants a human check" | "{agent} needs you on {site}" / "Take control to finish the check, then hand back." | Take control |
| possible injection | "Paused · {task}: possible prompt injection" | "{task} paused for safety" / "{agent} was asked twice to do something not allowed. Review before continuing." | Review |

- Stale after restart (row suffix): "· out of date"
- Grouping: "{n} more from {task}"
- Quiet hours: notifications marked passive; approvals still arrive but without sound.

### Specialist results (docs/agent/specialists-2026.md §6.2)

One status vocabulary everywhere: **Queued**, **Working**, **Needs you**, **Done**, **Partial**, **Failed**, **Cancelled**. "Needs you" covers approvals, questions and budget pauses. Role names are lowercase in prose ("the researcher") and sentence case as labels ("Researcher").

| Moment | Where | Text |
| --- | --- | --- |
| Spawned | Parent chat, agent voice | "I've asked the {role} to {title}. It'll take up to {minutes} min; I'll put the result in your Inbox." |
| Spawned | Parent chat line, Psyche | "Started the {role} · {title} · {status}" · Timeline › |
| Pre-flight | Under the spawn line | "Will ask before opening new sites (about 5)" · "Will show you a plan to approve first" (grants nothing) |
| Queued | Row line 2 | "Queued · {n}th · starts when a slot frees" |
| Working | Row line 2 | "Working · {last step}" |
| Needs you | Row line 2 / OS | "Needs you · {last step}" / "{role} needs your approval for {task}" |
| Budget pause | Question card | "{role} used its {budget} budget on {task}." Options: "Give it more", "Finish with what it has", "Stop it" |
| Done | Row line 2 / card | "Done · 3 findings · $0.84 · 22 min" / "{role} finished {task}." |
| Partial | Row line 2 / card | "Partial · token budget" / "Stopped at its {budget}. See what's missing." |
| Failed | Row line 2 / card | "Failed · {time}" / "{role} couldn't finish {task}. Nothing was sent or bought." (the last sentence only when there are no receipts) |
| Cancelled | Row line 2 / card | "Cancelled · {time}" / "Stopped. It had {n} receipts before you stopped it." |
| Evaluator | Card | "Checked: {reason}" · "Sent back once: {reason}" · "Needs your check: {reason}" |
| Taint | Card | "It read content from outside sources. Treat its claims as unverified." |
| Usage | Card | "182k of 400k tokens · $0.84 of $2.00 · 22 min of 30 min · 31 steps · incl. $0.12 retried after errors" |
| Default used | Card | "Used the default: {label}" |
| Card actions | Card | up to 2 follow-ups · Retry (partial, failed) · Open thread · Timeline |
| Feed | Feed section | "From your specialists" (only with "Show specialist results in Feed" on) |

### Inbox empty state

"Nothing needs you."

## 4. Receipts (chat line and Activity)

| Kind | Line |
| --- | --- |
| Email | "Sent to {recipients} · Gmail id {id} · {time}" |
| Message | "Sent to {recipient} on {channel} · {time}" |
| Calendar | "Added "{title}" · {when} · event id {id}" / "Moved …" / "Deleted …" |
| Form | "Submitted the form on {site} · {time}" (+ "confirmation {number}" when captured) |
| Purchase | "Paid {amount} to {merchant} · order {number} · card ending {last4}" |
| Command | "Ran `{command}` · exit {code} · {duration}" |
| File | "Wrote {path} · {size}" |
| Uncertain | "{action}: outcome unknown · not retried" |
| Evaluator | "Checked: {verified \| not found \| needs you}" |

## 5. Banners and toasts

| Situation | Text |
| --- | --- |
| Offline | "Psyche can't reach the Gateway. Tasks keep running; this window will reconnect." |
| Reconnected | "Reconnected." |
| Browser closed | "Browser closed. "{task}" keeps running." |
| Take control on | "Paused: you have control" · button **Hand back control** |
| Download | "Downloaded {file} to Library → Downloads (quarantined)" |
| Memory paused | "Memory paused" (chip in every thread) |
| Incognito | "Incognito side chat: nothing here is saved to memory, and it's deleted after 24 hours. Your model provider may still keep its own logs." |
| Delegated persona | "Delegated: {agent} is talking to {person} for you." |
| Coalesced runs after sleep | "Your Mac was asleep. {n} missed runs of {automation} ran once at {time}." |
| Mode changed by breaker | "{task} switched from Auto to Balanced after {agent} hit several sensitive actions." |
| Grants revoked (MCP) | "{server} changed its tools, so its standing approvals were revoked." |
| Standing grant expiring | "{n} standing approvals expire in 7 days. Review in Permissions." |
| Stop the task | "Stopped "{task}". Anything already sent is listed in Activity." |
| Esc during computer use | "Computer use stopped." |
| Copied | "Copied." |

## 6. Empty states

| Screen | Text | Action |
| --- | --- | --- |
| Activity | "No tasks yet." | **Ask {agent} to do something** |
| Approvals | "Nothing needs you." | — |
| Upcoming | "Nothing scheduled." | **Schedule something** |
| Feed | "Your first brief arrives tomorrow morning." | **Tell {agent} what to follow** |
| Ideas | "Ideas come from your goals, conversations and connected accounts." | **Add a goal** |
| Goals | "Tell {agent} a goal in chat, or add one here." | **Add a goal** |
| Library | "Files {agent} makes or receives show up here." | **Add files** |
| Search, no results | "Nothing matches "{query}"." | **Clear filters** |
| Connectors | "No accounts connected." | **Connect an account** |
| Credentials | "The vault is empty. {agent} uses your sign-ins in its browser first, and asks you to type passwords yourself." | **Add item** |
| Daily notes | "No notes yet today." | — |
| Grants ledger | "No standing approvals." | — |
| Channels | "{agent} only talks to you in this app." | **Add a channel** |

## 7. Errors

Every error: what happened, what Psyche did, what you can do.

| Situation | Text | Action |
| --- | --- | --- |
| Model error, user-picked | "The model returned an error ({reason}). Psyche did not fall back because you chose this model." | **Try again** · **Pick another model** |
| Model error, fell back | "{primary} returned an error ({reason}). Psyche used {fallback} for this reply." | **Model settings** |
| Model can't use tools | "{model} failed the tool check, so it can chat but can't do tasks." | **Pick a model for tasks** |
| Rate or usage limit | "{provider} limit reached. Psyche queued your message and will send it at {time}." | **Use another model now** |
| Connector auth expired | "{connector} signed you out ({account}). Tasks that need it are paused." | **Sign in again** |
| Google Testing-mode expiry | "Google signed you out after 7 days because the Psyche client is in Testing mode." | **How to fix** |
| Sandbox unavailable | "No sandbox backend is available. Psyche never falls back to the host shell." | **Sandbox settings** |
| Command failed | "`{command}` exited with code {code}. {agent} has the output." | **View output** |
| Site blocked | "{site} isn't allowed for this task. {agent} didn't open it." | **Allow {site}** |
| Redirect blocked | "{site} redirected to {other}, which isn't allowed. Psyche stopped the redirect." | **Allow {other}** |
| CAPTCHA | "{site} wants a human check. Psyche never solves these." | **Take control** |
| Vault locked | "The vault is locked. Unlock it with Touch ID to let {agent} fill {item}." | **Unlock** |
| Card number refused | "Psyche doesn't store card numbers. To pay, connect Stripe Link instead." | **Connect Link** |
| Payment expired | "The Link approval expired after 30 minutes. Nothing was charged." | **Start checkout again** |
| Uncertain outcome | "{action} may or may not have gone through ({reason}). Psyche didn't retry. {agent} is checking." | **Open receipt** |
| Approval expired | "Your approval for "{summary}" expired. Nothing was done." | **Resume task** |
| Nightly job missed | "The nightly job didn't run (your Mac was asleep). Next: {time}." | — |
| Memory write refused | "{agent} tried to save something from {source} into {file}. Content from outside sources can't go there; it was kept in today's note instead." | — |
| Folder not shared | "{folder} isn't shared with {agent}." | **Share {folder}** |
| XFA form | "This PDF uses an XFA form, which Psyche can't fill. {agent} can list the answers for you instead." | — |
| Gateway restarted | "Psyche restarted. Running tasks resumed; {n} approvals were re-issued." | **Review approvals** |
| Pairing code expired | "That pairing code expired. Ask the sender to message again for a new one." | — |
| Export failed | "The export stopped ({reason}). Nothing was deleted." | **Try again** |
