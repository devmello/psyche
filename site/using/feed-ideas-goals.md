---
title: Feed, Ideas and Goals
---

# Feed, Ideas and Goals

These three surfaces are the agent's proactive side. The **Feed** is a short daily brief of posts the agent writes for you, with sources. **Ideas** are things the agent suggests it could do, based on what you do. **Goals** are things you are working toward, with milestones and check-ins. All three are bounded: nothing is created, sent or bought without your confirmation.

## Turn it on

They are on by default. Open them from the left rail: **Feed**, **Ideas** and **Goals**.

Psyche schedules three system automations when the Gateway starts:

| Job | When |
| --- | --- |
| Daily brief | Every day at 07:00 |
| Ideas: nightly mining | Every day at 02:30 |
| Ideas: delivery window | Every day at 09:00 |

They appear in Upcoming in the agent sheet (see [Tasks and automations](/using/tasks-and-automations)). The times are fixed today.

## What it can do

### Feed

The Feed shows the day's brief as post cards. Each post has a title, a body with numbered citations and its sources.

- **Like** and **Save** a post.
- **Ask {name}** opens a side chat about the post (with your agent's name).
- **More** has **Follow: topic**, **Not interested** and **Hide source**. Your feedback goes into the interest ledger, `interests.md`, at once, with an **Undo** toast.
- Before the first brief, the Feed offers **Generate the first brief**, or you can wait until 07:00.

Sources today are RSS and Atom feeds, Hacker News and arXiv. Hacker News and arXiv are on by default. Add RSS feeds with the `feed.sources` setting, for example:

```bash
psyche config set feed.sources '{"rss":["https://example.com/feed.xml"],"hackerNews":true,"arxiv":false}'
```

What the Feed writes about follows `interests.md`: one topic per line, with a weight and a reason. Edit it in any editor, in `~/.psyche/workspace/`.

::: info Screenshot placeholder
The Feed with a briefing post: title, body with citation markers [1] [2], a row of source names, and the Like, Save and Ask buttons.
:::

### Ideas

Ideas are mined each night from what you do and delivered in the morning. Each card says what the agent suggests and why.

- **Let's do it** turns the idea into a task card in the main chat. For a task idea, you can make it repeat daily, weekly or monthly.
- **Dismiss** offers **Not now**, **Not interested** and **Never from this source**. Dismissed patterns are learned from.
- A skill draft has **View SKILL.md**. A draft stays a draft until you install it (see [Skills](/using/skills)).

### Goals

- **Suggested goals.** When the agent infers a goal, it shows a candidate with **Confirm**, **Not a goal** and **Later**. Nothing is created before Confirm.
- **A goal's page** has Milestones, Plan, Tasks, Check-ins, Watches and Notes. The list shows each goal's next check-in.
- **Creating a goal.** Ask in chat, for example "I want to run a half marathon in May". The agent proposes it and you approve.

### What the agent can do with them

In chat, the agent can read your goals, ideas and Feed without asking. Changing them asks: proposing a goal, updating progress, adding a check-in, accepting, dismissing or snoozing an idea. Only you, as the owner, can have it change them.

## What it asks you

- **Creating or changing a goal, or acting on an idea** from chat: an approval card.
- **Let's do it** on an idea: the task it creates asks for whatever it needs, like any other Task.
- **Confirm** on a suggested goal is your approval; nothing else is needed.

Feed posts are written from untrusted content (web pages and feeds). Text in a source cannot instruct the agent, and asking about a post in a side chat starts with that content marked as untrusted. See [Untrusted content](/security/taint).

## Limits today

- The Feed header buttons **What should I write about** and **Schedule** do nothing yet. Edit `interests.md` directly; the brief time is fixed at 07:00.
- There is no screen to manage Feed sources; use the `feed.sources` setting. Bluesky, saved items and your connected accounts are not Feed sources yet, and there is no web search to fill gaps.
- **Edit** on an idea is shown but disabled. Ideas do not use signals from connectors yet, since connectors cannot be connected.
- On Goals, **Add a goal** does nothing; ask in chat instead. Deleting a goal is not available in the app.
- The heartbeat check-in is not scheduled, so the agent does not check in on its own between briefs.

## Learn more

- [Tasks and automations](/using/tasks-and-automations)
- [Memory](/using/memory)
- [Release notes 0.2](/release-notes/0.2)
- [Feed, Ideas and Goals in the UI design](https://github.com/devmello/psyche/blob/main/docs/06-ui-design.md#39-feed)
- [Scheduler and proactivity in the architecture](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md#411-scheduler-and-proactivity)
- [Proactive package](https://github.com/devmello/psyche/tree/main/packages/proactive)
