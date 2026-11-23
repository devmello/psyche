# Meetings and scheduling: prior art and user reactions (2026)

**Purpose.** Background for Psyche's meeting and scheduling workflows: scheduling over email from free/busy, a prep note before each meeting, and post-meeting notes from on-device transcription (SpeechAnalyzer), with action items going to Reminders/Things only after the owner approves. This note covers what comparable products do, how users react, and where these products have failed.

**Date.** Research done and all sources accessed 2026-10-25.

**Method.** Web research on vendor help centres, official product pages, court and legal reporting, trade press, and review and community sites (G2, Zoom Community, university IT knowledge bases). Vendor marketing and competitor blogs are labelled as such. Anything I could not confirm against a primary or reasonably independent source is marked **unverified**. Quotes are kept under 15 words. Reddit and Hacker News searches mostly turned up second-hand summaries rather than threads I could cite, so community sentiment comes mainly from G2, Zoom Community, and press coverage.

---

## 1. Granola

**What it is.** A notepad that captures meetings without a bot. It records the computer's microphone and system audio, and "Granola doesn't join your meeting" [1]. You type rough notes during the call. When the call ends, Granola "enhances" them by merging your notes with the transcript, so your own lines are kept and the transcript fills in around them [1]. It runs on macOS, Windows, iOS and Android, and works with Zoom, Meet, Teams, Slack Huddles and in-person meetings [1].

**Templates.** Templates are private by default and can be shared with an organisation if you sign in with a company domain [4]. Granola's blog says a good template has metadata, agenda, decisions, action items with owners and deadlines, and next steps. It also says a template should shape the output, not constrain the conversation [5]. Post-meeting prompts can list actions or draft a follow-up email [1].

**Prep.** "Pre-meeting briefs" are prepared overnight and shown at the top of the chat panel when you open an upcoming meeting's note [2]. A brief is usually 2–3 bullets: open threads, context from the web or calendar, and recent email if you opt into Gmail [2]. It draws on your earlier Granola notes with the same people or company, shared workspace notes, the web (including LinkedIn), calendar details and agenda, and Gmail [2]. Briefs are made **only for external meetings**. Granola skips them when it finds too little to say, and each one has a thumbs-down for reporting errors [2]. A separate desktop notification fires one minute before meetings with 2+ attendees [2].

**Post-meeting.** Notes are private by default, and sharing with participants is opt-in [1]. Each bullet can be traced back to the transcript (third-party review, **unverified** in Granola docs).

**Consent model.** Granola puts the duty on the user. Its consent page calls telling participants "best practice" and offers an in-chat message plus a camera watermark "when enabled" [3]. *Chamberlain v. Granola, Inc.*, No. 3:26-cv-07926-EMC (N.D. Cal.), was filed 2026-07-30 [6]. It alleges participants are not notified by default, that both notices have to be enabled separately, and that transcripts were used for model training by default on Free and Business plans [6][7]. The allegations are unproven, and no ruling had been reported as of mid-October 2026 [8].

**On-device vs cloud.** Capture is local. Transcription and enhancement are cloud services (the docs describe audio as temporarily cached and then deleted, per [6][8]).

## 2. Otter.ai (OtterPilot / Otter Meeting Agent)

**What it does.** OtterPilot launched in February 2023. It joins calendar meetings as a visible participant, transcribes them, captures slides, and writes a summary [9]. Third-party reviews describe the output as an overview, bullet notes, and action items with owners where Otter can identify them, plus a chat over meetings [15] (vendor-adjacent, treat as approximate).

**Sharing.** Auto-join and auto-share are separate settings. A university IT guide documents a "Default audience for shared notes" setting that can share notes with calendar guests, and a separate "Auto-join all meetings" toggle [12].

**The defining incident.** In September 2024, engineer Alex Bilzerian had a Zoom call with a VC firm. Otter kept recording after he left. It then emailed everyone on the invite a transcript that included the investors' later private discussion, and the deal did not go ahead [10]. Otter's response was that users control sharing permissions [10].

**Consent and legal.** *In re Otter.AI Privacy Litigation*, No. 25-cv-06911-EKL (N.D. Cal.), consolidates four suits filed in August–September 2025 [10][11]. The plaintiffs allege auto-join is on by default, that it keeps joining after users turn it off, and that non-users are notified only on Enterprise plans [9][10]. On 2026-08-13 the court granted Otter's motion to dismiss in part and denied it in part. The ECPA, CIPA and BIPA claims survived, and the computer-intrusion claims were dismissed [14][8]. A secondary source reports the court found Otter plausibly a "third-party eavesdropper" because it uses meeting audio for its own purposes, such as training [8]. Check the wording against the order [14] before relying on it.

**User reaction.** On Zoom Community, hosts describe guests' Otter bots joining meetings those guests never attended. They also report bots coming back after removal ("whack a mole") and non-users having to recover an account just to turn auto-join off [13].

**On-device vs cloud.** Fully cloud.

## 3. Fathom

**What it does.** A recorder with a free tier ("free forever"). It offers "bot or no bot" capture, summaries "instantly available after your call," and action items "delivered straight to your inbox" [16]. It syncs to CRMs. The HubSpot listing says notes and action items sync to HubSpot Tasks and Meetings and can map to deal fields [18]. One guide describes a review step before notes go to Salesforce or HubSpot (**unverified** in Fathom docs).

**Consent model.** This is the most concrete consent mechanism among the vendors reviewed. With "Auto Request Recording Consent" on, Fathom emails **external** attendees 24 hours before a scheduled meeting [17]. If someone picks "No, I'd prefer not to be recorded", auto-record is turned off for that meeting and a warning icon appears. The host can still ask for verbal consent and record manually [17]. If nobody replies, Fathom records as normal. No email goes out for same-day or impromptu meetings. Bot-based meetings also require that the user is host and that there is exactly one guest [17]. Fathom also warns that recording without permission "can even be illegal" in some places [17].

**On-device vs cloud.** Cloud.

## 4. Reclaim.ai

**Context.** Dropbox acquired Reclaim in August 2024, and the product is still available [23]. When Clockwise shut down, it pointed users to Reclaim [27].

**Scheduling mechanics.**
- *Habits* (recurring routines) start out marked **free** and flip to **busy** as the day fills up or the start time gets close. A per-habit "time defense" setting runs from most flexible to most defensive [20]. Higher-priority items can overbook lower ones [20].
- *Smart Meetings* find a time for two or more people from mutual availability, including across time zones. They need at least free/busy access to attendees, and each attendee gets a one-time invitation to accept before auto-scheduling starts [19]. If something is booked over a Smart Meeting, Reclaim moves it. By default meetings **auto-lock at the start of each working day** so they stop moving, and RSVP "No" asks Reclaim to find another day [19]. Help docs describe a "View change log" explaining why an event moved (search snippet of Reclaim help, **unverified** in the 2.0 docs).
- *Scheduling links* let invitees choose the time zone shown. The page shows the actual zone for comparison when it differs, and offers round-robin and location choice [22].
- *Buffers.* Travel time is added around events that have a physical address and moves with the event. Decompression time follows meetings. Breaks separate tasks and habits [21].

**Prep / post-meeting.** None. Reclaim is a scheduling layer only.

**User reaction.** Reviews credit it with protecting focus time. Complaints are mostly about platform coverage and a learning curve (review aggregators of low quality; not cited).

## 5. Motion

**Mechanics.** Motion's auto-scheduling places tasks on the calendar from priority, deadline, duration and dependencies, and works around existing meetings. Schedules "adjust automatically as meetings, priorities, and deadlines change" [24]. Motion's own guidance is to use manual control for fixed events and to "review your plan daily" [24]. Booking links check real-time availability across multiple calendars, with buffers and daily limits [25].

**User reaction.** A review roundup reports that a common complaint is days packed so tightly there is "no breathing room," and that early users hit double-booking and sync problems [26] (secondary source citing The Business Dive and Cybernews). I could not find a cited source for the widely repeated claim that Motion reshuffles tasks constantly (**unverified**).

**Prep / post-meeting.** None found.

## 6. Clockwise (shut down 2026-03-27)

**Mechanics.** Clockwise defended "Focus Time" and let users mark internal meetings (1:1s, small syncs) as *flexible*. "Once a day," it moved flexible meetings to the least disruptive time for the team [29].

**Outcome.** Salesforce hired the team into Agentforce, and the service ended on 2026-03-27. Customer data was deleted, not transferred, and users had little notice [27][28].

**User reaction.** A positive G2 review still notes that automatic rescheduling "can throw off colleagues" who expected the original time [30]. Reviewers also say it works best when the whole team uses it [30].

**Lesson.** Moving meetings automatically affects other people. Value depends on team-wide adoption, and so does the friction.

## 7. Fantastical (Flexibits)

**Natural-language entry.** Typed phrases such as "Lunch with John on Friday at 1pm" become events [33].

**Openings** (booking links). The host sets availability blocks in a template. Only the unscheduled parts are shown, checked against a calendar set the host chooses. Calendars left out of that set can cause double-booking [31]. The host picks a listing time zone, and invitees can switch to their own [31]. Requests can be auto-approved or reviewed by hand [31]. Break Time adds buffers, and there are lead-time, booking-window and frequency caps [31]. For privacy, Openings uploads only busy times, plus calendar names and colours, never event details [31].

**Proposals** (poll-style). The host proposes several times. They show on the host's calendar via a "Fantastical Scheduling Proposals" calendar, so they work as visible soft holds [32]. Invitees answer through a web page or in Fantastical, choosing one or more times and optionally commenting [32]. An "Add event" setting decides whether the final event is created automatically once everyone has replied or after the host reviews. The conference link is created only on confirmation [32]. The help page doesn't say whether proposals check conflicts or what happens to unchosen holds (**unverified**).

**Prep / post-meeting / recording.** None.

## 8. Calendly

**Mechanics.** Calendly detects time zones for host and invitee, and invitees see times in their local zone by default [34]. Buffer time can be set per event type or per booking [34]. *Routing* qualifies invitees with form answers and sends each to the right person or event type [35]. *Meeting polls* (all plans) take votes on up to 40 slots, and the host books the winner. The poll closes on booking or when every slot has passed [36].

**Etiquette debate.** In January 2022, Sam Lessin called sending a Calendly link a "naked display of social capital dynamics" and said he would "never click" one [38]. Defenders pointed to cost: one Doodle survey put scheduling at up to 4.8 hours a week [38]. Calendly's own write-up cites an April 2020 informal poll split about 50/50 on whether links are rude. Its own sentiment analysis found "85% neutral to positive" (self-reported) [37]. Calendly recommends **offering specific times first** and giving the link only as a fallback, and it criticises a bare "here's my Calendly" [37]. A productivity strategist quoted in [38] advises against sending links to very senior people.

## 9. Apple Intelligence, Siri, and platform APIs

**Phone call recording (iOS 18.1+).** You can record phone and FaceTime audio calls. **Both participants hear an audio notice**, which repeats during the call, and Apple advises getting explicit consent [39]. Recordings and transcripts go to a Call Recordings folder in Notes. Supported devices with Apple Intelligence also get a summary, and Apple says to check transcripts for accuracy [39]. The feature is limited to some regions and languages [39]. Press coverage says the notice can't be turned off and plays even in one-party-consent jurisdictions (secondary, consistent with [39]). On macOS Tahoe the Phone app reportedly relays calls with recording and transcription. I found only secondary sources for this (**unverified**).

**Notes audio on Mac.** Notes can record audio such as a meeting or lecture, and Apple Intelligence can summarise the transcript. The summary can be copied or shared [40]. Apple doesn't document any notice to other people present.

**Suggested reminders (iOS 26).** You share text or a page to Reminders, and Apple Intelligence **suggests** reminders such as "key action items from emails". **The user chooses which to add** and which list they go into [41]. Auto-Categorize groups reminders into sections [41]. Apple's documentation describes this as a suggestion flow driven by what the user shares, not background scanning.

**Mail.** Priority Messages pushes time-sensitive mail to the top, and inbox and thread summaries plus Smart Reply arrived in 2024 [45]. Early beta users complained about prioritised mail about calendar events that had already been cancelled, and about summaries that got facts backwards [45]. Apple **paused notification summaries for news apps** in January 2025 after false headlines (for example a summary wrongly saying a murder suspect had shot himself). The returning summaries carry italics and a warning that they may contain mistakes [46].

**On-device vs cloud.** Apple says it runs models on device where it can, and sends heavier requests to Private Cloud Compute, which it says does not store data. A Mac report lists recent PCC requests [42]. Apple doesn't say which path Notes summaries use (**unverified**).

**Speech APIs.** SpeechAnalyzer/SpeechTranscriber (iOS 26 / macOS Tahoe) runs on device, is built for "long-form and distant audio" such as meetings, and already powers Notes and Voice Memos [43]. Argmax, which sells a competing Whisper SDK, found it matched mid-tier Whisper accuracy on long-form conversation, tested on a beta macOS [44]. Apple's documentation does not describe diarization (speaker labels) for it (**unverified**). Psyche should not assume it gets speaker attribution for free.

**Siri / App Intents.** The personal-context Siri was delayed from 2025 [47]. Coverage of WWDC 2026 (June 8) describes a rebuilt "Siri AI" with personal context across messages and email in iOS 27 / macOS 27 [48]. These are secondary reports, and the shipped scope, including any meeting features, is **unverified**.

## 10. Microsoft Copilot in Teams and Outlook

**Prep.** Outlook's "Prepare with Copilot" builds a meeting brief from **related emails and documents, your action items, and a recap of the previous meeting** [50]. It only appears for meetings with at least three participants that have related content, only summarises content the viewer can already access, and may be "generic" when there is little to draw on [50]. Copilot for Sales sends prep notifications **one hour before** by default. Its daily digest is **off by default** and is described as reducing "notification fatigue" [64].

**During/after.** Copilot summarises discussion, suggests action items and answers questions. Querying after the meeting requires transcription [68]. The organiser can choose "Only during the meeting", which keeps nothing that wasn't transcribed once the meeting ends [68]. The Recap tab shows the AI summary and follow-up tasks, speaker timelines, chapters, and personal markers for mentions. Name-mention markers rely on transcript names matching display names [49]. Organisers can send recap emails [49]. A Copilot/Facilitator path from tasks to Planner is reported as rolling out in September 2026 with owner assignment still needing manual checks (**unverified**, secondary [52]).

**Consent model.** Admins can require **explicit participant agreement**. Participants stay muted with cameras off until they choose Yes, and choosing No gives a view-only experience. Consent choices are recorded in the attendance report [51]. This policy does not apply to transcription-only meetings [51].

## 11. Google Gemini in Meet and Gmail

**"Take notes for me".** Notes go into a Google Doc with a summary, details, and a **"Next steps"** section of "actionable items and assigned tasks" [53]. Next steps can be edited and assigned to people within the doc [54]. **Distribution is chosen by the host**: all invited guests including external ones, internal invitees only, or hosts only. "Invited guests" means everyone on the invite, not only the people who attended [53]. Meet tells all participants and shows a pencil icon. Internal participants can stop note-taking unless host controls are on, and admins can require explicit consent [53]. Admin settings can turn it on automatically for some meetings [53]. Google warns that notes "can be incomplete, inaccurate" and recommends meetings of at least 15 minutes [53]. A Google Tasks hand-off was not found (**unverified**).

**"Help me schedule" (Gmail, October 2025).** When you reply to an email about meeting, Gmail shows a button. Gemini proposes slots from your calendar and the email's context, you edit them, and they go into the reply. When the recipient picks one, an invite is created for everyone [55]. Reported limit: **one-on-one only** [55]. This is the closest match in this research to Psyche's email-plus-free/busy flow.

## 12. Zoom AI Companion

**Post-meeting.** The summary covers discussion topics and next steps [57][58]. **By default only the host sees it**, and institutions advise hosts to review and edit it before sharing because summaries are "often inaccurate" [57][58]. Hosts can share with invitees and auto-start the summary for every meeting [58].

**Consent.** Attendees get a prompt and can't use their mic or camera until they accept. A Zoom employee said in 2024 that people who stay without accepting are still captured, and that the prompt can't be customised [57][59].

**Prep and scheduling (AI Companion 3.0, announced Sept 2025).** The 3.0 announcement includes a "prepare me for a meeting" skill covering agenda, previous action items and key insights, agentic scheduling that accounts for time off, time zones and current schedules, Zoom Tasks for to-dos, and "free up my time", which suggests meetings to skip [56]. These are announced features, and what has actually shipped is **unverified**.

---

## Cross-cutting: what users keep vs turn off

- **Kept: notes without a bot, and your own notes as the backbone.** Comparison sites consistently put Granola's lack of a visible bot first among reasons people switch [69] (comparison blogs, some vendor-adjacent). Granola's design centres on the user's own notes [1].
- **Kept: host-first review.** The platforms that set expectations (Zoom, Meet's "hosts only" option, Teams recap emails started by the organiser) all let a person see the summary before others do [49][53][57][58]. Institutions explicitly tell hosts to keep summaries private until reviewed [58].
- **Turned off or blocked: auto-join bots.** Hosts use waiting rooms, watch for bot names, and remove bots repeatedly [13]. Lawyers advise removing bots from privileged calls [61]. A Bloomberg column describes the bots as a new meeting irritant [60].
- **Turned off: unsolicited briefings.** One university turned off Microsoft's default-on daily briefing email after user feedback [65]. Vendors now ship digests and prep features **off by default** or limited to certain meetings: Copilot for Sales digest [64], Fireflies prep (not sent for one-off meetings) [66], Granola briefs (external only) [2], Copilot prep (3+ participants with related content) [50].
- **Abandoned: autonomous calendar reshuffling.** Clockwise is gone [27]. Its reviews mention colleagues confused by moved meetings [30]. Motion's own docs tell users to review the plan daily [24]. Reclaim's default is to *lock* meetings each morning, which in practice limits how much churn it allows [19].
- **Kept: polls and offered times over bare links.** Calendly itself recommends offering times first [37]. Calendly [36] and Fantastical [32] both offer polls, and Gmail's new feature inserts proposed times into the reply rather than a link [55].

## Failure modes

**1. Recording without consent (wiretap law).** Federal law requires one party's consent. California, Florida, Illinois, Massachusetts, Pennsylvania and Washington, among others, require **all parties** to consent. Lists vary between about 11 and 13 states, and calls that span states have no clear rule, so the safe default is to get everyone's consent [62][63]. The lawsuits against Otter [8][14] and Granola [6] centre on notice to non-users. The Otter ruling turned partly on the vendor using recordings for its own purposes [8]. Apple's answer is an audio notice that can't be skipped [39]. Teams and Zoom block mic and camera until a participant agrees [51][57]. Fathom asks external attendees 24 hours ahead [17]. A local agent that never trains on audio avoids the "third-party eavesdropper" theory, but the *user* still needs all-party consent where the law requires it.

**2. Auto-sharing notes with attendees.** The Bilzerian incident [10] combined two failures: recording continued after the meeting ended, and the transcript was sent automatically to everyone on the invite. Meet's "invited guests" option includes people who never attended [53]. Every safer design found here defaults to host-only [57][58].

**3. Hallucinated action items and misattributed decisions.** Google [53], Zoom institutions [58] and Apple [39][41] all warn that output can be inaccurate. Apple's news summaries were pulled for inventing facts [46]. Teams name-mention markers depend on transcript names matching display names [49], so attribution is fragile. A vendor QA guide says summarisers tend to invent action items to look complete, and recommends checking owner, deliverable and deadline against the transcript [67] (vendor source). Meeting transcription still has measurable error rates, much of it from overlapping speech (secondary report of a 2025 RWTH/AppTek analysis, **unverified**).

**4. Calendar over-optimisation and churn.** Automatic moves surprise colleagues [30], overpacked days are a common complaint about Motion [26], and the best-known "flexible meetings" product shut down [27]. Reclaim's mitigations are locks, honouring RSVPs, and a change log [19][20].

**5. Prep that comes too early, too often, or empty.** Briefs prepared overnight [2] or sent one hour before by default [64] are the common choices. Every major vendor limits volume (see above). Copilot admits briefs can be "generic" without related content [50], and Granola skips briefs with too little to say [2].

**6. Scheduling links seen as rude.** This is mostly about framing and seniority [37][38]. Offered times with a link as fallback is the vendor-endorsed compromise [37].

---

## Design implications for Psyche

1. **Default to proposing specific times in the email body** (2–3 slots taken from free/busy) with an optional link as fallback, because Calendly's own guidance and Gmail's "Help me schedule" both favour offered times over a bare link [37][55].
2. **Show proposed slots as tentative holds on the user's calendar and release the unchosen ones once one is confirmed**, following Fantastical Proposals' visible holds and create-on-confirm behaviour [32]. Removing the other holds is Psyche's own addition, since Fantastical doesn't document it.
3. **Write every proposed time in both the user's and the recipient's time zones and label the zone explicitly**, because Calendly, Reclaim and Fantastical all treat invitee time zone as a first-class choice [22][31][34].
4. **Never move an existing meeting with other attendees without explicit approval, and lock the day's schedule each morning**, given Clockwise's churn complaints and shutdown and Reclaim's default daily auto-lock [19][27][30].
5. **Do not record by default. Before recording, show a pre-filled consent line the user can say or paste**, because all-party consent states and the Otter/Granola suits make notice to every participant the critical step [6][14][62].
6. **Offer an optional consent email to external attendees ahead of time, mirroring Fathom's 24-hour flow, and treat any "no" as a hard block on auto-record** [17].
7. **Stop capture automatically when the call or app audio ends, and never keep recording after the user leaves**, because the Bilzerian leak came from recording that continued after the meeting [10].
8. **Keep notes private to the owner by default and require a per-meeting send with a recipient list built from actual attendees, not invitees**, since Meet's "invited guests" includes non-attendees and the safe defaults found here are host-only [53][57][58].
9. **Never train on, upload, or reuse meeting audio or transcripts, and say so plainly in the UI**, because the Otter ruling turned partly on the vendor's own use of recordings and Granola is accused of default-on training [6][8].
10. **Anchor the summary on the user's own typed notes, as Granola does, and link every decision and action item to its transcript timestamp** so the owner can check it before approving [1][67].
11. **Show action items as suggestions with an editable owner, due date and destination (Reminders or Things), and create nothing until each item is approved**, matching Apple's own suggested-reminders pattern [41].
12. **Leave the owner blank when Psyche can't attribute an item from the user's notes or clear speaker cues, rather than guessing a name**, because SpeechAnalyzer's documentation doesn't describe speaker labels and Teams' name matching is fragile [43][49].
13. **Mark generated summaries as AI output and offer a one-tap "this is wrong" control**, following Apple's post-incident italics and warning and Granola's thumbs-down on briefs [2][46].
14. **Build prep notes on demand or as one morning digest, keep them to a few bullets (open loops, last thread, docs), and skip meetings with nothing new**, because Granola briefs are 2–3 bullets and skipped when thin, Copilot admits generic briefs, and default-on briefings get switched off [2][50][65].
15. **Turn prep on by default only for external meetings or meetings with related threads, with timing configurable (default one hour before)**, following Granola's external-only scope and Copilot for Sales' one-hour default [2][64].

---

## Sources

All accessed 2026-10-25.

1. Granola, homepage. https://www.granola.ai/
2. Granola Help Center, "Pre-meeting briefs." https://docs.granola.ai/help-center/taking-notes/pre-meeting-briefs
3. Granola Help Center, "Getting consent." https://docs.granola.ai/help-center/consent-security-privacy/getting-consent
4. Granola Help Center, "Customise notes with templates." https://docs.granola.ai/help-center/taking-notes/customise-notes-with-templates
5. Granola blog, "Meeting templates and recipes." https://www.granola.ai/blog/meeting-recipes-repeatable-formats
6. PPC Land, "Granola sued for recording meetings without consent…" (2026-08-01). https://ppc.land/granola-sued-for-recording-meetings-without-consent-to-train-ai-models/
7. Data Privacy + Security Insider, "AI meeting tools face wiretapping wake-up call" (2026-08-06). https://www.dataprivacyandsecurityinsider.com/2026/08/ai-meeting-tools-face-wiretapping-wake-up-call/
8. BuildBetter blog, "AI notetaker lawsuits 2026" (2026-10-16; vendor blog). https://blog.buildbetter.ai/ai-notetaker-lawsuits-2026-how-to-record-meetings-legally/
9. Wikipedia, "Otter.ai." https://en.wikipedia.org/wiki/Otter.ai
10. UC Today, "Otter.ai lawsuit: meeting bot recording after call" (2026-04-30). https://www.uctoday.com/security-compliance-risk/otter-ai-lawsuit-meeting-bot-recording-after-call/
11. NPR, "Class-action suit claims Otter AI secretly records private work conversations" (2025-08-15). https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit
12. University of Tennessee OIT, Otter settings article. https://utk.teamdynamix.com/TDClient/2277/OIT-Portal/KB/ArticleDet?ID=148314
13. Zoom Community, "Stopping users with Otter.ai from joining meeting." https://community.zoom.com/t5/Zoom-Meetings/Stopping-users-with-Otter-ai-from-joining-meeting/m-p/106298
14. *In re Otter.AI Privacy Litigation*, order on motion to dismiss (2026-08-13), CourtListener. https://storage.courtlistener.com/recap/gov.uscourts.cand.454675/gov.uscourts.cand.454675.68.0.pdf, and MLex coverage https://www.mlex.com/mlex/data-privacy-security/articles/2513423
15. ZoomInfo Pipeline, "Otter.ai features" (third-party). https://pipeline.zoominfo.com/sales/otter-ai-features
16. Fathom, homepage. https://www.fathom.ai/
17. Fathom Help, "Automatically requesting recording consent." https://help.fathom.video/en/articles/294272
18. HubSpot App Marketplace, "AI Notetaker by Fathom." https://ecosystem.hubspot.com/marketplace/apps/ai-notetaker-by-fathom
19. Reclaim Help, "How to use Smart Meetings." https://help.reclaim.ai/en/articles/12304545-how-to-use-smart-meetings
20. Reclaim Help, "How time defense settings work." https://help.reclaim.ai/en/articles/4129290-how-time-defense-settings-work
21. Reclaim Help, buffers (travel, decompression, breaks). https://help.reclaim.ai/en/articles/3764806
22. Reclaim Help, "Share your meeting availability with scheduling links." https://help.reclaim.ai/en/articles/12304566-share-your-meeting-availability-with-scheduling-links
23. TechCrunch, "Dropbox has acquired AI-powered scheduling startup Reclaim" (2024-08-22). https://techcrunch.com/2024/08/22/dropbox-acquires-index-ventures-backed-ai-scheduling-tool-reclaim-ai/
24. Motion Help, "Concept: Auto-scheduling." https://www.usemotion.com/help/time-management/auto-scheduling/concept-auto-scheduling
25. Motion Help, "Concept: Booking Links." https://www.usemotion.com/help/time-management/booking-links/concept-booking-links
26. Saner.ai, "Motion reviews" (competitor roundup). https://www.saner.ai/blogs/motion-reviews
27. The Register, Salesforce hires Clockwise team (2026-03-20). https://theregister.com/2026/03/20/salesforce_clockwise_team
28. TechRadar, "Salesforce recruits team behind calendar app Clockwise into Agentforce." https://www.techradar.com/pro/salesforce-recuits-team-behind-calendar-app-clockwise-into-agentforce
29. Google Workspace Marketplace, Clockwise listing. https://workspace.google.com/marketplace/app/clockwise/813252810479
30. G2, Clockwise review. https://www.g2.com/products/clockwise-clockwise/reviews/clockwise-review-9749993
31. Flexibits, "Openings" help. https://flexibits.com/fantastical/help/openings
32. Flexibits, "Proposals" help. https://flexibits.com/fantastical/help/proposals
33. Apple App Store, Fantastical listing. https://apps.apple.com/app/fantastical/id975937182
34. Calendly Help, "Scheduling FAQ" (time zones, buffers). https://calendly.com/help/scheduling-faq
35. Calendly Help, "Routing." https://calendly.com/help/calendly-routing
36. Calendly Help, "Meeting polls overview." https://calendly.com/help/meeting-polls-overview
37. Calendly blog, "Public opinion on scheduling etiquette is shifting" (vendor). https://calendly.com/blog/scheduling-etiquette
38. Westpac, "Are you guilty of calendar 'power play'?" (2022-02-24). https://www.westpac.com.au/news/in-depth/2022/02/are-you-guilty-of-calendar-power-play/
39. Apple Support, "How to record and transcribe a call on iPhone." https://support.apple.com/121583
40. Apple Support, Mac User Guide, "Use Apple Intelligence in Notes on Mac." https://support.apple.com/guide/mac-help/mchl2102c2ae/mac
41. Apple Support, "Use Apple Intelligence to suggest reminders from any app in iOS 26." https://support.apple.com/124025
42. Apple, "Apple Intelligence & Privacy." https://www.apple.com/legal/privacy/data/en/intelligence-engine/
43. Apple Developer, WWDC25 session 277, "Bring advanced speech-to-text to your app with SpeechAnalyzer." https://developer.apple.com/videos/play/wwdc2025/277/
44. Argmax, "Apple and Argmax" (competitor benchmark). https://www.argmaxinc.com/blog/apple-and-argmax
45. Michael Tsai, "Beta for Apple Intelligence in Apple Mail" (2024-08-05). https://mjtsai.com/blog/2024/08/05/beta-for-apple-intelligence-in-apple-mail
46. The Decoder, "Apple pauses AI-generated news summaries…" (January 2025). https://the-decoder.com/apple-pauses-ai-generated-news-summaries-after-serious-accuracy-issues-surface/
47. NBC / CNBC, "Apple delays Siri AI improvements to 2026" (2025). https://www.nbcnewyork.com/news/business/money-report/apple-delays-siri-ai-improvements-to-2026/6177731/
48. TechCabal, "Everything Apple announced at WWDC 2026" (2026-06-08). https://techcabal.com/2026/06/08/wwdc-2026-announcements/
49. Microsoft Support, "Recap in Microsoft Teams." https://support.microsoft.com/en-us/teams/meetings/recap-in-microsoft-teams
50. Microsoft Support, "Prepare for your meeting with Copilot." https://support.microsoft.com/en-us/topic/prepare-for-your-meeting-with-copilot-f23326fc-7721-45f1-875e-23e77aaf3d89
51. Microsoft Learn, "Participant agreement for recording and transcription." https://learn.microsoft.com/en-us/microsoftteams/participant-agreement-recording-transcription
52. Collab365, "Choose where Teams meeting actions should live" (secondary). https://spaces.collab365.com/posts/choose-where-teams-meeting-actions-should-live-ALH4Di
53. Google Meet Help, "Take notes for me in Google Meet." https://support.google.com/meet/answer/14754724?hl=en
54. Google Workspace Updates, "Take notes for me… next steps" (2025-02-18). https://workspaceupdates.googleblog.com/2025/02/google-meet-take-notes-for-me-next-steps.html
55. Google Keyword blog, "Help me schedule in Gmail" (2025-10-14). https://blog.google/products/workspace/help-me-schedule-gmail-gemini/, and Droid Life (2025-10-14) https://www.droid-life.com/2025/10/14/gmail-gets-help-me-schedule-feature-for-email-responses/
56. Zoom News, "AI Companion 3.0 and Zoom Workplace" (Sept 2025). https://news.zoom.com/ai-companion-3-0-and-zoom-workplace/
57. College of Western Idaho IT, "Zoom AI Companion: Meeting Summary and Attendee Consent." https://support.cwi.edu/TDClient/30/Portal/KB/ArticleDet?ID=358
58. University of Colorado, "Creating Zoom meeting summaries with AI Companion." https://www.cu.edu/blog/tech-tips/creating-zoom-meeting-summaries-ai-companion
59. Zoom Community, "Participant permission to have a meeting use AI Companion" (2024). https://community.zoom.com/t5/Zoom-AI-Companion/Participant-Permission-to-have-a-meeting-use-AI-Companion/m-p/210668
60. Bloomberg, "Please Stop Inviting AI Notetakers to Meetings" (2025-02-14). https://www.bloomberg.com/news/articles/2025-02-14/ai-notetakers-in-meetings-are-making-me-queasy
61. Fast Company / AP, "AI notetakers… privacy" (2026). https://www.fastcompany.com/91571498/ai-notetaker-work-meetings-privacy-data
62. Kilpatrick Townsend, "Wiretap Laws in the United States" (2024-07). https://ktslaw.com/en/Blog/GlobalPrivacy-and-CybersecurityLaw/2024/7/Wiretap-Laws-in-the-United-States
63. Reporters Committee for Freedom of the Press, "Reporter's Recording Guide." https://www.rcfp.org/introduction-to-reporters-recording-guide/
64. Microsoft Learn, "Configure recordings and notifications for sales meetings" (updated 2026-05-13). https://learn.microsoft.com/en-us/microsoft-sales-copilot/configure-meeting-agent
65. CUHK ITSC (web archive), Cortana daily briefing email disabled after feedback (2021). https://webarchive.lib.cuhk.edu.hk/20210329113658oe_/https://www.itsc.cuhk.edu.hk/sc/?p=18827
66. Fireflies Guide, "Meeting Prep: Get briefed before every meeting." https://guide.fireflies.ai/articles/3878280311-meeting-prep-get-briefed-before-every-meeting
67. GoTranscript, "AI meeting summary QA checklist" (vendor). https://gotranscript.com/en/blog/ai-meeting-summary-qa-checklist
68. Microsoft Support, "Use Copilot in Microsoft Teams meetings." https://support.microsoft.com/en-us/office/use-copilot-in-microsoft-teams-meetings-0bf9dd3c-96f7-44e2-8bb8-790bedf066b1
69. Zack Proser, "Granola vs Otter.ai: I tested both for months" (independent blog). https://zackproser.com/blog/granola-vs-otter
