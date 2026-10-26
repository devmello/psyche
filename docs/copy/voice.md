# Voice and copy style guide

Status: v0.1 (2026-10-19). Owner: S20. Applies to every string in the desktop app, the web UI, OS notifications, channel messages that Psyche (not the agent) sends, the CLI's human-readable output, and the workspace templates. Source rules: `docs/06-ui-design.md` §4.12–4.13 and §3.0.

## Two voices

| Who speaks | Where | How |
| --- | --- | --- |
| **The agent** (the persona: Wren, Pip, "Psyche" if unnamed) | Chat messages, Feed posts, Idea cards, reminders, status lines | First person, in the tone set by `SOUL.md`. It names itself only when needed. |
| **Psyche** (the application) | Banners, settings, approval cards, question-card chrome, errors, empty states, OS notifications, toasts, onboarding | Neutral, second person, present tense. Refers to the agent by name as a subject ("Wren needs your approval"), never speaks *as* it. |

The approval card is always in Psyche's voice. It must read the same whatever persona or model is running, because it is the owner's trust boundary.

When the agent has no name yet, use "your agent" in Psyche copy until onboarding step 1 is done, then the chosen name. If the owner kept the default, the name is "Psyche"; write "Psyche" for both voices and avoid sentences where the two collide ("Psyche asked Psyche…"): prefer "Approval needed" over "Psyche needs your approval" in that case.

## Rules

1. **Short, specific, second person.** "Wren needs your login for acme.com." Not "Credentials are required to proceed."
2. **Name the exact target.** Recipient addresses, domains, file paths, amounts with currency, commands in code font, dates with day and timezone when ambiguous. Never truncate a recipient, amount, command or URL on an approval surface.
3. **Errors say three things:** what happened, what Psyche did about it, and what you can do. "The model returned an error (rate limited). Psyche did not fall back because you chose this model. Try again or pick another."
4. **Empty states are one sentence plus one action.** "Nothing needs you." "No tasks yet." No illustrations of sadness, no jokes.
5. **Receipts are facts.** "Sent to jane.ortiz@example.com · Gmail id 18c4… · 10:07". No "Successfully!", no checkmark emoji in text.
6. **Proactive items carry a "Because:" line** naming the evidence: "Because: you asked about robotics 6 times in September."
7. **No exclamation marks.** No "Oops", "Uh-oh", "Whoops", "Hmm". Psyche never apologizes ("Sorry, something went wrong"); it states what happened. The agent may apologize in its own voice when it made the mistake.
8. **No marketing.** No "magic", "seamless", "supercharge", "effortless", "AI-powered", "smart". Don't describe features; let the button say what it does.
9. **Buttons are verbs that say the outcome.** "Allow once", "Deny", "Take control", "Stop the task", "Open in Library". Not "OK", "Submit", "Continue" when a specific verb exists. Destructive buttons name the object: "Reset Wren", "Delete 3 threads".
10. **Sentence case** for everything: titles, buttons, menu items, settings labels. Proper nouns keep their case (Gmail, Touch ID, iMessage).
11. **Numbers and time.** Numerals for all numbers. Times in the owner's locale; relative ("in 28 min", "2 h ago") in lists, absolute in receipts and cards. Countdown as `mm:ss` under one hour.
12. **Plain words for security.** Say what will happen, not the mechanism: "Wren will type your saved password for github.com into this page" rather than "Credential fill via placeholder resolution". Mechanism details live behind "Details".
13. **Say "can't", not "unable to"; "won't", not "will not be able to".** Contractions are fine everywhere except legal text.
14. **Don't blame the owner.** "That folder isn't shared with Wren" rather than "You didn't grant access".
15. **Consistent nouns.** Use the glossary below; don't invent synonyms.

## Glossary of user-facing terms

| Use | Not | Meaning |
| --- | --- | --- |
| approval | permission request, consent | An ApprovalRequest card |
| allow once / allow for this task / allow for this site / always allow / deny | approve, accept, reject | Grant scopes on the card |
| task | job, run, workflow | A Task in Activity |
| step | span, event, action (in the chat) | One thing the agent did inside a task: thought, used a tool, asked, waited (docs/design/run-trace-2026.md §3.1) |
| Timeline | trace, run view, log | The full view of one task's steps over time, in the agent sheet |
| helper | subagent, child agent | Work the agent handed to a parallel copy of itself |
| automation | cron, routine, schedule | A scheduled job in Upcoming |
| receipt | log, confirmation | The record of an external write |
| Library | files, drive | `library/` |
| Soul & Memory | settings, brain | The agent sheet's memory screen |
| take control / hand back control | pause, override | Browser and VM takeover |
| vault | password store, keychain (unless it is the system keychain) | Psyche's credential store |
| connector | integration, plugin | Gmail, Calendar, Slack, MCP servers |
| channel | integration, bot | Telegram, iMessage, WhatsApp… |
| side chat | thread, conversation | Non-main threads |
| sandbox | container, VM | Where commands run |
| Mac inside Psyche / VM mode | virtual machine (in onboarding) | VM mode |

## Formatting conventions

- Domains bare in prose (`acme.com`), full URLs on approval cards.
- Code font for commands, paths, file names and tool names: `npm install`, `~/Projects/psyche`, `SOUL.md`.
- Ellipsis character `…` for truncation, only where truncation is allowed (never on cards for targets).
- Middle dot `·` to separate facts on one line in receipts and list rows.
- Placeholders in this folder: `{agent}` persona name, `{owner}` owner's name, `{site}` domain, `{task}` task title, `{n}` a number, `{time}` a formatted time. Implementers substitute them; they never reach the user raw.

## The agent's voice, briefly

The agent's tone comes from `SOUL.md`, but every persona shares these defaults so the product feels consistent:

- Answer first, detail after.
- Exact names, times, amounts and links.
- Status lines are present participle plus object, under 48 characters: "Comparing 4 flights to Chicago".
- It reports from receipts and says "outcome unknown, not retried" when it doesn't know.
- It never asks "may I?" in chat for an action that will get an approval card; it says what it is about to do.
