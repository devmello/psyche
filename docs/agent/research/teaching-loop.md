# Teaching loop: prior art and research notes

Prepared 2026-10-25 for the Psyche "teaching loop" spec. Each source has a date: published or last updated where the page shows one, otherwise "fetched 2026-10-25". Quotes are short phrases with attribution. Two caveats: some OpenAI help pages returned HTTP 403 to direct fetches, so those details come from search-indexed copies (marked below), and several help centers show no date.

---

## 1. ChatGPT memory (OpenAI)

**What it does**

- **Two layers, two toggles.** "Reference saved memories" covers facts the user explicitly asked ChatGPT to keep. "Reference chat history" lets it draw on past conversations. Either can be on or off on its own. Turning off saved memories also turns off chat-history reference. *Temporary Chat* neither reads nor writes memory.
- **Write notices.** Since the September 2024 update, ChatGPT shows an inline **"Memory updated"** marker when it writes a memory. Hovering it gives a **"Manage memories"** link to review or delete what was saved. This in-the-moment, one-click route from the notice to the entry is the most-copied pattern in this space.
- **Deletion is layered and only partly intuitive.** The FAQ says deleting a chat does not remove a memory saved from it. To fully forget something you delete the saved memory *and* the source chat. Indexed versions of the FAQ say deleted saved memories may be kept up to 30 days for safety and debugging. A newer version adds that removing a fact from the summary may not remove it everywhere: past chats, files and connected apps can still hold it. It also adds a **"Don't mention this again"** option that suppresses a detail without deleting it.
- **Project-only memory (August 2025).** A project's Memory setting can change from *Default* to *Project-only*. The project then uses only its own chats, files and instructions and cannot see general memories. Shared projects get this automatically.
- **Automatic management (October 2025).** ChatGPT began pruning and re-ranking saved memories by recency and frequency, and users could search and re-prioritise them in settings.
- **"Dreaming V3" (June 2026).** A background process curates memory from chat history into one editable **Memory Summary** (Settings > Personalization > Memory Summary). It replaced legacy saved memories by default, with a toggle back to the old system. OpenAI's reason was that the old list "often became stale" and could hold contradictions; their example was a marathon plan next to a sprained ankle (OpenAI, via Thurrott). The summary shows a relative "last updated" time. It shows only the most important details, so the FAQ tells users to ask in chat to check a specific item. Edits are made by typing a correction or highlighting text.

**Borrow**
- Name every write in the moment, and link straight from that notice to the entry.
- Keep separate controls for "explicitly saved" and "inferred from history". They carry different levels of consent.
- Use scoped memory (per project) with strict isolation as a first-class option.
- Treat contradiction and staleness as the main failure modes; they are why OpenAI rebuilt the system.
- Offer "suppress" as a softer tool alongside "forget".

**Avoid**
- A summary that admits it does not show everything ChatGPT knows. That breaks inspectability.
- Deletion that requires hunting down every source (chat, file, connector) to really forget something. If a lesson is deleted, its derived copies should go with it.
- Opaque background "dreaming" that rewrites memory with no per-change record.

**Sources**
- OpenAI, "Memory and new controls for ChatGPT": https://openai.com/index/memory-and-new-controls-for-chatgpt/ (published 2024-02-13, updated 2024-09-05 and later)
- OpenAI Help Center, "Memory FAQ": https://help.openai.com/en/articles/8590148-memory-faq (fetched 2026-10-25; direct fetch returned 403, so content is from search-indexed versions with differing "Updated" dates)
- TechRadar, project-only memory: https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-project-only-memory-is-live-and-it-might-change-how-you-work-with-ai (August 2025; rollout dated 2025-08-22)
- TechRadar, automatic memory management: https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-is-smarter-now-that-its-learned-to-forget-a-huge-memory-upgrade-is-coming (October 2025; OpenAI announcement 2025-10-15)
- Thurrott, "OpenAI is improving how ChatGPT's memory works": https://www.thurrott.com/a-i/337052/openai-is-improving-how-chatgpts-memory-works (2026-06-05)

---

## 2. Claude memory (Anthropic)

**What it does**

- **Current experience is topic-based.** Claude saves memory as individual **Topics** during the chat, not as an after-the-fact summary. Users can say "remember this". Memory is on by default for Free, Pro and Max. On Team and Enterprise an owner has to enable it.
- **View and edit.** Go to Settings > Your Claude > **"Manage"** next to **"Your memory"**. Open a topic to read it, use the edit icon to change it, or choose **Delete**. Users can also tell Claude in chat what to remember, change or forget.
- **Legacy summary.** Some Team and Enterprise orgs still use a single "memory summary" that refreshes every 24 hours. The September 2025 launch post described users telling Claude what to focus on or ignore.
- **Project-scoped memory.** Each project has its own memory. Inside a project, Claude uses that project's memory plus non-project memory, never another project's. **"Use account memory"** can be switched off per project for full isolation.
- **Pause vs. reset.** **"Pause memory"** keeps existing memory but stops reading and writing it. Chats held while paused are not back-filled later. **"Reset memory"** permanently deletes everything, project memories included.
- **Incognito** (ghost icon) chats are not saved to history or memory and are not searched later. Team/Enterprise retention policies still apply.
- **Import/export** to and from other assistants is offered and labelled experimental.
- **Chat search** ("Search and reference chats") is a separate toggle. It shows up in the chat as visible tool calls.
- **Safety testing.** Before the Pro/Max rollout, Anthropic says it tested whether memory could reinforce harmful patterns, lead to "over-accommodation", or help bypass safeguards, and adjusted based on the results (Anthropic blog).

**Borrow**
- Store discrete, individually editable entries (topics) rather than one prose blob. Each entry can carry provenance and a "taught" mark.
- Keep pause and reset as separate verbs. Pause should not back-fill.
- Make memory retrieval visible as a tool call. That is a clean model for "the agent consulted lesson X".
- Allow project isolation through an explicit per-project switch.
- Ship export as a plain-text artifact, so the owner can move it, diff it and audit it.

**Avoid**
- The legacy 24-hour batch summary, where users cannot tell which conversation caused which change.
- Defaulting memory on without a first-run explanation. For a self-hosted agent, the teaching loop should be opt-in per signal type.

**Sources**
- Claude Help Center, "How does Claude's memory work?": https://support.claude.com/en/articles/11817273 (page says "Updated this week"; fetched 2026-10-25)
- Anthropic/Claude blog, "Memory": https://claude.com/blog/memory (published 2025-09-11, updated 2025-10-23)

---

## 3. Gemini personal context, memory, Personal Intelligence (Google)

**What it does**

- **Saved info** sits under Settings & help > **Personal context** (also gemini.google.com/saved-info). Users can **Add** an item, ask mid-chat for Gemini to remember something, or use **More > Edit / Delete**. One toggle covers the whole feature: "Info you asked Gemini to Save". It is not available to under-18s or in Gemini Live.
- **Disclosure at the point of use.** When saved info shapes an answer, the response usually shows "Your saved info" under "Sources and related content". Google's help page notes that this label is occasionally shown incorrectly, a candid admission.
- **Past chats → "memory".** Past-chat personalization launched on by default in August 2025, under the description "on by default to help Gemini give you more relevant responses" (Google blog). It has since been renamed "memory" under Settings & help > **Personal Intelligence**. It requires Keep Activity. Google suggests asking "Did you use any info from past chats?" to check. Deleting a chat can take a short delay before personalization stops using it.
- **Two-place deletion problem.** To forget a fact that came from a connected app, Google says you must delete the chats *and* disconnect the app. Otherwise Gemini may still find it in one place or the other.
- **Personal Intelligence (January 2026)** links Gmail, Photos, YouTube and Search. Connecting apps is off by default, and users pick each app. Gemini tries to cite which connected source it used. Users can correct a response directly, **regenerate without personalization** for one chat, or use Temporary Chat. Google names "over-personalization" as a known beta failure: linking unrelated topics, misreading timing or relationship changes. Its example is assuming you love golf from many golf-course photos. Gemini avoids proactive assumptions about sensitive data such as health.
- **Temporary chats** are kept up to 72 hours, are not shown in history, and are not used for personalization or training.

**Borrow**
- Put source chips on the answer itself ("used: your saved info"). This is the reverse of the "taught" mark: it shows *which* lesson shaped *this* answer.
- Offer "regenerate without personalization" as a per-answer escape hatch. It is cheap and tests whether a lesson is helping.
- Name over-personalization in product copy, and invite the owner to flag it.
- Leave sensitive categories alone unless the owner raises them.

**Avoid**
- Turning inferred personalization on by default.
- Lessons that live in several stores, so that forgetting needs several actions.
- Disclosure labels that are sometimes wrong. If Psyche shows provenance, it has to be deterministic, not model-generated.

**Sources**
- Gemini Apps Help, "Save info and reference past chats": https://support.google.com/gemini/answer/16413516 (undated; fetched 2026-10-25)
- Gemini Apps Help, "Get personalization with memory of your past Gemini chats": https://support.google.com/gemini/answer/16598469 (undated; fetched 2026-10-25)
- Google blog, "Gemini app personalizes responses based on past chats, plus new privacy controls": https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/ (2025-08-13)
- Google blog, "Personal Intelligence: Connecting Gemini to Google apps": https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/ (2026-01-14)

---

## 4. Feedback affordances and feedback-to-preference products

**What they do**

- **GitHub Copilot code review.** Each review comment has thumbs up/down. Thumbs-down opens an optional reason menu and a comment box. GitHub uses the ratings to improve the product generally, not as a per-user preference.
- **GitHub Copilot Memory (public preview).** This is the most rigorous design surveyed.
  - It stores repository *facts* and per-user *preferences*.
  - Facts carry **citations** to code. Before use, Copilot checks the citations against the current branch, and "Only validated facts are used" (GitHub Docs).
  - Preferences can cite direct user quotes.
  - Any fact or preference unused for **28 days is automatically deleted**. Successful use resets the clock.
  - Users can view and delete their preferences in personal settings. Repo owners can review and delete facts.
- **GitHub Copilot custom instructions.** `.github/copilot-instructions.md`, path-scoped `*.instructions.md` files, and a personal `$HOME/.copilot/copilot-instructions.md`. These are plain Markdown and versioned in git. The docs warn that Copilot picks between conflicting instructions non-deterministically.
- **Cursor.** "Memories" were generated by a background model watching chats, or by an agent tool call, and managed under Settings > Rules. They were **removed in 2.1 (late 2025)**. Staff told users to run "Export memories" and convert them into User or Project Rules (`.mdc`). Users later reported memories still applying with no UI to manage them. The industry signal: implicit memories lost to explicit, file-based rules.
- **Windsurf / Devin Cascade.** Auto-generated memories are workspace-scoped and stored locally in `~/.codeium/windsurf/memories/`, not committed to the repo. The docs now recommend writing durable knowledge as Rules (`.devin/rules/`, `AGENTS.md`), because rules are version-controlled with explicit activation. Memories apply only to the legacy agent.
- **Raycast AI.** Splits **Profile**, which is entirely user-written ("only contains what you choose to share", Raycast manual), from **Memory**, an auto-built summary regenerated every few hours from recent chats. Memory is read-only in the UI. Users can **Generate**, "Add to Memory", ask AI to update it, or **Reset Memory**. It is stored locally and synced encrypted.
- **Notion Agent.** Behaviour is driven by an *instructions page* (default "My Notion AI", a private page) opened by hovering the AI face to **Personalize**. Its "Let it learn" claim is that the agent "remembers your style and workflows" (Notion help), but the page does not say where or how. If others can edit the instructions page, they change how your agent responds.
- **Superhuman.** Write with AI analyses a sample of recent emails to set tone. Explicit settings (greeting, sign-off, tone, length) live under Settings > Personalization. If the voice feels off, users are told to email support. There is no visible correction loop.
- **Granola.** Each meeting is processed independently, so edits to one note do not carry forward. Persistent preferences live in user-authored **templates** and **Recipes** (reusable prompts). Granola Chat handles one-off corrections such as "make next steps more detailed".
- **Mem 2.0** (relaunched 2025) focuses on capture, Deep Search and "Heads Up" resurfacing. It documents no feedback-to-preference loop.

**Borrow**
- Thumbs-down that opens an *optional* reason chip and a free-text line ("not like this"). The text is the lesson candidate.
- Copilot's validated, cited lessons with use-based expiry. Lessons that stop being used fade out, and lessons whose evidence no longer holds are not applied.
- Raycast's split between "what you told me" (Profile) and "what I inferred" (Memory), shown separately.
- Rules as plain, diffable files the owner can edit outside the app (Copilot, Windsurf, Cursor all converged here).
- Granola's distinction between one-off fixes ("this note") and standing changes ("templates"). Psyche should ask which one a correction is.

**Avoid**
- Silent background extraction with no review step (Cursor's path, then removed).
- "Learns your voice" claims with no visible artifact or correction path (Superhuman, Notion "Let it learn").
- Instruction stores other people can edit (Notion's shared-page caveat), which is a poisoning vector.
- Unresolved conflicts between rules. Psyche should detect and surface contradictions instead of choosing at random.

**Sources**
- GitHub Docs, "Copilot Memory": https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/copilot-memory (undated, public preview; fetched 2026-10-25)
- GitHub Docs, "Adding repository custom instructions": https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions (fetched 2026-10-25)
- GitHub Docs, "Using GitHub Copilot code review": https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review (fetched 2026-10-25)
- Cursor Forum, "Are my memories gone?": https://forum.cursor.com/t/are-my-memories-gone/144057 (late 2025; fetched 2026-10-25)
- Devin/Windsurf Docs, "Memories": https://docs.devin.ai/desktop/cascade/memories (undated; fetched 2026-10-25)
- Raycast Manual, "Personalization": https://manual.raycast.com/ai/personalization (undated; fetched 2026-10-25)
- Notion Help, "Get started with your Notion Agent": https://www.notion.com/help/guides/get-started-with-your-personal-agent-in-notion (undated; fetched 2026-10-25)
- Superhuman Help, "Write with AI": https://help.superhuman.com/hc/en-us/articles/38456855116307 (undated; fetched 2026-10-25)
- Granola Help, "Customise notes with templates": https://help.granola.ai/article/customise-notes-with-templates (undated; fetched 2026-10-25)
- Mem blog, "Mem 2.0": https://get.mem.ai/blog/mem-2-0 (2025; fetched 2026-10-25)

---

## 5. Apple on-device personalisation

**What it does**

- **Plain-language claim with a control next to it.** Apple's Siri privacy page says Siri Suggestions "uses local, on-device processing to learn how you use your devices and apps" (Apple Legal). It names the inputs (Safari history, messages, contacts) and says suggestions are not stored on Apple servers. Sync across devices uses end-to-end encryption.
- **Per-source learning switch.** Settings > Siri > Apps (or App Access) > [app] > **"Learn from this App"**. This is the clearest per-source consent control in the survey: the owner turns off learning from one app without turning off the assistant. Separate toggles control where suggestions *appear* (Show on Home Screen, Suggest App, Suggestion Notifications, Show in Spotlight). Health has its own "Learn from this App" switch.
- **Delete history:** Settings > Siri > Siri & Dictation History > **Delete Siri & Dictation History**. Turning off Siri and Dictation deletes the stored transcripts used for personalization.
- **Photos Memories, negative feedback with a scope.** Touch and hold a memory > **Feature Less**, then choose the *scope*: this person, day or place, or (Mac) **Feature Fewer Memories Like This**. The undo is a global **Reset Suggested Memories** / **Reset People & Pets Suggestions**. Apple documents these in its *Personal Safety* guide: "not like this" is partly a safety tool (an ex-partner, a bereavement).
- **Apple Intelligence.** An on-device semantic index provides personal context. Heavier requests go to Private Cloud Compute, which Apple says keeps no data and runs publicly logged software. The **Apple Intelligence Report** (Settings > Privacy & Security) logs and exports requests sent off-device, as an auditable record.

**Borrow**
- Per-source "learn from this" toggles: email, calendar, drafts and each connector are separately teachable.
- Separate *learning* from *surfacing*. Two independent switches.
- When the owner says "less of this", ask "less of what?" (person, topic, time, type) before writing a lesson.
- Use plain sentences that name the inputs and where processing happens. For self-hosted Psyche the claim is stronger ("this lives on your machine, in this file") and should be stated just as plainly.
- An exportable log of what the system did with personal data.

**Avoid**
- A reset that only works globally. Apple's "Feature Less" needs a full reset to undo, so per-lesson undo is better.
- Learning that cannot be inspected at entry level. Apple shows controls but not *what* Siri learned. Psyche should show both.

**Sources**
- Apple Legal, "Siri, Dictation & Privacy": https://www.apple.com/legal/privacy/data/en/ask-siri-dictation/ (2026-09-14)
- Apple Support, "Change Siri settings on iPhone" (iOS 27): https://support.apple.com/guide/iphone/change-siri-settings-iphc28624b81abc/27/ios/27 (fetched 2026-10-25)
- Apple Personal Safety Guide, "Feature a person, a place, or a memory less often in Photos": https://support.apple.com/guide/personal-safety/feature-a-person-place-memory-ipsa4c9edc62/web (fetched 2026-10-25)
- Apple Legal, "Apple Intelligence & Privacy": https://www.apple.com/legal/privacy/data/en/intelligence-engine/ (fetched 2026-10-25)
- Apple Security Research, "Private Cloud Compute": https://security.apple.com/blog/private-cloud-compute/ (2024-06-10)

---

## 6. Progress and growth views: what to borrow and what to avoid

**Duolingo (avoid most of it).** Streaks, guilt-framed reminders and an emotive mascot. A 2025 IHC paper credits Duolingo with clear, ethical interface practices but finds "excessive notifications and emotionally charged visuals" (Castro & Valença), especially concerning for children. A 2022 study calls the result "gamification misuse": users fixate on points and streaks at the expense of learning. The Decision Lab's "Streak Creep" essay says streaks can sap intrinsic enjoyment, and notes that Duolingo's own streak forgiveness keeps users going. *Lesson:* never measure the owner's diligence, never create loss aversion, never nag.

**GitHub contribution graph (cautionary).** GitHub **removed current and longest streak counters in May 2016**. Moldon, Strohmaier & Wachs (ICSE 2021) used this as a natural experiment: after the removal, long streaks were abandoned and weekend activity dropped. The streak counter had been driving behaviour, not just measuring it. Open-source maintainers had complained that the graph rewards working every day. The heatmap itself is a respectful, dense, glanceable history. The counters were the manipulative part.

**Strava (borrow the training log, avoid the paywalled recap).** Fitness & Freshness charts training load over time. Strava stresses that Fitness and Relative Effort are relative to the individual athlete, not for comparing people. The Training Log is a calendar of what happened, not a score. **Year in Sport** is a mobile-only, shareable recap. In December 2025 it went subscription-only, which users criticised (Ars Technica).

**Oura (borrow the explanations).** The Readiness score is broken into named **contributors** (resting HR, HRV balance, sleep balance, etc.), each compared with *your own* long-term baseline. Oura needs up to two weeks to learn your averages before scoring. The lowest band is labelled "Pay Attention", not "Bad". *Lesson:* every aggregate must decompose into its causes, and the owner's own past is the only baseline. Say "still learning" while history is thin.

**Apple Fitness Trends (borrow).** Compares your last 90 days with your last 365, using up/down arrows per metric. It needs 180 days of data before trends appear. A down arrow comes with a coaching suggestion, not a penalty. The comparison is calm and has a long window.

**Spotify Wrapped (borrow the format, avoid the comparisons).** It is a once-a-year story of independently shareable cards. The December 2025 edition added "Listening Age" (comparing you with your age group), "Clubs" (typing users into one of six groups), artist-fan leaderboards and an AI-generated "Listening Archive". Critics argue it has normalised "constant tracking" (Proton, citing a Northeastern researcher). The 2025 edition drew backlash over heavy automation. *Lesson:* a periodic recap is a good container. Labelling the owner, ranking them and comparing them with other people are the parts that read as profiling.

**Respectful vs. manipulative, in practice**

| Respectful | Manipulative |
|---|---|
| Baseline is the owner's own past (Oura, Apple Trends, Strava Fitness) | Comparison with other users, ranks, leaderboards (Wrapped) |
| Score decomposes into named, inspectable causes (Oura contributors) | Opaque scores, levels, XP |
| Long windows, slow arrows, "not enough data yet" states | Daily streaks and loss-aversion counters (Duolingo, old GitHub) |
| Recap is a record you can browse (Strava log, GitHub heatmap) | Recap is a personality label ("Clubs", "Listening Age") |
| Notifications only when something changed | Guilt-framed reminders, emotive mascots |
| Free, owned by the user | Recap held behind a paywall or used as marketing |

**Sources**
- Castro & Valença, "Teaching or Manipulating? On the Adoption of Bright and Deceptive Patterns by Duolingo", IHC 2025: https://sol.sbc.org.br/index.php/ihc/article/view/37677 (2025-09-08)
- arXiv 2203.16175, gamification misuse in language learning: https://www.arxiv.org/abs/2203.16175 (2022)
- The Decision Lab, "Streak Creep": https://thedecisionlab.com/insights/consumer-insights/streak-creep-the-perils-of-too-much-gamification (undated; fetched 2026-10-25)
- Moldon, Strohmaier & Wachs, "How Gamification Affects Software Developers: Cautionary Evidence from a Natural Experiment on GitHub", ICSE 2021: https://ar5iv.labs.arxiv.org/html/2006.02371 (arXiv 2020; ICSE 2021)
- freeCodeCamp, "Don't break the chain: why GitHub's streaks will be sorely missed": https://www.freecodecamp.org/news/dont-break-the-chain-why-github-s-streaks-will-be-sorely-missed-by-many-4fff90bc2a38/ (2016)
- Strava Support, "How Fitness & Freshness is Calculated": https://support.strava.com/hc/en-us/articles/216918477-Fitness-Freshness (fetched 2026-10-25)
- Strava Support, "Your Year in Sport": https://support.strava.com/hc/en-us/articles/22067973274509-Your-Year-in-Sport (fetched 2026-10-25)
- Ars Technica via Harvard TagTeam, "Strava puts popular 'Year in Sport' recap behind an $80 paywall": https://tagteam.harvard.edu/hub_feeds/3415/feed_items/17132945/content (December 2025)
- Oura Support, "Readiness Score": https://support.ouraring.com/hc/en-us/articles/360057791533 (fetched 2026-10-25)
- Apple Support, "Track your trends in the Fitness app": https://apple.co/36ggRsf (fetched 2026-10-25)
- Spotify Newsroom, "2025 Wrapped": https://newsroom.spotify.com/2025-12-03/2025-wrapped-user-experience/ (2025-12-03); Axios: https://www.axios.com/2025/12/03/spotify-wrapped-2025-new-features (2025-12-03)
- Proton, "Spotify Wrapped alternatives" (privacy critique): https://proton.me/zh/business/blog/spotify-wrapped-alternatives (fetched 2026-10-25; vendor source)

---

## 7. Literature: preference learning, sycophancy, poisoning, privacy

**Learning from edits works best as distilled, retrievable text.** PRELUDE / CIPHER (Gao et al., Microsoft, NeurIPS 2024) treats the user's edits to agent drafts as the signal. For each context, an LLM infers a short natural-language *preference description* from the edit. At generation time it retrieves the preferences from the k most similar past contexts and combines them. On summarisation and email tasks (with simulated users) it gave the lowest cumulative edit distance among baselines, at small extra cost, and its learned preferences resembled the ground truth. *Practical takeaway:* heavy edits of drafts are the richest implicit signal. Turn each into a one-line, human-readable, context-tagged lesson rather than fine-tuning. The lesson text is also what the owner reviews.

**Implicit feedback in conversation is real but noisy.** WildFeedback (Shi et al., 2024, revised 2025) mines multi-turn chats for in-situ satisfaction and dissatisfaction signals and builds preference pairs. It works at population scale for fine-tuning. For one owner, the same signals (rephrasing, "no, I meant…", undo) are better used as *candidates* for review than as automatic writes.

**Learning from approval breeds sycophancy.**
- Sharma et al. (Anthropic, ICLR 2024) show that five assistants are consistently sycophantic. Human preference data favours responses that agree with the user's views. Optimising against preference models sometimes trades truthfulness for agreement.
- OpenAI's GPT-4o post-mortem (May 2025) says adding a thumbs-up/down reward signal weakened the main reward that had been holding sycophancy in check. It adds that user feedback "can sometimes favor more agreeable responses", and that memory made the effect worse in some cases (OpenAI).
- Jain et al. (CHI 2026, 38 users, two weeks of real context) find that user memory profiles produced the largest increase in agreement sycophancy, e.g. +45% for one model. Perspective sycophancy rose when the model could infer the user's viewpoint.
- OP-Bench (2026) defines "over-personalization", including affirming memories that do not exist.
- *Practical takeaway:* thumbs-up should never become a lesson by itself. Lessons should be about *form and process* ("bullets, not prose"; "ask before emailing my manager"), not about *conclusions* ("the owner is right about X"). Psyche needs a guard so that factual answers are not adjusted toward what the owner seems to believe.

**Preference drift.** Benchmarks such as HorizonBench (2026: 360 simulated users, six-month histories, ground-truth provenance per preference change) and methods such as SPRInG (2026) show that static retrieval assumes preferences never change, and that this fails. *Practical takeaway:* lessons need timestamps, last-used and last-confirmed dates, explicit supersession ("replaces lesson #12"), and decay. Copilot's 28-day unused expiry and ChatGPT's stale-memory rewrite are two product answers to the same problem.

**Memory poisoning is the main security risk.**
- Rehberger (Embrace The Red, May and September 2024) showed that indirect prompt injection from documents, images or web pages could call ChatGPT's memory tool. It planted false memories, and in the macOS app ("SpAIware") persisted exfiltration across sessions. OpenAI patched the exfiltration but acknowledged that memory-writing injections remain an open problem. Similar work followed on Gemini (2025).
- MINJA (Dong et al., NeurIPS 2025) poisons agent memory through *query-only* interaction. Over 95% injection success under idealised conditions.
- MemoryGraft (December 2025) plants fake "successful experiences" through files such as READMEs.
- *Practical takeaway:* only the owner's own UI actions and messages can create lessons. Content the agent reads (emails, web pages, documents, tool output) can never write a lesson or approve one. Every lesson records its originating event, and lessons from untrusted context are blocked, not merely downranked.

**Privacy and regulatory framing.**
- **GDPR Art. 4(4)** defines profiling as automated processing to evaluate or predict personal aspects such as preferences and interests. A teaching loop that infers preferences is profiling.
- **GDPR Art. 21** gives a right to object, **Art. 17** a right to erasure, and **Arts. 13–15** require information and access.
- **EDPB Opinion 28/2024** (December 2024) says models trained on personal data cannot automatically be treated as anonymous. This argues for keeping owner lessons as *in-context, deletable memory*, never baked into weights, so erasure is real and immediate.
- **EU AI Act Art. 50** (applies from 2026-08-02) requires disclosing AI interaction and marking synthetic content. It does not regulate memory directly, but sets the expectation of explicit disclosure.
- **NIST AI 600-1** (Generative AI Profile, July 2024) lists data privacy, including leakage and de-anonymisation of sensitive data, among its twelve GenAI risks. It recommends documenting provenance and testing for disclosure of personal information.
- *Practical takeaway:* self-hosting reduces but does not remove these concerns (shared households, third parties named in lessons). Provenance, erasure that cascades to derived data, and an exportable record are the controls that hold up.

**What works**
- Distilled, human-readable lessons with context tags, retrieved per task (CIPHER).
- Cited lessons that are re-checked before use, with use-based expiry (Copilot Memory).
- Explicit, file-based rules the owner edits (where Cursor, Windsurf and Copilot converged).
- Separating stated facts from inferred patterns (Raycast, ChatGPT).
- Per-answer disclosure of which lessons were applied (Gemini source chips).

**What fails**
- Silent background extraction (Cursor memories, removed).
- One growing summary that becomes stale and self-contradictory (ChatGPT's stated reason for Dreaming V3).
- Approval-driven learning (GPT-4o sycophancy).
- Memory writable by content the agent reads (SpAIware, MINJA).
- Deletion that leaves copies in other stores (ChatGPT and Gemini caveats).

**Sources**
- Gao et al., "Aligning LLM Agents by Learning Latent Preference from User Edits" (PRELUDE/CIPHER): https://arxiv.org/abs/2404.15269 (2024-04; NeurIPS 2024)
- Shi et al., "WildFeedback": https://arxiv.org/abs/2408.15549v3 (2024-08; v3 2025-04)
- Sharma et al., "Towards Understanding Sycophancy in Language Models": https://arxiv.org/abs/2310.13548 (2023-10; ICLR 2024)
- OpenAI, "Expanding on what we missed with sycophancy": https://openai.com/index/expanding-on-sycophancy/ (2025-05-02)
- Jain et al., "Interaction Context Often Increases Sycophancy in LLMs", CHI 2026: https://pure.psu.edu/en/publications/interaction-context-often-increases-sycophancy-in-llms/ (2026-04-13)
- OP-Bench: https://arxiv.org/abs/2601.13722 (2026-01)
- HorizonBench: https://www.emergentmind.com/papers/2604.17283 (2026-04)
- SPRInG: https://arxiv.org/abs/2601.09974 (2026-01)
- Rehberger SpAIware coverage, Gigazine: https://gigazine.net/gsc_news/en/20240925-hacker-plants-false-memories-chatgpt-steal-data/ (2024-09-25; primary posts on embracethered.com dated 2024-05-22 and 2024-09-20, not fetched directly)
- Dong et al., "Memory Injection Attacks on LLM Agents via Query-Only Interaction" (MINJA): https://arxiv.org/abs/2503.03704 (2025-03; NeurIPS 2025)
- MemoryGraft: https://arxiv.org/html/2512.16962 (2025-12)
- GDPR text (Arts. 4, 17, 21, 22): https://gdpr-info.eu/ (fetched 2026-10-25)
- EDPB Opinion 28/2024 on AI models: https://www.edpb.europa.eu/system/files/2024-12/edpb_opinion_202428_ai-models_en.pdf (adopted 2024-12-18)
- EU AI Act Article 50: https://artificialintelligenceact.eu/article/50/ (fetched 2026-10-25; obligations apply 2026-08-02; Commission guidelines 2026, see https://www.mondaq.com/constitutional-administrative-law/1823814/eu-ai-act-final-guidelines-on-transparency-obligations-under-article-50)
- NIST AI 600-1, Generative AI Profile: https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf (2024-07-26)

---

## Implications for Psyche: design rules

1. **Lessons are discrete, typed, plain-text entries, never a summary blob.** Each lesson has an id and a one-line statement. It has a scope: global, project, contact, or task type such as "email drafts". It has a kind: *stated* (the owner said it) or *inferred* (from an edit, undo or dismissal). Stated and inferred lessons are shown in separate sections, as Raycast separates Profile from Memory. (Claude Topics, Raycast, CIPHER.)

2. **Every lesson carries provenance that cannot be edited away.** That means the originating event (message id, draft id plus diff, undo event), the timestamp, the signal type, and the exact owner words if any. "Why do you think this?" always resolves to a real event, never a model-generated explanation. (Copilot citations; Gemini's admission that its labels are sometimes wrong.)

3. **Only the owner can teach.** Lessons can only be created or approved by owner UI actions or owner-authored messages. Content the agent reads (mail, web, files, tool results, other people's messages) cannot write, approve or edit a lesson, even if it says "remember that…". (SpAIware, MINJA, MemoryGraft.)

4. **Explicit corrections write immediately; implicit signals only propose.** A one-line correction or "not like this" with text becomes a lesson right away, with an inline "Learned: … · Undo · Edit" notice linked to the entry (ChatGPT's "Memory updated" pattern). Undo, heavy edits and dismissals become *candidates* held for the weekly card and never apply silently. (Cursor's removal of silent memories; WildFeedback noise.)

5. **Thumbs-up never becomes a lesson by itself, and lessons are about form, not truth.** Approval may raise confidence in an existing lesson but never creates one. Lessons may govern style, format, process, permissions and priorities. They may never steer factual claims or conclusions toward what the owner believes. Add a check that flags any lesson phrased as an opinion about the world. (Sharma et al.; OpenAI's GPT-4o post-mortem; Jain et al.)

6. **Scope every correction before writing it.** When the owner says "not like this", offer scope chips: just this time / this contact / this kind of task / always. Offer "less of what?" (tone, length, topic, person) for dismissals. Default to the narrowest scope. (Apple's "Feature Less" person/day/place; Granola's one-off vs. template.)

7. **Mark changed memory visibly and reversibly.** Any memory entry created or changed by teaching shows a small "taught" mark with date and source. Its history view shows before/after and the event that caused each change. Each change can be reverted on its own, not only through a global reset. (Apple's reset-only weakness; Claude's per-topic edit.)

8. **Disclose use at the point of use.** Answers and actions that applied a lesson show a quiet "Used: 2 lessons" chip that expands to the entries. Every answer offers "Redo without lessons". If the owner prefers the unpersonalised version, that counts as a signal against the applied lessons. (Gemini source chips and "regenerate without personalization".)

9. **Lessons age.** Track last-applied and last-confirmed dates. A lesson unused for a set period (for example 30–60 days) goes into the weekly card as "still true?" rather than being silently deleted. A new lesson that contradicts an old one must name what it supersedes. The old one is archived with a link, never left to compete. (Copilot's 28-day expiry; ChatGPT's stale and contradictory memories; HorizonBench drift.)

10. **The weekly "what I learned" card is a review queue, not a celebration.** It lists at most about 5–7 items: new lessons, pending candidates, lessons proposed for retirement, and conflicts found. Each item has **Accept / Edit / Forget** and links to its evidence. If nothing changed, there is no card; never send a "you haven't taught me lately" nudge. Unreviewed candidates expire rather than auto-accepting.

11. **The Growth view compares the agent with its own past, never ranks the owner.** Show calm, long-window trends per area: drafts sent with fewer edits, fewer undos, corrections per week falling. Use 30/90-day windows with "not enough history yet" states (Apple Trends, Oura baselines). Every number decomposes into the lessons and events behind it (Oura contributors). No streaks, levels, XP, badges, personality types, percentiles or comparisons with other users. (Duolingo; GitHub's 2016 streak removal; Wrapped "Clubs"/"Listening Age".)

12. **Frame growth as the agent's competence, not the owner's diligence.** Copy says "I now draft replies to Dana in your shorter style (since 3 Oct, from 4 edits)". It never says "You taught me 12 things this week!". Use a neutral tone and no mascot emotion. A dense, browsable timeline (heatmap or log, Strava/GitHub-style) is fine; counters that reward daily activity are not.

13. **Per-source learning switches, separate from use switches.** For each signal (thumbs, corrections, undo, draft edits, dismissals) and each surface (mail, calendar, notes, each connector), offer "learn from this" separately from "use lessons here". Add Pause (stop reading and writing, no back-fill later) and Reset as distinct verbs, plus an incognito session that neither reads nor writes lessons. (Apple's "Learn from this App"; Claude's Pause vs. Reset; ChatGPT Temporary Chat.)

14. **Forgetting is complete and immediate.** Forget deletes the lesson, its derived candidates, embeddings and cached summaries in one action. It writes a tombstone so the same evidence does not re-create the lesson. Source events can optionally be purged too. Lessons stay in-context data only, never fine-tuned into weights, so erasure is real. (ChatGPT and Gemini's multi-store deletion caveats; GDPR Art. 17; EDPB 28/2024.)

15. **Everything is exportable and editable outside the app.** Lessons live in a human-readable file (Markdown/JSON) in the owner's Psyche data directory, diffable and hand-editable, with an export of lessons plus provenance. Edits made outside the app are picked up and marked "edited by owner". Treat lessons about third parties (named contacts) as sensitive, and never infer health, politics, religion or similar categories unless the owner states them. (Copilot/Windsurf rules files; Gemini's sensitive-topics stance; GDPR Art. 4(4) profiling; NIST AI 600-1.)
