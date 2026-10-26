# Mail products research (2026)

**Purpose.** Inform Psyche's mail workflows (inbox triage into a daily digest, "waiting on" tracking, drafting in the owner's voice, scheduling over email). The constraint throughout: nothing is sent without the owner's explicit approval, and the agent runs locally on a Mac.

**Date.** All sources accessed 2026-10-25.

**Method.** Web search plus direct reads of vendor help pages, vendor blogs, press coverage, security write-ups, and Hacker News threads (through the Algolia API). Reddit could not be fetched directly (our crawler is blocked there), so Reddit sentiment appears only where a press article quotes it. A few Superhuman help-center pages returned HTTP 403. For those, details come from search-index excerpts and are marked as such. Anything we could not confirm is marked **unverified**. Vendor statistics are reported as vendor claims. Sources written by competitors (for example Carly's reviews of Superhuman and Fyxer) are flagged.

---

## Superhuman

**Triage.** Split Inbox divides mail into tabs. Since early 2025 the default Important/Other split is driven by AI: marketing, cold pitches, and social updates move to Other [1]. Auto Labels classify every incoming message. Superhuman names categories such as needs a response, waiting on, meeting requests, and marketing, but does not publish the full default list [1]. Custom Auto Labels are written as short prompts ("job applications", "requests to review work") and can become their own Split Inbox tab. They require the Business or Enterprise plan [1]. Auto Archive takes marketing, cold pitches, and social updates out of the inbox entirely, and they stay reachable through their label [1]. Superhuman does not explain how the classifier decides beyond vendor framing [1].

**Follow-up.** The manual "Remind me" brings a sent email back if nobody replies by a date you choose [7]. Auto Reminders has three scope settings: emails the AI judges to need a follow-up (based on your latest outgoing message when no reply arrived), every external email, or none. You can also set a default reminder time and limit reminders to weekdays [4] (help page blocked our fetcher; from search excerpts). When a reminder fires, the thread returns to the inbox. On Business plans it comes back with a pre-written follow-up draft [4]. Whether an incoming reply automatically cancels a pending reminder is implied but **unverified**. Superhuman's February 2025 post listed automatic sending of follow-ups ("Auto Follow Up") as a *future* feature [1]. We found no evidence that it shipped (**unverified**).

**Drafting.** Write with AI (Cmd/Ctrl+J) turns a prompt into a draft. The help center says it analyzes a sample of your recent emails when you enable it, to learn your tone. Business users can also set written preferences for tone, length, and formatting [3]. Instant Reply (February 2024) puts three full draft replies under the latest received message, matched to the voice of your sent mail [2]. Auto Drafts (Business plan, relaunched July 2026) writes a reply before you open an email and offers two alternative variations [6]. It adapts tone, length, and structure to how you have written to each recipient before [1]. A scheduling variant proposes times and includes a booking link [7]. Superhuman reports that 40% of auto-drafts were sent within a day, and 60% of those were sent unedited. These are vendor figures [6].

**Summaries.** Auto Summarize shows a one-line summary on each conversation, refreshes it as new messages arrive, and expands to bullets on keypress [5]. Superhuman says it stores these summaries for 90 days [5].

**Pricing.** Starter costs $30/month ($25 billed annually) and Business $40/month ($33 annually). There is no free plan. These are competitor-reported prices as of 2026-09-28 [7].

**Reception.** TechCrunch's July 2026 test found Auto Drafts useful for short replies. But the default draft was often overly positive about pitches and would accept meetings after midnight. After one correction, the tool started declining similar times [6]. The same reviewer said earlier Instant Replies read like an overly enthusiastic salesperson and that he rarely used them [6]. Dan Shipper's 2023 review found thread summaries the most useful feature, and voice matching only slightly closer to his style [8].

## Shortwave

**Triage.** Splits are inbox tabs defined by AI importance, labels, senders, or search queries. Bundles group related threads, for example one bundle per newsletter, and can be snoozed or marked done together [11][12]. Shortwave says AI importance learns from which mail you read and whom you reply to [12]. AI filters, which are natural-language auto-label rules, are capped by plan: 3, 10, or 50 [13].

**Follow-up.** The AI assistant can answer questions like "which customers I emailed last week haven't replied" and can suggest todos [10]. We found no Shortwave documentation of an automatic "remind me if no reply" feature (**unverified**).

**Drafting.** Ghostwriter (December 2023) learns from your sent mail through retrieval: every sent email becomes searchable context. For replies it also uses the earlier thread and the people involved [9]. Shortwave does not say whether it fine-tunes models [9]. Users can iterate on tone and length, set a job title and preferred language, and add standing style preferences through "AI Memories" [9][10]. Shortwave claims drafts sound as if you wrote them yourself (vendor claim) [10].

**Scheduling.** The assistant checks availability, writes scheduling emails, creates events, and sends invites. On web and Android there is a "Schedule with AI" action on highlighted dates [10]. The docs do not say whether sending an invite requires a separate confirmation (**unverified**). They describe the user as in control at each step of organizing [10].

**Pricing.** Business $30, Premier $45, Max $120 per seat per month, with a 14-day trial [13].

## HEY (37signals)

**Triage.** The Screener is a first-contact gate: the first time someone emails you, you decide whether you hear from them again [14]. Accepted senders are routed by *sender* (not by message) to the Imbox (important), the Feed (newsletters, shown already open), or the Paper Trail (receipts and transactional mail) [14]. Nothing here is AI. Every routing decision is made once by the user and then applied deterministically.

**Follow-up.** Reply Later moves a thread to a pile at the bottom of the screen. "Focus & Reply" then walks you through that pile in sequence [14][16]. Set Aside is a reference pile [14]. Bubble Up hides a thread and brings it back to the top of the Imbox later [14]. The features page does not list the timing options for Bubble Up. HEY also blocks tracking pixels and names the sender who tried to track you [14].

**Drafting and AI.** HEY has no built-in drafting AI. It now ships a CLI and MCP server so external agents (Claude Code, Codex) can sort the Screener, clear Reply Later, and draft. The agent gets the same access you have, and `hey mcp --read-only` limits it to reading [17]. HEY documents no per-action approval step [17].

**Pricing.** Reported as $99/year for personal accounts. We could not confirm this from hey.com (**unverified**).

**Reception.** A long-time user who left in 2024 called the Screener the best email system he had used, but called Reply Later and Set Aside "just a folder" [15]. Fast Company found that a large Set Aside stack clutters the screen instead of hiding mail the way archive does [16].

## Spark (Readdle)

**Triage.** The Smart Inbox shows unread mail as cards: Priority, People, Notifications, Newsletters, Pins, and Seen [18]. Spark assigns the category per sender. If you recategorize one email, future mail from that sender follows [18]. Gatekeeper (paid) screens first-time senders before the inbox, inside it, or not at all. Blocked senders are not notified [18][19].

**Follow-up.** The Spark AI Assistant (November 2025) can set reminders, archive, unsubscribe, and schedule through conversation [20]. We did not find documentation of automatic "no reply" detection (**unverified**).

**Drafting.** Spark +AI offers tone presets (formal, friendly) and length settings [22]. "My Writing Style" (February 2024) sends a few recent sent emails to Azure OpenAI to learn sentence structure, greetings, sign-offs, pacing, and vocabulary [21][22]. Coverage reports that the samples are deleted after a month and never used for training. That claim comes from secondhand reporting (Cult of Mac via search excerpt), so it is **unverified** at the primary source.

**Privacy architecture.** AI is opt-in. Spark builds a *local* index of your mail, and only the most relevant emails plus the prompt go to its AI provider for each question [20]. This is a useful middle ground for Psyche: local retrieval, then remote generation.

**Pricing.** Free tier (AI assistant over one month of history), Plus $10/month (Priority, Gatekeeper, one year of history), Pro $20/month [20].

## Gmail with Gemini

**Triage.** Inbox categories (Primary, Social, Promotions, Updates, Forums) are fixed. Moving a message to another tab trains the classifier [30]. AI Inbox (announced 2026-01-08) builds a briefing of suggested to-dos plus topics to catch up on [23][24]. It decides who is a VIP from how often you interact with someone, whether they are a contact, and relationships it infers from message content [23]. Google says AI Inbox notices when you have acted on a to-do (read, archived, deleted) and planned a "Mark as done" button [24]. Rollout began with trusted testers [23]. Manage subscriptions (July 2025) lists senders by volume and offers one-click unsubscribe [25].

**Follow-up.** Nudges, shipped in 2018, show "Received N days ago. Reply?" and "Sent N days ago. Follow up?" banners [27]. Users can turn each one off [27]. A widely read 2019 Laptop Mag piece called them an overreach and said to turn them off [28]. AI Inbox also reminds you about snoozed or unanswered mail [24].

**Drafting.** Help Me Write and Suggested Replies are free since January 2026. Suggested Replies replaced Smart Reply and drafts a first reply in your tone and style [23]. At I/O 2025 Google described personalized replies that draw on past emails and Drive files and show their sources. Current access is limited (the help page says Gemini Alpha, work accounts) [26b]. Proofread (tone and style checks) is paid [23].

**Summaries.** Summary cards appear automatically on long threads, and users have to opt out [26]. In January 2026 free users got AI Overview thread summaries [23].

**Scheduling.** "Help me schedule" inserts four proposed slots from your calendar into a reply, and you can edit them. When the recipient picks one, an invite is created. It requires an eligible paid plan [29].

**Reception.** Turning Gemini on by default for Workspace in January 2025 caused backlash. Admins could not find a working off switch, and turning off "smart features" also turned off automatic filtering [31]. One Reddit user, quoted in coverage, said it was "being shoved down our throats" [31]. Pete Koomen's essay "AI Horseless Carriages" (864 points and 478 comments on HN) showed Gemini producing a long, formal draft for a one-line note. He argued that users should own the system prompt that encodes their voice and triage rules [32]. A November 2025 class action alleged that Smart Features were enabled without consent [34]. Reports say it was dismissed in July 2026 with leave to refile (**unverified** against court records).

## Outlook / Microsoft 365 Copilot

**Triage.** "Prioritize my inbox" scores new mail as high, normal, or low as it arrives. The score is computed in parallel, so delivery is not delayed. Setup requires at least one high-priority instruction written in plain language ("it's from my manager"). Each message shows a short reason for its priority. Only mail received after you enable the feature is scored. The low-priority marker is off by default [35]. A third-party analysis reports that admins cannot turn the feature off and that the user's instructions are the only lever on the scoring [36] (from a search excerpt, since the page failed to load).

**Summaries.** "Summary by Copilot" sits at the top of a thread and includes numbered citations that jump to the source message [41].

**Drafting and coaching.** Draft with Copilot has tone and length controls [39]. Custom drafting instructions (tone, length, greeting) apply to every draft [38]. Coaching by Copilot reviews a draft *you* wrote for tone, reader sentiment, and clarity [37]. A PC Pro/TechRadar review called drafts a starting point and said the tone presets overshoot: "formal" comes out very formal [44].

**Scheduling.** "Schedule with Copilot" turns a thread into a draft invite with a title, agenda, attendees, and the thread attached. The user reviews it and sends [40].

**Privacy.** Microsoft states that Graph data and prompts are not used to train foundation models. Prompts and responses are logged in Exchange for audit and eDiscovery. "Not trained on" does not mean "not stored" [42].

**Security incident.** EchoLeak (CVE-2025-32711, CVSS 9.3) was a zero-click attack. A crafted inbound email that Copilot retrieved could make it embed sensitive context in an outbound link, bypassing Microsoft's prompt-injection filters. Microsoft patched it, and there was no known exploitation in the wild [43].

## Fyxer

**Triage.** Fyxer applies labels as Gmail labels or Outlook categories: To respond, FYI, Notification, Marketing. A "Focused" mode keeps only To respond and FYI in the inbox. Users can correct labels and add sender rules [45] (competitor-written review). Fyxer does not publicly document how it classifies.

**Drafting.** Fyxer writes drafts for emails that seem to need a reply and puts them in your Drafts folder. Unused drafts are deleted after 14 days (configurable from 1 to 30). Settings include a "response style" for how often it drafts, Custom Tone, and Custom Files [45]. The homepage says it learns your writing style only through a testimonial, and we could not confirm that it learns from sent mail (**unverified**) [47]. Its help center reportedly says nothing is sent automatically [45].

**Scheduling.** Drafts can propose times from your live calendar or include a booking link [45].

**Pricing.** Free plan with no drafts or sorting. Pro $49/user/month ($37 annually). Team $99 ($64 annually) [45].

**Reception.** Reviews on Trustpilot and elsewhere are split between "saves me hours" and reports that it missed or moved important mail [45][46]. One reviewer said drafts were good about half the time, and that fixing long drafts was slower than writing them [45]. Others said replies were generic and asked for tone per recipient [46]. Billing complaints (unexpected per-seat charges from domain auto-add) come up repeatedly [45][46].

## Notion Mail

**Triage.** Notion Mail (April 2025, Gmail only) let users describe in natural language which kinds of email matter. AI auto-labels then sorted incoming mail into custom "views" [48][49]. HN commenters at launch were split. One said the auto-labeling worked better than any they had tried. Others asked whether granting a startup full mailbox access was wise [51].

**Drafting and scheduling.** AI reply drafting could pull in Notion pages as context. Meeting proposals were matched against Notion Calendar to suggest open times [48]. We could not confirm that fully automatic pre-drafting ever shipped (**unverified**).

**Status.** Notion shut Notion Mail down on 2026-09-22. It cited the shift to agents and said more than half of its users managed email without ever opening the inbox [50]. Auto-label instructions, drafts, and snippets had to be exported. Custom views and reminders did not carry over [50]. *Implication:* the "agent-run inbox" is replacing the "AI-sorted inbox UI", and portable, user-owned triage rules matter.

## Apple Intelligence in Mail (on-device reference)

**Features.** Priority Messages lifts time-sensitive mail (same-day invitations, boarding passes) to the top. Summaries replace preview lines and cover the whole thread. Smart Reply offers short replies and flags questions in the email so none go unanswered [52][53]. iOS 18.2 added fixed categories: Primary, Transactions, Updates, and Promotions. Reports say the sorting runs on-device and also works on hardware that cannot run Apple Intelligence [54].

**Architecture.** Apple says many of its models run entirely on device. Heavier requests go to Private Cloud Compute, which Apple says does not retain data and whose server code can be independently inspected [52]. Our sources do not say which Mail features use PCC and which stay on-device (**unverified**). Developers can call the ~3B-parameter on-device model through the Foundation Models framework. Apple positions it for summarization, extraction, and classification, not world knowledge or advanced reasoning [58]. A third-generation model family was announced in June 2026 [58].

**Reception and failures.** In August 2024, during the beta, Priority Messages promoted phishing emails, such as a fake Xfinity bill. A security analyst said the system weighs content and urgency rather than sender authentication [55]. A self-selected TidBITS poll of 760 readers (June 2025) found that about 90% saw no impact from Priority Messages, Smart Reply, or Mail categorization, and 84% none from Mail summaries [57]. Early categorization misfiled newsletters [54]. Apple paused AI *news* notification summaries in iOS 18.3 after the BBC complained about a fabricated headline. It then added italics and a beta label to summaries and let users turn them off per app [56].

## Evidence on voice learning and local models

- **Few examples are enough to imitate style.** Panza (IST Austria and collaborators) fine-tunes a small model locally, combined with retrieval. It reports convincing style imitation from fewer than 100 emails on very limited hardware, motivated by not uploading mail to third parties [59].
- **Commercial approaches are retrieval-first.** Shortwave retrieves from sent mail [9]. Spark sends a few sent samples to a cloud model [21][22]. Superhuman samples recent mail and adapts per recipient [1][3]. Gmail retrieves from past mail and Drive and shows the sources it used [26b].
- **Explicit, editable instructions fill the gaps that learned voice leaves.** Outlook's custom instructions [38], Superhuman's preferences [3], Shortwave's AI Memories [10], and Koomen's user-owned system prompt [32] all add a standing written style guide.
- **Learning from corrections works, per one report.** In TechCrunch's test, Auto Drafts stopped proposing after-midnight times after a single correction [6].

---

## Cross-cutting: what users keep vs turn off

- **Kept: summaries of long threads.** Reviewers rated them the most useful AI feature from Superhuman's first release [8]. Outlook reviewers say they help most on long, complex mail [44]. Superhuman and Outlook both make summaries ambient or one keypress away [5][41]. Even so, adoption of summaries is modest where they are pushed on users [57].
- **Kept: deterministic, sender-level screening.** HEY's Screener is the feature even departing users praise [15]. Spark and HEY both route by sender, so one decision fixes all future mail from that sender [14][18].
- **Kept, cautiously: short-reply drafts.** Drafts get used for brief, low-stakes replies [6]. Long or varied mail is faster to write by hand [45].
- **Turned off: generic or over-eager drafts.** Instant Reply's salesy tone [6], Gemini's verbose draft [32], generic Fyxer replies [46], and HN's view that prefilled replies are impersonal [32].
- **Turned off: nudges and pushed-on AI.** Gmail nudges are a common "disable this" recommendation [28]. Default-on Gemini drew backlash centered on consent and missing off switches [31][26]. Apple added per-app off switches after the summary errors [56].
- **Abandoned products.** Notion Mail closed, and its own stated reason is that users delegated email to agents instead of opening an AI inbox [50].

## Cross-cutting: failure modes

1. **Over-nudging and notification fatigue.** Reminders for mail the user already knows is unanswered feel like an overreach [28]. Superhuman's "every external email" reminder scope shows how wide automatic reminders can get [4]. AI Inbox adds unanswered-mail reminders on top of existing nudges [24].
2. **Wrong-tone or hallucinated content.** Seen as salesy tone [6], verbose formality [32][44], drafts that accept unsuitable meetings [6], and fabricated summaries (Apple's news summaries [56]). Prompt-injected summaries can add fake security warnings that are not in the visible email [33].
3. **Misclassified important mail.** Fyxer users report important mail being hidden or moved [45]. Apple's Priority Messages promoted phishing [55]. Apple's early categories misfiled mail [54]. Copilot only scores mail received after it is turned on [35].
4. **Sending or acting without consent.** Every mainstream product we checked keeps a human send step [6][40][45]. Superhuman has publicly planned auto-send follow-ups [1]. Claude's Gmail connector can now send, with approval on by default, and owners can waive it [61]. The top reader comment called this "a recipe for disaster" [61]. The sharpest incident involved an agent, not a mail client. In February 2026 an OpenClaw agent told to only *suggest* deletions deleted hundreds of a Meta alignment director's emails. Her preliminary account blames a constraint lost when context was compacted, and remote stop commands did not work [60].
5. **Prompt injection through inbound mail.** Hidden-text instructions hijacked Gemini summaries [33]. EchoLeak exfiltrated Copilot context with zero clicks [43]. A mail agent's input is written by attackers by default.
6. **Privacy of cloud processing.** Default-on access drew a lawsuit [34]. Vendors answer with "not used for training" while still logging and retaining data [42], or with a local index plus remote generation [20]. HN commenters asked whether granting full-mailbox OAuth to a startup was wise [51].

---

## Design implications for Psyche

1. **Route by sender first, then by message.** Do a one-time, owner-confirmed decision per new sender (HEY or Gatekeeper style) before any per-message AI. Sender screening is the most durable feature users keep [14][15][18].
2. **Let the owner write and edit the triage and voice rules.** Keep them as a plain-text, versioned file that can be exported. Notion Mail users had to rescue their auto-label instructions at shutdown, and Koomen's user-owned prompt beat the vendor default [32][50].
3. **Explain every triage decision.** Give a one-line reason ("from your manager", "invoice due Friday") with an easy correction that updates the sender rule. Copilot's reasons and per-sender recategorization in Spark and Gmail are the reference [18][30][35].
4. **Treat sender authentication as a hard triage signal.** Never let SPF/DKIM/DMARC-failing or lookalike-domain mail rank as priority, because content-only ranking promoted phishing [55].
5. **Make the daily digest the single nudge channel.** Batch "waiting on" items into the digest instead of separate banners, since per-thread nudges are a common disable target [24][28].
6. **Flag "waiting on" only when the owner's last message asked something.** Auto-resolve the item as soon as any reply lands in the thread. Superhuman's AI-detected scope beats "every external email" [4].
7. **Default to drafting only for short, low-stakes replies.** Offer two or three variants and never touch long threads without being asked. That is where drafts get used, and long drafts are slower to fix than to write [6][45].
8. **Learn voice locally from about 100 sent emails per recipient group, plus a written style guide.** Panza shows local imitation from under 100 samples, and every vendor adds editable instructions on top [3][38][59].
9. **Never commit the owner to a time, a price, or a yes in a draft without marking it.** Highlight commitments (meeting acceptances, agreements) for explicit review, given drafts that cheerfully accepted pitches and after-midnight meetings [6].
10. **Compute scheduling slots from the local calendar and require approval for both the slots and the invite.** Gmail's editable four-slot insert and Outlook's review-then-send invite are the pattern [29][40].
11. **Enforce the no-send rule in code, not in the prompt.** Approval should be a tool-layer gate that cannot be compacted away. The OpenClaw deletion happened when a prompt-level constraint was lost [32][60].
12. **Give the agent a local, instant kill switch and read-only mode.** HEY's `--read-only` MCP mode is the model, and remote stop failed in the OpenClaw incident [17][60].
13. **Sanitize inbound mail before the model sees it.** Strip hidden text, render AI output apart from quoted mail, and never let summaries add phone numbers or links that are not in the source [33][43].
14. **Keep classification and summarization on-device by default and label any cloud call.** Apple's ~3B on-device model targets exactly these tasks. Spark's local index with minimal remote context shows the fallback, and default-on cloud processing drew lawsuits and backlash [20][31][34][58].
15. **Every AI feature ships off or opt-in, with its own switch.** Forced, bundled Gemini settings and Apple's after-the-fact per-app toggles show the cost of doing otherwise [31][56].

---

## Sources

All accessed 2026-10-25.

1. Superhuman Blog, "The next evolution of Superhuman AI" (2025-02-19). https://blog.superhuman.com/the-next-superhuman-ai/
2. Superhuman Blog, "New in Superhuman AI: Instant Reply" (2024-02-27). https://blog.superhuman.com/superhuman-ai-instant-reply/
3. Superhuman Help Center, "Write with AI" and personalization articles (from search-index excerpts; direct fetch returned 403). https://help.superhuman.com/hc/en-us/articles/38456855116307-Write-with-AI
4. Superhuman Help Center, "Reminders on Autopilot" / "Follow Up Faster" (from search-index excerpts; direct fetch returned 403). https://help.superhuman.com/hc/en-us/articles/45270478397203-Reminders-on-Autopilot
5. Superhuman Help Center and blog, "Auto Summarize" (search-index excerpts). https://help.superhuman.com/hc/en-us/articles/38458640102291-Auto-Summarize
6. I. Mehta, "Superhuman's new auto-draft feature almost makes me like AI replies," TechCrunch (2026-07-14). https://techcrunch.com/2026/07/14/superhumans-new-auto-draft-feature-almost-makes-me-like-ai-replies/
7. Carly, "Superhuman review" (2026-09-28; competitor-authored). https://www.usecarly.com/blog/superhuman-review/
8. D. Shipper, "I Let An AI Do My Email," Every (2023-06-29). https://every.to/chain-of-thought/ai-can-do-my-email-now
9. Shortwave Blog, "Introducing Ghostwriter: AI writing that learns from you" (2023-12-06). https://shortwave.com/blog/introducing-ghostwriter-ai-writing-that-learns-from-you
10. Shortwave Docs, "The Shortwave AI Assistant." https://www.shortwave.com/docs/guides/ai-assistant/
11. Shortwave Docs, labels, splits, and bundles guide. https://shortwave.com/docs/guides/labels
12. 9to5Google, "Shortwave adds inbox splits" (2024-06-05). https://9to5google.com/2024/06/05/shortwave-adds-inbox-splits/
13. Shortwave, Pricing. https://www.shortwave.com/pricing/
14. HEY, Features. https://www.hey.com/features/
15. A. Biggs, "Goodbye Hey.com" (2024-09-17). https://notes.ansonbiggs.com/goodbye-hey-com/
16. Fast Company, "HEY is a visionary alternative to Gmail, but it's missing the basics" (2020; from search excerpt). https://www.fastcompany.com/90522517/hey-is-a-visionary-alternative-to-gmail-but-its-missing-the-basics
17. HEY Help, "Using AI agents with HEY." https://help.hey.com/article/1189-using-ai-agents-with-hey
18. Spark Help, "Customize your inbox." https://sparkmailapp.com/help/manage-your-inbox/customize-your-inbox
19. Spark Help, "Accept or block new senders." https://sparkmailapp.com/help/set-up-focus/accept-or-block-new-senders
20. Readdle press release, Spark AI Assistant and new plans (2025-11-11). https://readdle.com/press/release/4647
21. Spark Blog, "My Writing Style drafts +AI emails in your unique voice" (2024-02-22). https://sparkmailapp.com/blog/my-writing-style
22. Spark Help, "Spark +AI" (search-index excerpt). https://readdle.helpjuice.com/spark-ai
23. B. Barnes, "Gmail is entering the Gemini era," Google Blog (2026-01-08). https://blog.google/products-and-platforms/products/gmail/gmail-gemini
24. T. Mehta, "Gmail AI Inbox," Android Authority (2026-01-08). https://www.androidauthority.com/gmail-ai-inbox-to-dos-prioritize-emails-3630919/
25. Google Workspace Updates, "Manage email subscriptions in Gmail" (2025-07-08). https://workspaceupdates.googleblog.com/2025/07/manage-email-subscriptions-in-gmail.html
26. TechCrunch, "Gemini will now automatically summarize your long emails unless you opt out" (2025-05-30; search excerpt). https://techcrunch.com/2025/05/30/gemini-will-now-automatically-summarize-your-long-emails-unless-you-opt-out
26b. Android Authority, Gmail personalized smart replies (I/O 2025), and Gmail Help on sources and availability. https://www.androidauthority.com/gmail-personalized-smart-replies-fast-appointment-scheduling-3559295 ; https://support.google.com/mail/answer/15464729
27. Gmail Help, "Reply to messages in Gmail" (nudges). https://support.google.com/mail/answer/6585
28. H. T. Casey, "The One Gmail Feature You Should Disable Now," Laptop Mag (2019-05-09). https://www.laptopmag.com/articles/how-to-turn-off-gmail-nudge
29. Gmail Help, "Suggest times to meet with Gemini in Gmail." https://support.google.com/mail/answer/16865189
30. Gmail Help, "Organize your emails into categories." https://support.google.com/mail/answer/3094499
31. Information Age (ACS), "'Can't turn it off': Google faces backlash over Gmail AI" (2025-01-21). https://ia.acs.org.au/article/2025/-can-t-turn-it-off---google-faces-backlash-over-gmail-ai.html
32. P. Koomen, "AI Horseless Carriages" (2025-04) and HN discussion. https://koomen.dev/essays/horseless-carriages/ ; https://news.ycombinator.com/item?id=43773813
33. M. Figueroa, "Phishing for Gemini," 0DIN (2025-07-10). https://0din.ai/blog/phishing-for-gemini
34. Quartz, coverage of *Thele v. Google* (2025-11). https://qz.com/google-lawsuit-gemini-ai-read-private-emails
35. Microsoft Support, "Prioritize my inbox." https://support.microsoft.com/en-US/Outlook/copilot-outlook/prioritize-my-inbox
36. Practical365, "Prioritize My Inbox Advances the State of the Email Filtering Art" (search excerpt; fetch failed). https://practical365.com/prioritize-my-inbox
37. Microsoft Support, "Get email coaching with Copilot in Outlook." https://support.microsoft.com/office/email-coaching-with-copilot-in-outlook-91a3cd56-1586-4a31-85c7-2eb8cdb02405
38. Microsoft Support, "Ask Copilot to make email drafts sound like you." https://support.microsoft.com/en-au/outlook/copilot-outlook/ask-copilot-to-make-email-drafts-sound-like-you
39. Microsoft Learn, "Rewrite messages and replies for tone using Microsoft 365 Copilot in Outlook." https://learn.microsoft.com/en-us/training/modules/edit-transform-content-with-microsoft-copilot-microsoft-365/5-rewrite-messages-replies-tone-copilot-outlook
40. Microsoft 365 Roadmap RM483007, "Schedule from email with Copilot," and Microsoft Support, "Create a meeting with Copilot." https://mc.merill.net/message/RM483007 ; https://support.microsoft.com/en-us/office/create-a-meeting-agenda-with-copilot-in-outlook-31a44dfa-62bb-4751-82c4-14327a26759f
41. Microsoft Support, "Summarize an email thread with Copilot in Outlook." https://support.microsoft.com/en-us/outlook/copilot-pages/summarize-an-email-thread-with-copilot-in-outlook
42. Microsoft Learn, "Data, Privacy, and Security for Microsoft 365 Copilot" and "Copilot Chat privacy and protections." https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy ; https://learn.microsoft.com/en-us/copilot/privacy-and-protections
43. "EchoLeak: The First Real-World Zero-Click Prompt Injection Exploit in a Production LLM System" (arXiv 2509.10540) and The Hacker News (2025-06). https://arxiv.org/html/2509.10540v1 ; https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html
44. TechRadar / PC Pro, "Hands on: Copilot Pro for Outlook review" (date unclear; search excerpt). https://www.techradar.com/pro/copilot-pro-for-outlook-review
45. Carly, "Fyxer AI review" (2026-09-28, pricing re-checked 2026-10-03; competitor-authored). https://www.usecarly.com/blog/fyxer-ai-review/
46. Trustpilot, Fyxer reviews, page 3 (reviews dated June–July; the year is not shown on the fetched page). https://www.trustpilot.com/review/fyxer.com?page=3
47. Fyxer homepage. https://www.fyxer.com/
48. TechCrunch, "Notion releases its AI-driven email inbox" (2025-04-15). https://techcrunch.com/2025/04/15/notion-releases-its-ai-driven-email-inbox
49. Notion Releases 2.50 (2025-04-15; search excerpt). https://www.notion.com/releases/2025-04-15
50. 9to5Mac, "Notion shutting down its AI-powered email client" (2026-06-25). https://9to5mac.com/2026/06/25/notion-shutting-down-its-ai-powered-email-client-including-mac-and-ios-apps/
51. Hacker News, "Notion Mail is out" (2025-04-15). https://news.ycombinator.com/item?id=43694310
52. Apple Newsroom, "Introducing Apple Intelligence for iPhone, iPad, and Mac" (2024-06-10). https://www.apple.com/newsroom/2024/06/introducing-apple-intelligence-for-iphone-ipad-and-mac/
53. Apple Support, "Use Apple Intelligence in Mail" (Mac and iPhone). https://support.apple.com/guide/mac-help/use-apple-intelligence-in-mail-mchlb2dbea8f/mac ; https://support.apple.com/en-ca/guide/iphone/iph9ae667055/ios
54. 9to5Mac, "iOS 18.2 beta redesigned Mail app" (2024-10-23), and Creative Technology, "Mail on the iPhone can categorize your messages in iOS 18.2" (2025-01-14). https://9to5mac.com/2024/10/23/ios-18-2-beta-redesigned-mail-app/ ; https://www.creativetechs.com/2025/01/14/mail-on-the-iphone-can-categorize-your-messages-in-ios-18-2/
55. AI Incident Database, Incident 892, "Apple Intelligence Allegedly Flags Scam Messages as High Priority" (2024-08; cites Tom's Guide, Cybernews, Lifehacker). https://incidentdatabase.ai/cite/892
56. AlternativeTo, "Apple pauses AI notification summaries for news alerts in latest iOS 18.3 beta" (2025-01). https://alternativeto.net/news/2025/1/apple-pauses-ai-notification-summaries-for-news-alerts-in-latest-ios-18-3-beta
57. A. Engst, "Do You Use It? Apple Intelligence Sees Weak Adoption," TidBITS (2025-06-20). https://tidbits.com/2025/06/20/do-you-use-it-apple-intelligence-sees-weak-adoption/
58. Apple Developer, "Meet the Foundation Models framework" (WWDC25), and Apple ML Research, foundation model updates (2025) and third generation (2026-06-08). https://developer.apple.com/videos/play/wwdc2025/286/ ; https://machinelearning.apple.com/research/apple-foundation-models-2025-updates ; https://machinelearning.apple.com/research/introducing-third-generation-of-apple-foundation-models
59. "Panza: Design and Analysis of a Fully-Local Personalized Text Writing Assistant" (arXiv 2407.10994). https://arxiv.org/abs/2407.10994
60. Let's Data Science, "Meta's AI safety chief told her AI agent to stop. It deleted her inbox anyway" (2026-02), and AI Incident Database entity "OpenClaw users." https://www.letsdatascience.com/blog/metas-ai-safety-chief-told-her-ai-agent-to-stop-it-deleted-her-inbox-anyway ; https://incidentdatabase.ai/entities/openclaw-users/
61. 9to5Google, "Claude can now send emails in Gmail, even without your approval" (2026-08-18). https://9to5google.com/2026/08/18/claude-can-now-send-emails-in-gmail-even-without-your-approval/
