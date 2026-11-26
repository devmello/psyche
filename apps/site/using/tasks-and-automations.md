---
title: Tasks and automations
---

# Tasks and automations

Work that takes a while runs as a Task: a durable job on the Gateway that keeps going after you close the window, survives a restart, and records every action with a receipt. Automations are Tasks on a schedule. They run when nobody is watching, so they never wait for you: anything that needs your approval is set aside in the approvals queue and you get a notification.

## Turn it on

There is nothing to turn on. Ask the agent to do something in the background ("keep looking for a cheaper flight and tell me when you find one"), or to do something on a schedule ("every weekday at 7, summarize my calendar"). The agent proposes the Task or automation and you approve it.

## What it can do

### Tasks

- **Starting one.** The agent asks with a "Start background task" card that shows the title and the goal. When you approve, a task card appears in the chat.
- **The task card.** It shows the status: queued, running, needs your answer, awaiting approval, paused, done, failed or cancelled. Buttons: **Pause**, **Resume**, **Cancel** and **Retry**, depending on the status.
- **Closing the window** does not stop a Task. "Quit Psyche (tasks keep running)" closes the app; the Gateway keeps working. Psyche Helper stops when you quit, so a task that needs it (computer use, Messages, dictation) cannot run until you open Psyche again.
- **Restarts.** If the Gateway stops mid-task, the Task resumes when it starts again. An action that was in flight is marked "outcome unknown · not retried" and is never repeated by itself. Pending approval cards are issued again.
- **Taint carries over.** A Task started after the agent read untrusted content starts marked as tainted, so its writes to new targets ask.

### Activity

Click the avatar in the chat header, then **Activity**, or press ⇧⌘A.

- Filters: **Running**, **Needs you** and **All**.
- Click a Task to see its actions in order, with time, tool, summary, outcome and receipt.
- ⌃O cycles the level of detail: status, actions, raw.
- Task detail has **Pause**, **Resume**, **Retry** and **Cancel**. Cancel is how you stop a Task.

::: info Screenshot placeholder
The Activity tab with the Running, Needs you and All filters, and a task detail showing three actions with their receipts.
:::

### Automations

The agent creates an automation with its schedule tool, which always asks you first. Type `/schedule` followed by what you want and when, or just ask in plain words.

- **Schedules** are a cron expression ("weekdays at 7") or an interval ("every hour"), with an optional time zone.
- **Each run** happens in its own session and reports back to the chat it was created in.

**To make one yourself**, open **Scheduled** (from Home, under Coming up) and choose **New automation**. Write what Psyche should do, then pick when it runs:

- once, at a date and time;
- every day, at a time;
- on weekdays, at a time;
- weekly, on the days you choose, at a time;
- every few hours.

The form shows the time zone the times are in and the next three runs. Choose where the result goes: your inbox, a chat, or nowhere. Turn the automation off to keep it without running it. **Edit** on a row opens the same form; **Delete** asks you to confirm first. A one-time automation cannot become repeating, or the other way round, so make a new one instead.

An unattended run does not ask you while it runs. An action that needs your approval waits in **Deferred**, in Approvals.

**Upcoming** in the agent sheet lists everything scheduled: each row says when it runs, where it runs ("in its own session" or "in the main session"), where results go, and the next run time. Controls:

- **Run now** runs it at once.
- The **⋯** menu has **Pause**, **Resume** and **Delete**.
- Reminders have **Snooze** (one hour) and **Done**.

Psyche also creates a few system automations itself: the Feed's daily brief and the Ideas jobs (see [Feed, Ideas and Goals](/using/feed-ideas-goals)).

From the CLI:

```bash
psyche automations list
psyche automations run <id>
psyche automations pause <id>
psyche automations resume <id>
```

`psyche automations list --kind cron` filters by kind (`cron`, `interval`, `watch`, `heartbeat`, `briefing` or `reminder`).

### Unattended runs

An automation runs with nobody watching. The agent is told so, and:

- It cannot ask you questions; question cards are not offered to it.
- Any action that needs approval is **not attempted**. It is set aside, the run carries on without it, and one notice covers every waiting action: "N actions are waiting from your automations".
- If there is nothing worth telling you, the run ends silently.
- Notifying you of the result needs no approval.

### Keeping the computer awake and retries

Settings → Daily → "Keep this computer awake" is off by default. When it is on and a scheduled or automation run is in progress, the computer will not sleep until the run finishes. The display can still turn off. The hold is released as soon as no run is active, and it cannot outlive Psyche: the sleep block ends when the Gateway process exits. It works only on macOS; on other systems the setting does nothing.

If a scheduled run fails with a temporary model error (the provider is overloaded, rate limiting, or a server error such as 429, 500, 502, 503, 504 or 529), Psyche tries again up to three times, after about 1, 5 and 15 minutes (a little random extra time is added). Scheduled shows "Retrying at" with the time of the next try, and "Failed after N retries" when it gives up. Psyche does not retry:

- an auth or request error (for example 401 or 400);
- a run that already took an action (a tool call, such as a message sent or a file changed), because running it again could repeat that action;
- a run you started yourself with "Run now".

## What it asks you

- **Starting a background Task:** a "Start background task" card.
- **Creating an automation:** a card for the schedule, every time.
- **Inside a Task:** the same cards as in chat. A Task adds the scope **Allow for this task**, which covers the same kind of action on the same target until the Task ends (at most 24 hours, or 8 hours for destructive actions).

### The approvals queue

Open the agent sheet, then **Approvals**, or press ⇧⌘P. It has four sections:

- **Needs you:** full approval cards waiting for an answer.
- **Deferred:** routine actions that unattended runs set aside: writes of notes, documents, tables and images (Markdown, text, CSV, PDF, Office files, pictures) outside hidden, tool, package, skill and prompt folders, a commit of exactly such files, or a new branch, each with the automation, the action, the full path, and when it was set aside, plus **Approve** and **Decline**. **Approve all routine ones** approves only these rows, and the Gateway checks each one again. Sensitive actions, payments, folder requests, permanent deletions and messages you can edit keep their full card under **Needs you**, and a payment asks for Touch ID or your password as it always does. Actions waiting for an answer on another device show here as "Answer where it was sent".
- **Recent:** decisions from the last 7 days and where they were answered.
- **Standing grants:** how many site, session and always grants are active.

Cards expire 30 minutes after they are issued. An expired card says "Expired. Nothing was done." and the Task stays resumable.

Automations do not raise one notice per action. Waiting actions share one notice, "N actions are waiting from your automations". Its count updates in place while it is open. If you dismiss it, it comes back when a new action is set aside, or after four hours. When nothing is left waiting, it closes.

An automation's run does not wait for you: it sets the action aside and finishes without it. Approving a set-aside action runs the automation again. The action goes ahead once, and only if that run reaches exactly the same action (same file and content, same commit). If the run does something different, nothing is done, you get a notice, and the automation asks again next time it needs to. You also get that notice when the approval runs out first, when you pause or remove the automation in the meantime, or when Psyche restarts before the run. Approving never restarts an automation you paused or removed: Approve says it can't run instead.

## Limits today

- **Edit** an automation from Scheduled. It opens the automation form. There is no run history in the CLI.
- Webhook delivery posts the run's output once you approve its card.
- The heartbeat, a light check-in every 30 to 60 minutes, is built but not scheduled, so it does not run.
- **Open activity** on a task card opens the thread. Under Standing grants there is no "Review in Permissions" link. Open Activity with ⇧⌘A and Settings → Permissions directly.
- There is no `psyche` CLI command for Tasks.

## Learn more

- [Approvals guide](/guides/approvals)
- [Approvals and tiers](/security/approvals-and-tiers)
- [Audit log](/security/audit-log)
- [CLI reference](/reference/cli)
- [Activity, Approvals and Upcoming in the UI design](https://github.com/devmello/psyche/blob/main/docs/06-ui-design.md#314-activity)
- [Task engine in the architecture](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md#45-task-engine)
