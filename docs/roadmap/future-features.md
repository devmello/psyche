# Future features

Status: plan, 2026-11-02. Nothing in this file is promised for a date. It collects eight features the owner has asked for, in plain language, with what is already built, what is left, and what each one depends on.

This sits next to [08-roadmap.md](../08-roadmap.md), which holds the milestone plan up to v1.0 and the short "After 1.0" list. Items here are the ones that need more than a line. When one gets a design doc, link it here and keep this entry short.

Each entry has the same parts: what it is, why it beats existing assistants, rough phases, open questions and dependencies.

## 1. Answers that cite your life

**What it is.** Ask a question in Search or ⌘K ("when did Sam say the contract would be ready?", "what did I promise Priya?") and get a short answer built from your own mail, messages, files and memory. Every claim in the answer carries a citation chip. Click a chip and you see the source: the message, the file, the fact and when Psyche learned it.

**Why it beats existing assistants.** Cloud assistants either can't see your mail and messages, or they see them and answer without showing where a claim came from. Psyche already keeps the sources on your machine, so it can show every source and refuse to answer when it has none. An answer with no citation is not shown as an answer.

**What is built (as of 2026-11-04).**
- The Life search group (by name and by words) is merged: [#1078](https://github.com/devmello/psyche/pull/1078).
- Search by meaning and a grounded answer are merged: [#1087](https://github.com/devmello/psyche/pull/1087). The method is `memory.life.answer`. It answers from reviewed, non-sensitive facts about people, cites each claim to a fact, and returns no answer, with a reason, when the model is off, no fact matches or the reply cites nothing it was given. Sensitive facts never go to a model.
- The answer card in Search and ⌘K (phase 1): for a query that reads like a question it asks `memory.life.answer` and shows the answer above the results, a citation chip after each claim (one chip with a count when a claim rests on several facts), the fact and when Psyche learned it under the chip, a plain reason when there is no answer, and "Open as a chat". The chip opens the fact inline with "Open in Memory"; it does not yet scroll to or highlight the fact on the person's page.
- Open the source (phase 2): a fact's citation now carries its search document id (`docId` on `LifeFactHit`). The chip's fact has "Show source", which opens a read-only source panel (`search.document`: the indexed text, its source and date; for Messages the conversation day). Search results from the local sources (Mail, Messages, Notes, Calendar, Reminders, Contacts, files), which had no route and were not listed, now show in Search and ⌘K under "Your sources" and open the same panel in the preview. Where there is a safe way, the panel adds one button, and only on the desktop: "Open in Mail" for a mail message (its Message-ID, kept at indexing time from the connector's own `message://` link, validated strictly, opened as `message://` through an allowlisted opener in the desktop main process; the general link policy still refuses `message:` and `file:`), and "Show in Finder" for a file inside a currently granted folder (real path, symlinks followed, never opened or run). The renderer sends only the document id; the Gateway (`search.openSource`, desktop connection only) resolves the target from the index and main checks it again.
- Answers from raw passages, follow-ups and several citations (phase 3): `memory.life.answer` with `passages: true` (sent only when the owner clicks "Answer from my mail, messages and files" on the card; typing alone answers from reviewed facts, as before) also reads passages of Mail, Messages, Notes, Calendar and Files from the local index, found by the index's own ranking (by meaning too when an embedder is configured), and cites a fact (`[1]`) or a passage (`[P1]`). Passages are quoted to the model as untrusted data with ids; every claim must cite an id it was given; a claim that cites nothing is dropped, and with nothing left there is no answer, with a plain reason. At most 8 passages, 1,200 characters each and 8,000 in all go to the model. The rule for a claim: every claim carries an id it was offered; the reply is cut into claims at a full stop, `;`, `!`, `?` or a full-width stop, and any sentence without an offered id (or with only ids that were not offered) is dropped. The model is the one `memory.life.answer` already used (the Everything memory model); there is no new cloud call. A passage is sent only if all of these hold: its source is not kept from the agent (so Messages, Contacts and Memory are out until the owner lets the agent read them), the connection may open it with `search.document`, its source's processing allows a cloud model when the model is a cloud one (judged by the router on the model actually called, and an unknown model counts as cloud), Memory's own per-source opt-out has not turned the source off, and the text that is sent (after the clean-up that turns newlines and zero-width or bidi characters into spaces) holds no credential, id or account number and no sensitive class that is off. The same checks fold the text first (Unicode compatibility form, format characters removed, whitespace collapsed), so a number split across lines or a keyword with a zero-width character inside is still found. Facts follow the same cloud rule: a fact that rests on a source kept off the cloud is not offered to a cloud model. A passage chip shows the passage's source and title and opens the same source panel as a search result. A fact now lists every citation's passage (`docIds`, read from its citations at read time, not stored), each with its own "Show source". Under the answer there is a follow-up box: a follow-up sends the earlier question, answer and cited ids; the Gateway reads the cited ids again under the same rules (a client cannot smuggle in an id it may not open), and the earlier answer is context only, never a source. The earlier answer's text is sent only if every id it cited reads again now under the asking connection, the same sources and the same model; if any fails, only the earlier question goes. It is stripped of citation markers and checked for sensitive classes like a passage. Up to five follow-ups are kept under one answer. A paired phone or other remote client gets no Messages, Contacts or Memory passage and no fact that rests on one, so it never sees a claim it could not open. The rule for facts: a fact is shown to a connection only if every citation it rests on can be opened by that connection; if any one cannot, the whole fact is left out (not trimmed). It applies to the answer and to Life search (`memory.life.search`).
- Open as a chat carries the answer (phase 4): "Open as a chat" on the card now opens a side chat with the answer attached, not only the question. `memory.life.answer` returns an opaque `answerId`; the Gateway keeps, in memory only and for a few hours, a record for the asking device: the answer text, the ids it cites (facts and passages, in citation order), the question and whether the model that made it ran off this Mac. The chat names that id in `chat.send.context` (kind `life_answer`) and nothing else: the client never sends answer text, titles or ids of sources, and an unknown, stale or other device's id is `not_found`. When the owner sends the first message, the Gateway reads every cited id again under the sending connection's rules (a remote device gets no Messages, Contacts or Memory fact or passage; a fact is kept only if every source it rests on can be opened; passages go through the same agent-off, opt-out, cloud-blocked and sensitive checks as when the answer was made) and cuts the answer to the claims that still have a source, renumbering the markers. What is stored in the first message is a `life_answer` block: the answer, the question, the cited ids and the model kind, with no source text and no answer id. A claim is kept only if every citation it carries still passes: one that fails takes the whole claim with it, because its words may come from that source. Forgotten or unreadable sources do not leave their words behind: after a `memory.*` forget, retract, delete, decide or reject call, and when a transcript is read, the stored blocks are cut to what the desktop app may still read. The opening message shows it with the same chips as the card (`AnsweredClaims`), and a chip opens the same source viewer (`search.document`, which applies the connection's rules again). Every path that hands a transcript to a client reads the block again for that client: `chat.history`, `chat.export` and the `chat.message` event (through the event bus's per-subscriber hook, which knows whether the subscriber is the desktop app, another paired client or a Gateway part; a part reads as the least trusted). A paired phone or a remote window therefore gets the Messages chips and the claims that rest only on them stripped, and a block with no claim left is left out. The agent in the new chat reads the answer's words (markers removed) and a short list of what it cited, one line each: source kind and date (a fact: "memory fact", the attribute, and when Psyche learned it), quoted as untrusted data. No passage title, person name, passage body or fact value is inlined beyond the answer's own words (third-party text is named by kind only, as for a Memory item opened in chat), so nothing the owner did not send through the button reaches it. The agent's own memory settings apply on its pass: access none gives it no fact, accepted only reviewed facts, a source the owner keeps from the agent is dropped, and a sensitive class reaches it only when the agent may see sensitive memory. If the chat's model is a cloud model, the list and words are read again with the cloud rule on, whatever model made the answer: a claim whose only source is kept off the cloud is dropped from what the agent sees (the owner's own card still shows it if a local model made it), and a model the Gateway cannot place counts as cloud. A claim that no longer passes the sensitive switches is dropped at once, in the transcript and in the next turn. The turn starts tainted when the answer model was offered a passage or a third-party fact, whether or not a claim survives. The taint is the turn's, like the other context kinds; the preamble stays in the agent's history for later turns. Another chat reading this one with `thread_read` sees only a marker, and the answer text is not indexed for search. The answer opens a new, empty chat only, and one device keeps at most 16 answers, so it cannot push out another's. The per-subscriber read is memoized for each kind of reader within one publish, facts are looked up by id (a fact older than the newest 2,000 still resolves), and a part of the Gateway with no paired device behind it gets the block stripped.
- The index and the nightly memory pass behind it: [design/search-2026.md](../design/search-2026.md), [design/search-roadmap-2026.md](../design/search-roadmap-2026.md), [design/everything-memory-2026.md](../design/everything-memory-2026.md).

**What is left.**
- Phase 2 limits still stand. Mail indexed before phase 2 has no stored Message-ID until it is read again (Settings → Search sources → Rebuild), so it opens in the panel only. Messages, Notes, Calendar, Reminders and Contacts have no safe deep link and open in the panel only. A file is shown in Finder, not opened. The panel shows the indexed text, not the live message, so it cannot show an edit made since. A chip does not yet scroll to or highlight the fact on the person's page.
- The passage a model read is a window of at most 1,200 characters around the question's words; the panel shows the whole indexed text (to 20,000 characters), not the window, and the chip does not highlight the part the model used.
- Not covered: the agent's own replies in the opened chat, its compaction summaries and the chat digests other chats read are written by models from what the agent saw and are not scrubbed again; a chat whose model is later changed to a cloud model keeps the preamble it was given, and the thread state is not marked local-only. If that matters, start the chat on the model it will keep.
- The opened chat carries the answer that was newest when the button was pressed (the last answered follow-up, else the first). Follow-ups made in the chat go through the agent's own `search_everything` tool, which shows its own source chips under its reply; the agent does not call `memory.life.answer`. The record behind "Open as a chat" is lost when the Gateway restarts or after a few hours; the chat then needs the question asked again. The answer already in a chat survives, and is read again each time it is shown.
- A per-device budget for methods that call a model (so a paired device cannot spend the owner's tokens in a loop) is not built.
- Follow-ups are not saved: closing the panel or changing the query starts a new conversation.
- Passages are English-leaning in two places: the question test that decides when to ask on its own, and the sensitive-class word lists that decide what is held back.
- The iOS app still asks for facts only (it does not pass `passages`), so it shows no passage chips yet.

**Rough phases.**
1. The answer card in Search/⌘K for `memory.life.answer`, with chips that open the fact.
2. Chips that open the source passage in Mail, Messages or the file viewer. (Done: see "What is built".)
3. Questions that need raw passages as well as facts, with the same rule: no citation, no claim, plus follow-up questions. (Done: see "What is built".)
4. "Open as a chat" carries the answer and its chips into the chat, read again per connection and per model. (Done: see "What is built".)

**Decisions (2026-11-04).** These were the open questions.
- Raw passages are asked for, not automatic: typing a question answers from reviewed facts only, as before, and nothing from mail, messages or files goes to a model until the owner clicks "Answer from my mail, messages and files" on the card (follow-ups then keep reading passages). The owner can change this later, for example with a setting that answers from passages on its own.
- Many facts behind one claim: one chip per claim, never a row of chips. The chip says what it rests on (the one fact, the one passage, or a count: "3 facts", "2 sources"). Opening it lists passages first, then facts, newest first by when Psyche learned them. The model may cite up to the ids it was given for one claim; the list is not otherwise capped.
- Facts that disagree: both stay visible and the claim is not silently resolved. The model is given each fact's learned date and told to say they differ and give the newest first. The panel notes "These facts differ. Newest first." when two cited facts give one person's same attribute different values. Nothing is deleted or demoted; correcting a fact stays in Memory.
- A fact still waiting for review: never used to answer. It shows in Life search, marked, and does not count as a source, so a question only a pending fact could answer gets "Nothing Psyche may read answers that yet." Raw passages are different: they are quoted text, not a claim about the owner, so they can answer without review, and the chip says whose words they are ("Written by someone else").
- The answer panel and the agent in chat: the agent still answers recall questions with `search_everything` (the same index and rules, cited sentences, its own chips under the reply) and never calls `memory.life.answer`. "Open as a chat" (phase 4, above) hands over the answer and its citations, but only through a server-side record and read again for the connection and the chat's model; the agent sees the answer's words and a list of source kinds, titles and dates, never a passage body.
- Messages in answers: Messages passages reach the model only when the owner has allowed the agent to read Messages (Settings → Search sources), and then only on the desktop app; a paired phone or other remote client never gets a Messages, Contacts or Memory passage or a fact that rests on one.

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

**Status.** Phase 1 (browser only) is built: Record and Stop on the built-in browser, a review screen, a skill draft through the usual approval card, and "Run it once now". The design, the privacy rules and the answers to the open questions below are in [docs/design/teach-by-showing-2026.md](../design/teach-by-showing-2026.md).

**What is left.** The accessibility recorder for Mac apps (phase 2; the Mac helper has one, not yet joined to the review screen), asking which values were examples across recordings, and offering "run it every week" through Scheduled (phase 3, left alone on purpose: see §8 of the design).

**Rough phases.**
1. **Browser only.** Record clicks, typing and navigation in the built-in browser. Turn them into a draft skill that uses the browser tools. Show the steps; the owner edits and approves. Run it once with the owner watching.
2. **Mac apps.** Record accessibility events (J1/J2) in apps the owner has already granted. Same review screen.
3. **Generalize.** Ask which values were examples ("this recipient", "this date") and make them inputs. Offer "run it every week" through Scheduled.

**Open questions.** Answered for phase 1 in [the design](../design/teach-by-showing-2026.md#10-answers-to-the-roadmaps-open-questions); the text below is the original question.
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
