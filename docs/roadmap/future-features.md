# Future features

Status: plan, 2026-11-02. Nothing in this file is promised for a date. It collects eight features the owner has asked for, in plain language, with what is already built, what is left, and what each one depends on.

This sits next to [08-roadmap.md](../08-roadmap.md), which holds the milestone plan up to v1.0 and the short "After 1.0" list. Items here are the ones that need more than a line. When one gets a design doc, link it here and keep this entry short.

Each entry has the same parts: what it is, why it beats existing assistants, rough phases, open questions and dependencies.

## 1. Answers that cite your life

**What it is.** Ask a question in Search or ⌘K ("when did Sam say the contract would be ready?", "what did I promise Priya?") and get a short answer built from your own mail, messages, files and memory. Every claim in the answer carries a citation chip. Click a chip and you see the source: the message, the file, the fact and when Psyche learned it.

**Why it beats existing assistants.** Cloud assistants either can't see your mail and messages, or they see them and answer without showing where a claim came from. Psyche already keeps the sources on your machine, so it can show every source and refuse to answer when it has none. An answer with no citation is not shown as an answer.

**What is built (as of 2026-11-02).**
- The Life search group (by name and by words) is merged: [#1078](https://github.com/devmello/psyche/pull/1078).
- Search by meaning and a grounded answer are merged: [#1087](https://github.com/devmello/psyche/pull/1087). The method is `memory.life.answer`. It answers from reviewed, non-sensitive facts about people, cites each claim to a fact, and returns no answer, with a reason, when the model is off, no fact matches or the reply cites nothing it was given. Sensitive facts never go to a model.
- The answer card in Search and ⌘K (phase 1): for a query that reads like a question it asks `memory.life.answer` and shows the answer above the results, a citation chip after each claim (one chip with a count when a claim rests on several facts), the fact and when Psyche learned it under the chip, a plain reason when there is no answer, and "Open as a chat". The chip opens the fact inline with "Open in Memory"; it does not yet scroll to or highlight the fact on the person's page.
- Open the source (phase 2): a fact's citation now carries its search document id (`docId` on `LifeFactHit`). The chip's fact has "Show source", which opens a read-only source panel (`search.document`: the indexed text, its source and date; for Messages the conversation day). Search results from the local sources (Mail, Messages, Notes, Calendar, Reminders, Contacts, files), which had no route and were not listed, now show in Search and ⌘K under "Your sources" and open the same panel in the preview. Where there is a safe way, the panel adds one button, and only on the desktop: "Open in Mail" for a mail message (its Message-ID, kept at indexing time from the connector's own `message://` link, validated strictly, opened as `message://` through an allowlisted opener in the desktop main process; the general link policy still refuses `message:` and `file:`), and "Show in Finder" for a file inside a currently granted folder (real path, symlinks followed, never opened or run). The renderer sends only the document id; the Gateway (`search.openSource`, desktop connection only) resolves the target from the index and main checks it again.
- The index and the nightly memory pass behind it: [design/search-2026.md](../design/search-2026.md), [design/search-roadmap-2026.md](../design/search-roadmap-2026.md), [design/everything-memory-2026.md](../design/everything-memory-2026.md).

**What is left.**
- Phase 2 is in, with these limits. Mail indexed before this change has no stored Message-ID until it is read again (Settings → Search sources → Rebuild), so it opens in the panel only. Messages, Notes, Calendar, Reminders and Contacts have no safe deep link and open in the panel only. A file is shown in Finder, not opened. The panel shows the indexed text, not the live message, so it cannot show an edit made since. A fact with several citations opens the first one's source. The chip still does not scroll to the fact on the person's page.
- Today the answer cites facts. Citing the underlying mail, message or file passage (not only the fact derived from it) needs the passage to be reachable from the fact.
- Answers that cover raw mail, messages and files, not only reviewed facts about people.
- Follow-up questions in the same panel, and "open as a chat".

**Rough phases.**
1. The answer card in Search/⌘K for `memory.life.answer`, with chips that open the fact.
2. Chips that open the source passage in Mail, Messages or the file viewer. (Done: see "What is built".)
3. Questions that need raw passages as well as facts, with the same rule: no citation, no claim.

**Open questions.**
- How to show a claim that rests on several facts, without a wall of chips.
- What to show when the facts disagree, or when the newest one is still waiting for review.
- Whether the answer panel is also available to the agent in chat, and how citations carry into the chat transcript.

**Depends on.** Everything-memory (graph, reviewed facts), the Life search index, an embedder or a model for meaning-based ranking, and the per-source permissions from [05-security-and-permissions.md](../05-security-and-permissions.md).

## 2. Teach by showing

**What it is.** You press Record, do a task once in the built-in browser or in a Mac app, and press Stop. Psyche turns the recording into a skill or an automation, shows you the steps in plain words for review, lets you fix them, and can schedule it ("every Friday at 4").

**Why it beats existing assistants.** Most assistants make you describe a task in words, or give you a script editor. Showing is how people already teach each other. The review step matters: the recording is turned into steps you can read and edit, not into a black box that replays clicks.

**What is built.** The pieces it stands on:
- Computer use on the Mac (accessibility snapshot, actions, screenshots, tiers and caps): feature spec J1–J6 in [03-feature-spec.md](../03-feature-spec.md), and the M2 computer-use work ([#212](https://github.com/devmello/psyche/pull/212)).
- The built-in browser, including the signed-in profile and background use ([#996](https://github.com/devmello/psyche/pull/996), [#1036](https://github.com/devmello/psyche/pull/1036)).
- Self-made skills and connectors, owner-approved and sandboxed ([#977](https://github.com/devmello/psyche/pull/977)), and agent-proposed skill drafts from repeated routines ([`packages/skills/src/drafts.ts`](../../packages/skills/src/drafts.ts)).
- Scheduled, and turning a task into an automation ([#1030](https://github.com/devmello/psyche/pull/1030), [#1002](https://github.com/devmello/psyche/pull/1002)).
- Teach mode is already named in the feature spec as **J8** (priority P2): "record a user demonstration (screens + AX events) into a reusable skill draft". This entry is that item, spelled out.

**What is left.** The recorder (events in the browser, accessibility events in Mac apps), turning a recording into steps, a review screen, replay with approvals, and scheduling.

**Rough phases.**
1. **Browser only.** Record clicks, typing and navigation in the built-in browser. Turn them into a draft skill that uses the browser tools. Show the steps; the owner edits and approves. Run it once with the owner watching.
2. **Mac apps.** Record accessibility events (J1/J2) in apps the owner has already granted. Same review screen.
3. **Generalize.** Ask which values were examples ("this recipient", "this date") and make them inputs. Offer "run it every week" through Scheduled.

**Open questions.**
- What gets recorded. Screens and typed text can hold passwords and private data. The recorder needs to skip password fields, mask what it stores, and keep the recording on the Mac, deleted once the skill is made unless the owner keeps it.
- What happens when the page or app changes later. Replay should stop and ask, not guess.
- Whether a recording becomes a skill (instructions the agent follows) or an automation (fixed steps), and who decides. Likely the skill by default, since an agent can recover from small changes.
- How this relates to the [teaching loop](../agent/teaching-loop-2026.md), which is about learning from feedback ("not like this"), not from demonstrations. They should share the lessons and marks, not the recorder.

**Depends on.** Computer use and the Accessibility permission, the built-in browser, the skills system and its approval cards, Scheduled, and the permission broker (each replayed action is checked like any other tool call).

## 3. Shared skills and connectors

**What it is.** Export a skill or an MCP connector as a bundle, send it to someone, and they import it. Before anything is installed, they see what it asks for: the tools it can use, the approval kinds it can trigger, the files it ships and the permissions it wants. Bundles are signed, so an update can be checked against the key the owner already trusted.

**Why it beats existing assistants.** Most assistants either have a central store you have to trust, or no sharing at all. Here sharing needs no store: a file, a URL or a git repo is enough. Permissions are shown up front, and nothing runs until the owner approves.

**What is built.**
- Skill install from a folder, a zip or a git URL at a pinned ref, with a scanner, a full-file approval card, a whole-tree hash re-verified on every load, and update checks. The code is in [`packages/skills`](../../packages/skills/src/lock.ts), and the protocol is in `packages/protocol/src/methods/skills.ts`. Trust levels today are `bundled`, `verified`, `local` and `unknown`.
- Third-party skill and MCP descriptions are marked as "not instructions" in the prompt.
- Psyche can build its own skills and connectors with approval ([#977](https://github.com/devmello/psyche/pull/977)), which gives something worth sharing.
- The capability catalogue with an online-registry toggle ([#987](https://github.com/devmello/psyche/pull/987)), and connector install cards.

**Design and status.** [Shared bundles design](../design/shared-bundles-2026.md) (2026-11-04) answers the open questions below and records what is built. Phases 1 and 2 for skills are built there: the `.psyche-skill` file, signing with an author key, export, import from a file or an https link, the signer block on the trust card, "trust this author", the key-changed warning, the update diff, the "asks for more" warning and local revocation. Connectors (phase 3), signed revocation notices and lists (phase 4) are designed and not built; the list under "What is left" below is the original plan.

**What is left.**
- A **bundle format**: a skill or connector, its manifest, its requested permissions and a signature, in one file.
- **Signing and keys.** An author key, a "trust this author" step, and showing "signed by X, new key" or "changed key since last time".
- **Export** from Settings → Skills and Connectors.
- **Import from a file, URL or git** with the same trust card, for connectors as well as skills (skills already import from folder, zip and git).
- **Updates:** show what changed between versions, and require approval again when permissions widen.
- A way to find things without a central store: a share link, a pasted URL, or a git repo with a small index file.

**Rough phases.**
1. Export and import of skills as one file, with permissions shown before install. Unsigned bundles are `unknown`.
2. Signing and author trust. Updates with a diff and re-approval on wider permissions.
3. Connectors (MCP servers) in the same bundle format, including the command they run and the network and secrets they ask for.
4. Optional lists: a git repo or URL that lists bundles, with no server run by Psyche.

**Open questions.**
- What "verified" means when there is no central authority: a key the owner has trusted before, a key vouched for by someone they trust, or neither.
- Connectors run code. How much can we show about a connector's behavior before it runs, and should the first run always be in the sandbox?
- Whether bundles may carry secrets or settings (no, by default; only the names of what they need).
- Revocation: how an author tells people a bundle is bad, without a server.

**Depends on.** The skills trust work (`packages/skills`, the `skill_install` approval kind), the sandbox, the connectors layer ([connectors guide](../guides/connectors.md)), and the permission broker.

## 4. Relationship nudges

**What it is.** Psyche notices people you have gone quiet with and suggests, gently, that you reach out, with the context you'd want: when you last talked, what was open between you, and a draft if you want one. It is for friends, family and colleagues, not a sales pipeline. You decide who counts, and you can turn it off per person or entirely.

**Why it beats existing assistants.** Contact-reminder apps know a date. Psyche knows what you actually talked about, what you promised and what is still open, so the nudge can be specific ("you said you'd send Sam the photos") and quiet when there is nothing to say.

**Status.** Being built now by another session. The design doc will be at `docs/design/relationship-nudges-2026.md`; this entry will link to it once it exists. Until then the details are not settled, so this entry only describes the idea.

**Depends on.** The people and projects graph ([memory/people-and-projects-2026.md](../memory/people-and-projects-2026.md)), the Feed and notifications, and the daily-habit work.

## 5. Phone companion, with Live Activities and lock-screen approvals

**What it is.** A phone app that connects to your own Gateway over the same network or Tailscale. Push comes from your own Gateway straight to Apple with your own key. There is no relay and no hosted service. A running task shows step progress on the Lock Screen and in the Dynamic Island. Approvals show Approve and Deny on the lock screen for ordinary writes, and only **Review…** for money and destructive actions.

**Why it beats existing assistants.** Your data and your push both stay on your hardware. Nobody in the middle can read or even route your notifications, and Apple sees only ciphertext (except for Live Activity progress, which is generic by design).

**The honest cost.** Push on iOS needs a paid Apple Developer account, and the owner builds the app under their own team. App Store distribution to other people is out of scope for now. Without an account, the PWA still gives Web Push with fewer features.

**Design and phases.** All of it is in [design/mobile-companion-2026.md](../design/mobile-companion-2026.md):
- M0: PWA with Web Push.
- M1: iOS app over LAN and Tailscale.
- M2: direct-APNs push, lock-screen approvals and Live Activities.
- M3: phone as a node (location, photos, contacts, calendar).

**Open questions.** See §7 of that doc: whether Tailscale's on-demand VPN is fast enough for the background tap, whether the Secure Enclave key can prompt from a notification action, and the minimum iOS version.

**Depends on.** The WebSocket protocol and device scopes (built), the Gateway identity-key pin (not built; shared with §7), `packages/notifications` (built), and the approvals system (built).

## 6. Apple's on-device model for private jobs

**What it is.** A choice, on a Mac with Apple Intelligence (macOS 26 or later), to let Apple's own on-device language model do the small jobs that read your text: understanding a search question, writing search cards and summaries, reordering the top results, and later reading one source for the memory pass. The text goes from the Gateway to the Mac helper on the same Mac and never leaves it. There is no key, no download and no per-token cost, and the model's memory belongs to the system, not to Psyche.

**Why it beats existing assistants.** The cloud default for these jobs sends snippets of your mail and messages to a provider. This is the version of the same jobs where nothing leaves the Mac, with nothing to install and no RAM budget to approve, because Apple already ships and manages the model.

**What it is not.** It is not an agent model. It has a window of about 4,096 tokens (input and output together), no tools and no vision here, so it is never the primary model. It does one small prompt at a time. When it cannot answer (Apple Intelligence off, an unsupported Mac or region, a guardrail, a prompt that is too long) the job does nothing and the plain path stands (the rules for a question, no card, the normal ranking). It never quietly falls back to a cloud model.

**Status.** A1, A2 and A4 are built behind fakes; **not yet run against the real model**, because running a local model is something the owner is told about first. Details and the list of what needs a real run are in [design/search-roadmap-2026.md](../design/search-roadmap-2026.md) ("Apple on-device model"). Private Cloud Compute (Apple's server-side model) is deliberately not used: it sends the text off the Mac.

**Phases.**
- A1 (built): the Mac helper's `llm.apple.availability` and `llm.apple.generate`, the router provider `apple` (ref `apple/on-device`), the `models.appleStatus` method and the `search.model.engine` setting (`utility` or `apple`).
- A2 (built behind fakes, 2026-11-04): Settings → Search → Model for search has "Use Apple's on-device model for private search jobs", with the plain statement (text stays on this Mac, no download or key, about 4k tokens, never a fallback to the cloud) and the availability reason from `models.appleStatus` (Apple Intelligence off, unsupported Mac or region, older macOS, still getting ready). It is disabled while unavailable and shown as the Host's setting in a remote client window.
- A3: a real run on a Mac the owner approves, to measure it with the search eval (`--live` for Apple) and tune the prompts and the rerank size.
- A4 (built behind fakes, 2026-11-04, **Experimental**): memory extraction per source (`model.perSource`, EM11) with `{kind: "local", ref: "apple/on-device"}`. Batches are sized to the 4,096-token window (an item that cannot fit is skipped with a recorded reason, never cut); a refusal (unavailable, guardrail, too long) makes the batch do nothing and records why, with no retry and no cloud fallback; it needs no RAM confirmation. The choice appears next to the other per-source options only where Apple's model is available. It is not recommended until A3 shows the window is enough.

**Depends on.** The Mac helper, the model router, the search roadmap's R12/R13 (rerank and query model) and the everything-memory plan's model-per-source setting (EM11).

## 7. Use Psyche from another computer

**What it is.** The Psyche app on a second Mac, or on a Windows PC, connects to the Psyche that already runs on your main Mac, over Tailscale. One machine stays the brain: it holds the data, the vault, memory, connectors and automations. The other computer is a window onto it. You can save several Gateways and switch between "This Mac" and a remote one from the avatar menu.

**Why it beats existing assistants.** Cloud assistants put your data on someone else's server so that every device can reach it. Here your devices reach your own machine over your own tailnet. Nobody runs a relay, nothing is synced to a third party, and a lost laptop is one **Remove** away from having no access.

**What is built.**
- The signed connect, pairing codes, owner-chosen scopes and revocation (`packages/protocol/src/methods/{connect,devices}.ts`, `apps/gateway/src/auth.ts`).
- The desktop's `external` mode and the Tailscale Serve setup in [guides/server-mode.md](../guides/server-mode.md#the-desktop-app). Today a Mac can already connect to a remote Gateway by hand, with environment variables.
- Reconnecting and resyncing after a drop (N14), and chunked upload and download over the WebSocket.

**What is left.**
- Choosing and saving Gateways in the app, with a startup screen that explains an unreachable host.
- The Gateway identity-key pin, shared with the phone.
- Fixing how the Gateway picks a Mac helper, so a second Mac can never receive the agent's computer use or Apple apps.
- A clear "runs on the host", "runs here" or "not available" for each feature tied to one machine.
- A client-only Windows build.

**Rough phases.** All of it is in [design/remote-gateway-2026.md](../design/remote-gateway-2026.md):
- R0: node routing and the desktop gates (no visible change).
- R1: a Mac remote client over Tailscale Serve, with saved Gateways, the identity pin and the startup states.
- R2: pairing links, Touch ID or Windows Hello for approvals on the client, and notifications on the client.
- R3: the Windows client-only build.
- R4: features that run on the client: Ask about my screen, system-wide dictation and, optionally, the browser.

**Decisions (2026-11-03).** The owner answered all ten questions; see §8 of that doc. In short: admin is opt-in, presence only for risky approvals, the browser and computer use stay on the Host, one Gateway at a time, and the desktop client waits for LAN support as well as Tailscale.

**Depends on.** The WebSocket protocol and device scopes (built), Tailscale Serve on the host (owner setup), the Gateway identity key (not built, shared with the [phone companion](../design/mobile-companion-2026.md)), the settings redesign's Devices section, and, for Windows, the [cross-platform](../design/cross-platform-2026.md) packaging work.

## 8. Memory for everything: work due, progress and catching up

**What it is.** Memory that works like a second brain, not a contact book. It remembers the people you talk to and what you talked about. It also remembers your work: projects, courses, and the assignments and deliverables that are due. For each piece of work it knows where things stand, what changed, where you stopped and when it is due. If you turn it on, the morning brief catches you up ("Lecture Work 7: due Thu, in progress, you stopped at problem 4b"), and Home shows the same in a **Catching up** block. A **Memory** page replaces the People row in the sidebar, with People, Projects, Work due, Events and Everything as tabs, and the review queue moves there too.

**Why it beats existing assistants.** To-do apps know a due date but not your progress. Chat assistants forget between conversations. Psyche already reads your Reminders, calendar, files, sent mail and your chats with it, on your Mac. So it can tell you where you left off, with a source for every claim. It does this without anything leaving the Mac unless you picked a cloud model, and without letting a crafted email mark your work done or move a deadline.

**What is built.** The graph it extends:
- the people graph with `project` entities, `due_at`, loops and cited facts ([people-and-projects](../memory/people-and-projects-2026.md));
- everything memory, with the review queue, quarantine and the red-team suite ([everything-memory-2026.md](../design/everything-memory-2026.md));
- the daily brief's Coming up and Learned yesterday;
- the Reminders and Calendar connectors and the files watcher.

**What is left.** All of it is in [design/memory-everything-2026.md](../design/memory-everything-2026.md):
- the `assignment` kind, courses as a project type, and anchors that link folders, threads and Reminders lists to a work item;
- status and a per-item timeline from signals, with code deciding status and never third-party text;
- privacy tiers per surface: work in the brief and on Home by default, facts about people off unless enabled;
- catch-up ranking, due-soon reminders (opt-in) and "you stopped here";
- the Memory page.

**Rough phases.**
1. MW1: the Memory page and sidebar swap. MW0: the protocol. These run in parallel.
2. MW1b: review on the Memory page. MW2: the store.
3. MW3: deterministic signals. MW4: catch-up and the brief. MW6: the work pages.
4. MW5: Home binding. MW7: model signals and course/work-tool senders. MW8: settings.
5. MW9: the agent tool and Continue in chat.

**Open questions.** See §9 of that doc. Whether birthdays stay in the brief, which mail subjects count as work, opting in course senders such as Canvas, due-soon notifications, and which folders count as work.

**Depends on.** Everything memory (the graph, the extractor, review), the search index as the one ingest path, the daily habit, `home-redesign` (Home's Catching up block) and `cmdk-actions-first` (⌘K entries).
