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
- **Closing the window** does not stop a Task. "Quit Psyche (tasks keep running)" closes the app; the Gateway keeps working.
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
- Any action that needs approval is **not attempted**. It is queued, the run carries on without it, and you get one notification: "Approval needed: …".
- If there is nothing worth telling you, the run ends silently.
- Notifying you of the result needs no approval.

## What it asks you

- **Starting a background Task:** a "Start background task" card.
- **Creating an automation:** a card for the schedule, every time.
- **Inside a Task:** the same cards as in chat. A Task adds the scope **Allow for this task**, which covers the same kind of action on the same target until the Task ends (at most 24 hours, or 8 hours for destructive actions).

### The approvals queue

Open the agent sheet, then **Approvals**, or press ⇧⌘P. It has four sections:

- **Needs you:** full approval cards waiting for an answer.
- **Deferred:** what unattended runs wanted to do but could not ask you, as "… wanted to …" rows. Approvals you can answer on this device show under Needs you instead.
- **Recent:** decisions from the last 7 days and where they were answered.
- **Standing grants:** how many site, session and always grants are active.

Cards expire 30 minutes after they are issued. An expired card says "Expired. Nothing was done." and the Task stays resumable.

## Limits today

- There is no form to create or edit an automation. Ask the agent, or use `/schedule`. **Edit** in Upcoming is not available, and there is no run history in the app or the CLI.
- Delivering an automation's results to Telegram falls back to an in-app notification, and webhook delivery does nothing.
- The heartbeat, a light check-in every 30 to 60 minutes, is built but not scheduled, so it does not run.
- Some links in the agent sheet do nothing yet: **Open activity** on a task card, **Open task** on a Deferred row, and **Review in Permissions** under Standing grants. Open Activity with ⇧⌘A and Settings → Permissions directly.
- There is no `psyche` CLI command for Tasks.

## Learn more

- [Approvals guide](/guides/approvals)
- [Approvals and tiers](/security/approvals-and-tiers)
- [Audit log](/security/audit-log)
- [CLI reference](/reference/cli)
- [Activity, Approvals and Upcoming in the UI design](https://github.com/devmello/psyche/blob/main/docs/06-ui-design.md#314-activity)
- [Task engine in the architecture](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md#45-task-engine)
