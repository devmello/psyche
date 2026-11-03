# Onboarding 2026: a shorter setup that covers the new features

Status: decided 2026-11-03 (owner request: "Clean up the onboarding and create a smooth process
which includes setting up all these new features"). Keeps the ink direction
(`docs/design/redesign-2026.md`): accent `#2c5aa0` through the existing tokens, paper grays, one
accent per view, amber only for "needs you". Follows "simple first, powerful one step away"
(`docs/design/consolidation-2026.md`).

## 1. The problem

Setup had twelve steps (eleven on the web): agent, about, permissions, connectors, mail, sandbox,
model, where, memory, wins, habits, done. Three things were wrong with it.

- **Too long.** Most steps held one decision. Two of them wrote nothing: "Where the agent works"
  recorded a choice no code read, and "First wins" ran starter tasks that "What can you do?"
  already offers.
- **Permissions up front.** Access is granted when the agent asks in chat, one grant type at a
  time. Walking through Accessibility and Screen Recording before the owner has seen the agent do
  anything is the opposite of that.
- **Missing the new features.** Work tracking, where memory shows, Touch ID for approvals and the
  link between the daily habits and the reminders that depend on them could only be found in
  Settings.

## 2. The new flow

Six steps. Each is one screen with one job; anything that is not needed to get going is behind a
disclosure ("More about you", "Customize look", "Bring memory from ChatGPT or Claude", "Set up a
sandbox").

| # | Step id | Title | Skippable | What it holds |
| --- | --- | --- | --- | --- |
| 1 | `you` | You and your agent | Skip for now | Language, your name, the agent's name with three suggestions. Disclosures: Customize look (creature, description, tagline) and More about you (time zone, work, city) |
| 2 | `stuff` | Your stuff | Skip for now | Connect accounts (the existing Connectors step, Mac apps first). Once a mail account is connected the mail and meetings switches appear below it, on the same screen |
| 3 | `model` | Choose a model | No (the agent needs one) | The existing Model step, unchanged |
| 4 | `memory` | Memory and daily habits | Skip for now (writes nothing) | Morning brief, evening wrap-up, follow-ups. Track my work (consent card), and once it is on, "Remind me what is due tomorrow". Include people in my brief. Disclosure: bring memory from ChatGPT or Claude |
| 5 | `safety` | Safety | Skip for now | Touch ID key (desktop), notifications for approvals (desktop), a line on what asks first, an optional sandbox |
| 6 | `done` | You're set | n/a | What was set up, the setup checks, and things to try (Search ⌘K questions, Catching up on Home, What can you do?) |

Removed: **Permissions** (Accessibility and Screen Recording are asked for in chat, the first time
the agent needs them; Notifications moved to Safety), **Where the agent works** (VM mode is set up
in Settings → VM), **First wins** (the "What can you do?" cards run the same tasks) and **Mail**
as its own screen (now a section of Your stuff).

Order: model comes after the accounts, as before, because the owner has by then seen what the
agent will work with. The setup check on Done binds the model, as before.

## 3. What each step writes

Nothing is written until Done, except two things that are actions in themselves (registering the
Touch ID key, asking macOS for Notifications). The host writes through the same Gateway calls
Settings uses.

| Step | Writes | Call |
| --- | --- | --- |
| you | `IDENTITY.md` name, creature, tagline (first run only); `USER.md` name, time zone, work, home city; `ui.language` at once | `memory.write`, `settings.set` |
| stuff | Connectors through the real sign-in; `mail.digest.enabled`, `mail.digest.time` (first run only), `meetings.prep.enabled`, `mail.followups.enabled`, `mail.voice.enabled`, `meetings.notes.enabled` | `settings.set` per key |
| model | Primary and utility model role, key in the vault, on the Done check; a re-run leaves the step out, and the role alone, when a ready primary model is set | `models.setRole`, `models.setKey` |
| memory | `daily.brief.enabled`, `daily.wrapup.enabled`, `daily.followups.enabled`; `memory.work` (`enabled`, `consentedAt`, `remind.enabled`; other fields kept); `memory.surfaces` (`tiers.people.brief`; other fields kept). Only a setting that changed is written. Imported memories after review. "Skip for now" on this step writes none of it | `settings.set`, `memory.import`, `memory.claims.confirm` |
| safety | The Touch ID key for the bundled helper; the development-key switch `devices.presence.allowDevFileKey` only on a build that needs it and only when the owner flips it; the Notifications grant | `devices.presenceKey.register`, `settings.set`, macOS |
| done | `ui.onboarding.completedAt`, then the agent's first message (first run only) | `settings.set`, `chat.greet` |

Progress is still saved on every step change (`ui.onboarding.progress`). Progress saved by the
old twelve-step flow maps to the nearest new step, so an owner who quit midway resumes in the
right place.

## 4. The new features in setup

**Work tracking** (`memory.work`). Off by default. Turning the switch on opens the same one-screen
consent card Settings uses (`WorkConsent`, reused, not copied); confirming records `consentedAt`.
Cancelling leaves it off. The switch's hint uses the general examples: bills, rent, taxes,
renewals, work deadlines and homework. Reminders lists and folders are chosen later in Settings →
Memory → Work, because a list has nothing to feed until a project exists.

**Where memory shows** (`memory.surfaces`). One question: "Include people in my brief?" It is off.
Turning it on shows the same warning Settings shows ("anyone who sees your screen") and writes
`tiers.people.brief`. Work on Home and in the brief, and birthdays, keep their defaults and need no
question.

**Daily habits.** The brief, the wrap-up and follow-ups. Due-soon reminders (`memory.work.remind`)
are sent with the evening wrap-up, so once work tracking is on the step offers "Remind me what is
due tomorrow", and when that is on while the wrap-up is off the screen says nothing will be sent,
with a one-click "Turn on wrap-up" that flips the same switch, exactly as Settings does. Including
people in the brief with the brief off says so the same way.

**Touch ID for approvals.** The helper's key must be registered once. On the desktop, when the
bundled helper reports a key, the step shows its short id and one button, "Register this key". On
a build without a provisioning profile the helper reports a Secure Enclave file key; the step then
says it is a development key and asks for the "Allow a development Touch ID key" switch first, as
Settings → Devices does. If the helper is still starting, the step says so and offers "Check
again". On the web, or when the build bundles no helper, the row is not shown at all.

**Read-only commands, sandbox.** Safety says in one sentence that commands which only read run
without a card once the owner lets the agent run commands on this Mac, and that anything else asks
first. The security switches themselves stay in Settings → Computer use because changing them
needs fresh presence. The sandbox is one disclosure away and uses the same guided setup as
Settings.

**Answers that cite your life, Catching up.** Mentioned on Done as things to try, not asked.

**Skip for now** on a step means "leave this as it is". On the Memory step it is literal: the
switches the owner touched there are not written, so the brief stays off unless it was already on.

## 5. "Run setup again"

Settings → About → Run setup again opens `/onboarding`. For an existing owner it is a tour of
what can be turned on, not a reset.

- **Every step is shown, pre-filled** from the current settings: name, time zone, work and city
  from `USER.md`; the habit switches; the mail switches; work tracking and people; connected
  accounts from the Gateway. Nothing is reset to a default.
- The **agent's name and look are not shown** (they are edited in Settings → Agent) and
  `IDENTITY.md` is not rewritten.
- The **model step is left out** when a primary model is set and ready; the Done check then only
  reads it. The owner can change it in Settings → Models.
- The **mail digest time** is written only on first run, so a time chosen in Settings survives.
- Work consent is kept: an owner who already consented does not see the card again.
- The step menu still lets the owner jump to any reached step, and Done lists what is set.

## 6. Behavior

- One centred 560 px column, a quiet "2 of 6" that opens the step menu, Back and Next at the
  bottom, "Skip for now" beside Next on every skippable step. No step dots, no gradients, no
  emoji.
- Focus moves to the step heading on every change; Back, Next and Skip are real buttons in tab
  order; the step menu opens with Enter or Space. Enter inside a text field does not advance (a
  step may hold several fields).
- Steps slide with the existing 24 px spring; under `prefers-reduced-motion` they appear without
  motion (the existing `motion-safe` utilities).
- Disclosures are plain buttons with `aria-expanded`. Nothing important hides behind one.
- Every string is in `packages/ui/src/i18n/messages/onboarding.ts`.

## 7. Out of scope

Choosing Reminders lists or folders for work, the digest and wrap-up times, the people switches
for Home and notifications, and the remote-gateway pairing stay in Settings. The first-run welcome
screen and "Restore from a backup" in `docs/copy/onboarding.md` are separate work.
