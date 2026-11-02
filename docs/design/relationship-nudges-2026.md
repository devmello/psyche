# Relationship nudges: keeping in touch (2026)

Status: design, 2026-11-02. Builds on everything memory (`docs/design/everything-memory-2026.md`,
decisions §14 are binding) and the people features merged in #1058–#1088.

## 1. What this is

Psyche notices the people you are drifting away from or owe something to, and nudges you. Four
kinds, each one plain sentence:

| Kind | Example | Where it comes from |
| --- | --- | --- |
| **Unanswered** | "You haven't replied to Priya's message from 9 days ago." | The latest one-to-one message or mail from a two-way contact came in, and nothing from you went out after it. |
| **Drifting** | "You usually talk to Sam every 2 weeks; it's been 6." | The usual gap between your contact days with that person, against the current gap. Timestamps only. |
| **Birthday / anniversary** | "Alex's birthday is Thursday." | Accepted `birthday` and `anniversary` facts you confirmed (or wrote). |
| **Promise** | "You told Jordan you'd send the deck. Did you?" | An open loop where you owe something, written down from your own words. |

Nothing is sent for you. A nudge can open a chat with a draft request filled in; you press send.

## 2. Rules it must keep (from everything memory §9, §10, §14)

1. **Owner only.** Nudges are shown to you. The agent does not read them, and a nudge never
   widens what the agent can see.
2. **Sensitive facts are never used.** Only `birthday` and `anniversary` facts with sensitivity
   `none` are read. Promise text that looks sensitive (health, money, IDs, secrets) is skipped.
   No other fact about a person is used to write a nudge.
3. **Excluded contacts never surface.** A person with an exclusion (or "forget"), a blocked
   identifier, a hidden entity, or a "Not this person" mute gets nothing, in any surface.
4. **Others' text is data.** A nudge sentence is built from a name, a number of days and a
   fixed template. It never contains a subject line or message text, and nothing in a nudge is
   ever treated as an instruction. Names are cleaned like any header (control and zero-width
   characters, length cap).
5. **Pending and unreviewed facts about others are skipped.** The store's accepted-only reader
   is the only way facts are read here.
6. **Two-way only for message signals.** "Unanswered" and "drifting" need a person you have both
   written to and heard from (`two_way`, §10.1). One-way senders, bulk mail and group chats never
   count. Only one-to-one threads count as unanswered.
7. **Off until you say so.** The switch is off for everyone, including after an update. Turning
   it on shows what it does first; the answer is stored with the date.

## 3. Deterministic signals (no model)

All four are computed from the people graph: interactions (headers and timestamps, never
bodies), accepted facts and loops. No search index read is needed, because the Mail and
Messages ingest already writes one interaction per message (mail) or per conversation per day
(Messages) with direction and thread. This also means last-contact dates and cadence work for
people whose bodies were never read.

**Unanswered.** For each two-way person, take their newest one-to-one mail or message
interaction. If it is inbound (`in`), nothing from you came after it with that person, and it is
older than N days and newer than 45 days, it is a nudge. N follows the sensitivity setting:
low 7, normal 5, high 3 days. (A Messages day where you also spoke is `both`, which counts as
answered.)

**Drifting.** Take the person's contact days over the last 365 days from mail, messages and
calls (meetings and notes do not count; being in the same calendar event is not keeping in
touch). Days within 3 days of each other count as one episode. Needs at least 5 episodes
spanning at least 60 days. The usual gap is the median gap between episodes. It is a nudge
when the current gap is at least `factor × usual` and at least a floor: low 3× and 28 days,
normal 2.5× and 21, high 2× and 14. It stops after 180 days of silence or 12× the usual gap
(people who faded are not nagged about) and when the usual gap is under 5 days (daily chatters
are not "drift").

**Birthday / anniversary.** Dates within 7 days (today counts), read with the existing
"Coming up" parser. A birthday nudge shows even if you talked yesterday.

**Promise.** Open loops where you owe something (`i_owe`) with a person attached, from your
own words (owner or agent provenance from owner-authored text, never `untrusted`), at least 2
days old or past due. Shows your own words, trimmed.

**One nudge per person**, ranked: birthday within 3 days, promise, unanswered, drift, birthday
4–7 days. Ties go to the newest. Dedupe by a stable key (below).

## 4. State: snooze, done, mute

One small settings record, `nudges.state`, holding only ids and dates: no names, no text.

- `done[id]`: you pressed Done. A nudge id includes its anchor (the message it answers, the
  contact day it drifted from, the date of the birthday, the loop), so a new message or a new
  year makes a new id and the old Done does not hide it.
- `snoozed[id]`: until date (1 week or 1 month).
- `muted[entityId]`: "Not this person". Stops every kind for that contact. Reversible from the
  person page. It holds only an id, so it stays inert if that person is later forgotten.
- `posted[id]`: a Feed card was made for it, so it is not posted twice.

Entries older than 120 days are pruned (mutes stay).

## 5. Surfaces

1. **Daily brief**: a "Keep in touch" section, at most 3 lines, after "Coming up". Each line
   links to the person.
2. **Feed**: one silent card per new nudge, at most 3 new cards a day, never during quiet hours.
   Actions: **Draft a reply** (opens Chat with a request prefilled; nothing is sent),
   **Snooze** (1 week / 1 month), **Not this person**, **Done**. Drifting and birthday nudges
   say **Draft a message** instead of "reply". Resolved cards show a one-line result. Colour is
   the ink direction: paper background, one accent (ink `#2c5aa0`) on the primary action,
   amber only for "needs you" (a promise past its due date).
3. **Person page**: a "Keep in touch" row under "Coming up" with the current nudge (if any),
   its actions, and a "Nudges for {name}" mute switch.
4. **Settings → People**: a "Relationship nudges" group: the switch (with the first-run
   consent text), a sensitivity choice (Gentle / Normal / Eager = low / normal / high), and a
   note that quiet hours are the ones in Settings → Notifications.

## 6. Where it runs

- Signals, state and wording: `packages/memory/src/graph/nudges.ts` (pure functions over the
  graph; takes a clock; no I/O).
- Gateway: `apps/gateway/src/compose/nudges.ts` reads settings, applies the exclusion and quiet
  hours checks, posts Feed cards, serves `nudges.list`, `nudges.act`, `nudges.mute`, and
  provides the brief's `keepInTouch` lines. A refresh runs at start, with the morning brief,
  and every 6 hours.
- Protocol: `NudgeItem`, `NudgeAction`, three methods and `refs.nudgeId` on a Feed post.
- UI: a Feed nudge card, a person-page row, a Settings group. Chat prefill uses the existing
  `usePrefillComposer`.

Settings keys (flat, like `daily.*`): `nudges.enabled`, `nudges.consentedAt`,
`nudges.sensitivity` (`low` | `normal` | `high`, default `normal`). Quiet hours are the owner's
general ones.

## 7. Not in this version

- **Model phrasing.** Sentences come from templates, so they are predictable, testable and cannot
  carry third-party text. A later option could rewrite them with the model chosen in everything
  memory's setting, over the template output only (owner-authored or accepted data).
- Notifications (pushes). Cards are silent; the brief carries them.
- Per-kind switches, per-person cadence overrides, "remind me every N weeks".

## 8. Tests

Fixture graphs: each signal fires on the example data and stays quiet otherwise (answered mail,
group chat, bulk, one-way sender, daily chatters, faded contact); excluded and muted contacts
and hidden entities get nothing; sensitive and pending facts are never used (birthday marked
`health`, pending birthday, quarantined); snooze and done persist and expire; mute persists and
undoes; the brief shows at most 3; the Feed posts at most 3 a day and never twice, and not in
quiet hours; off by default and before consent; nudge text never contains a subject line.

## 9. Conversation starters (added 2026-11-02)

When a nudge says to reach out, it can also say what to talk about: up to three short lines, each
with a line showing where it comes from.

> Ask how the new job at Initech is going
> *Employer: Initech · their own words, accepted by you · Oct 12*
>
> You promised: “send the deck”
> *Your promise · Oct 28*

**What can be a starter** (deterministic templates, `packages/memory/src/graph/starters.ts`):

- The owner's own open commitments to that person ("You promised…"), and things the owner noted
  they are waiting on. Never a promise or note that came from someone else's text.
- Accepted facts with no sensitivity class, from a short fixed list: life event, employer (or
  role when no employer), school, city, pets, children and partner by name, likes. A noted gift
  idea only on a birthday or anniversary nudge. Nothing else is read: no free-text notes, diet,
  hometown, contact preferences, or anything from a fact still waiting for review.
- A promise nudge leaves its own promise out of its starters.

**Order**: promise, gift idea, life event, employer, role/school, city/pets/family, likes. At most
three. **With too little known there are none**: the card shows its actions and no starters, never
a generic line like "ask how they're doing".

**Evidence line**: attribute, value, how it became known ("you told Psyche", "from Contacts",
"learned from your own words", "their own words, accepted by you") and the date. It never contains
the quote a fact was cited from, a subject line, or anything else from a message. Values are one
clean line, skipped when they look like an instruction or hold something sensitive.

**Where**: the Feed card, the person page row, Home and People's Keep in touch (they all share the
nudge actions), and inside "Draft a reply": the chat gets the starters with their sources as
context and is told to use only those and invent nothing. Nothing is sent.

**Optional rewording** (`nudges.phrasing`, off by default, Settings → People & projects): the
model chosen in everything memory (None means this does nothing; a local model must be confirmed)
rewrites the starter lines in friendlier words. It sees only the starter sentences, with no tools.
A reworded line is kept only if it is one short line with no link or address, repeats the words of
the fact, and adds no capitalised word or number that was not in the original; otherwise that
line keeps its template. The evidence line is never reworded, and reworded text is kept in memory
only.
