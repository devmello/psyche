# Research: personal CRMs, notes patterns and assistants that model people and projects

Background research for the Psyche people and project memory graph. The goal is to answer "who is Sam", "what am I waiting on from Sam", "prep me for my 2 pm" and "what's going on with the kitchen remodel", locally, from the owner's Contacts, Mail, Calendar, Messages and notes.

All pages were accessed on 2026-10-25 unless noted. Where a page shows its own date, it is given in parentheses. Claims that come from vendor marketing or from a competitor's review are marked as such.

## 1. Personal CRMs

### Mesh (formerly Clay, clay.earth)

- Ownership: Automattic acquired Clay in June 2025 and renamed it Mesh. The source is a competitor's review (Dex, 2026-04-06), so read it with that in mind. [source](https://getdex.com/blog/mesh-review/)
- Entities and sources: a contact record built automatically from email, meetings and social connections. Named integrations are Facebook, LinkedIn, Instagram, Notion, WhatsApp and X (vendor homepage). [source](https://me.sh/)
- Mail access: Mesh asks for "email headers only", meaning recipients and subject line, never the body. It uses connected mail only to create contacts. (Security and Privacy page, last updated 2026-06-26.) [source](https://library.me.sh/knowledge-base/security-and-privacy/)
- iMessage: needs Full Disk Access on macOS. Mesh says it "never reads or imports the text of messages" and keeps only aggregate counts of messages sent and received. [source](https://library.me.sh/knowledge-base/security-and-privacy/)
- Enrichment: job titles, companies, locations, photos and social profiles come from email signatures, LinkedIn and public profiles, and job changes are surfaced. Contacts with little public data get thin records (Dex review). [source](https://getdex.com/blog/mesh-review/)
- Keep in touch: it tracks how often you interact with each person, flags people who are "going cold", and supports soft cadences such as "check in quarterly" (Dex review). The homepage promises "intelligent prompts when it's time to reconnect". [source](https://getdex.com/blog/mesh-review/) [source](https://me.sh/)
- Dedup: none documented. An App Store reviewer quoted in the Dex review complains of "zero features for automated duplicate resolution". [source](https://getdex.com/blog/mesh-review/)
- AI ("Nexus"): natural-language questions about your network, such as "Who do I know at Stripe?". The Dex review calls it inconsistent. Mesh's AI features are opt-in, run on Mesh servers plus third parties, and Mesh says no data is used for training. [source](https://getdex.com/blog/mesh-review/) [source](https://library.me.sh/knowledge-base/security-and-privacy/)
- Deletion: done in-app or by email. Deleted data can stay in encrypted backups for up to 90 days. [source](https://library.me.sh/knowledge-base/security-and-privacy/)

### Dex (getdex.com)

- Entities: contacts, groups and tags, custom fields, and timeline items (meetings, calls, emails, messages, notes). [source](https://getdex.com/product-overview.md)
- Sources: LinkedIn, Gmail, Google Calendar, WhatsApp, iMessage, Facebook, Instagram, Outlook, phone contacts and CSV. Dex says it will "merge duplicates intelligently" after import (vendor page). [source](https://getdex.com/product-overview.md)
- LinkedIn sync: adds and refreshes connections every 3–5 days, alerts you to title changes, and updates "Last Interaction" from LinkedIn messages. [source](https://getdex.com/docs/integrationsandfeatures/syncfeatures/sync-linkedin)
- Mail access: the Gmail sync is "metadata only" and shows the subject and date/time of each email. [source](https://guidev3.getdex.com/workflows/stay-informed)
- Keep in touch: a per-contact cadence (weekly, monthly or quarterly) plus nudges when one is due. Dex also emails pre-meeting briefs before calendar events. [source](https://getdex.com/product-overview.md)
- Timeline: "every meeting, call, email, message, and note for a contact on one timeline". Notes are classified by type automatically. [source](https://getdex.com/product-overview.md)
- Privacy: TLS in transit, AES-256 at rest, US hosting. [source](https://getdex.com/security/)
- Complaints: a user review reports that Dex "couldn't find duplicates very easily, and then merging often failed" (anecdotal). [source](https://justuseapp.com/en/app/1472132715/dex-rolodex-and-personal-crm/reviews)

### Monica (open source, monicahq.com)

- Licence and hosting: AGPL-3.0 and self-hostable. "It's your data, your server." There are no ads and no tracking. [source](https://github.com/monicahq/monica)
- Data model in the README: contacts, relationships between contacts, reminders (including automatic birthday reminders), activities, tasks, notes, how you met, addresses, pets, labels, documents and photos, a journal, and multiple vaults and users. [source](https://github.com/monicahq/monica)
- Marketing site: records hold life updates, how you know the person, important dates, past conversations, and "gifts, debts, promises, and ideas". Relationships cover family, partners, friendships and coworkers. [source](https://www.monicahq.com/)
- "Last talked": the 4.x `Contact` model has `last_talked_to`, `stay_in_touch_frequency` and `stay_in_touch_trigger_date` fields. [source](https://raw.githubusercontent.com/monicahq/monica/4.x/app/Models/Contact/Contact.php) Logging a call sets `last_talked_to` to the latest `called_at`, so it reflects only what the user logs. [source](https://raw.githubusercontent.com/monicahq/monica/4.x/app/Services/Contact/Call/CreateCall.php)
- Stay in touch (2018-05-03): an email reminder at a fixed interval that is "not affected by the last time you've interacted with someone". [source](https://www.monicahq.com/en/blog/stay-in-touch/)
- Partial contacts: the model has an `is_partial` flag; partial contacts resolve to a related "real" contact (`getRelatedRealContact`). [source](https://raw.githubusercontent.com/monicahq/monica/4.x/app/Models/Contact/Contact.php)
- No sync: every interaction is entered by hand. There is no email, calendar or LinkedIn sync (third-party review by Dex, 2026-04-06). [source](https://getdex.com/blog/monica-review/)
- v3 (announced for before the end of 2026): rebuilt from scratch, with configurable sections per record, links from people to companies, homes, vehicles and projects, and "a complete API and MCP server". Monica says data is never used to train a model and is never sent to one "on its own initiative". [source](https://www.monicahq.com/)

### folk (folk.app)

- Duplicate rules (help centre, 2026-06-02):
  - Auto-merge on import (Gmail, file, Zapier, extension) when first and last name match and email, phone or a social URL also matches.
  - Weaker matches go to a "Duplicates" view that explains why each group was flagged. You can merge one group, "merge all", or choose "Don't merge".
  - In a manual merge, the user picks which emails and phones to keep and stars the primary one.
  [source](https://help.folk.app/en/articles/5007403-manage-duplicates)
- Enrichment: infers a contact's company from the email domain and integrates Dropcontact (folk education site, as quoted in search results; the page could not be fetched). [source](https://education.folk.app/6-use-data-intelligence)
- Sources: auto-sync from Gmail or Outlook (marketing page). [source](https://www.folk.app/products/pipelines-management)

### Covve and others (brief)

- Covve: scans the web for news about your contacts' careers. Notes and contacts are end-to-end encrypted on the device, and the vendor says "even we can't unlock your data" (App Store listing). [source](https://apps.apple.com/us/app/-/id958935377)

## 2. Notes-based approaches

### Obsidian

- Backlinks: "Linked mentions" are notes that link to the current note. "Unlinked mentions" are plain-text occurrences of its name. [source](https://obsidian.md/help/plugins/backlinks)
- Dataview: indexes YAML frontmatter and inline `key:: value` fields, plus `file.inlinks` (incoming links), and queries them with `TABLE`/`LIST ... WHERE`. Paragraph text is not indexed. [source](https://blacksmithgu.github.io/obsidian-dataview/)
- Typical people note (from the obsidian-crm plugin):
  - Frontmatter: `name`, `company`, `email`, `phone`, `tags`, `created`, `last_contact`.
  - Body sections: "About" and "Contact History".
  - Interaction notes carry `person: "[[John Smith]]"`, and the plugin updates `last_contact` when you add one.
  [source](https://github.com/TalkingQuickly/obsidian-crm)
- Other contact plugins store `birthday`, `last_contact` and `friends` in frontmatter and sort by "longest since last contact". [source](https://github.com/jwir3/obsidian-contacts-ng)
- Daily-note pattern: a person note shows a Dataview query of journal entries that link to it, which works as an interaction log. [source](https://obsidian.rocks/supercharge-your-daily-notes-in-obsidian/)

### Notion

- Relations link pages across databases, for example People ↔ Projects ↔ Meetings, and can be two-way. [source](https://www.notion.com/help/relations-and-rollups)
- Rollups compute over related pages. "Latest date" over a person's related meetings gives a last-contact column. [source](https://www.notion.com/help/relations-and-rollups)

### Roam / Logseq

- In Logseq, an `alias::` page property makes another name a permanent link target, and it must sit in the page's first block. Unlinked references are plain text matches, so an alias like "BI" also matches "bi-weekly" (community forum, not official docs). [source](https://discuss.logseq.com/t/how-to-create-aliases-and-external-links-in-logseq/8435/3) [source](https://discuss.logseq.com/t/filter-or-exclude-from-unlinked-references/15566)

### What a "people note" usually contains

Across these sources, a people note usually has:

- identity: name, aliases, company or role, contact handles
- how you know them, and relationship tags
- important dates: birthday, when you first met
- a free-form "About" section
- a contact-history or interaction log, usually built from backlinks rather than typed in
- a `last_contact` date that the user maintains by hand or that a plugin derives

Sources: [obsidian-crm](https://github.com/TalkingQuickly/obsidian-crm), [contacts-ng](https://github.com/jwir3/obsidian-contacts-ng), [Monica](https://www.monicahq.com/).

## 3. Platform assistants

### Apple

- Contacts suggestions: Siri suggests new contacts from email received in Mail and from Calendar invitations. Users can turn this off with "Show Contact Suggestions". [source](https://support.apple.com/guide/iphone/add-and-use-contact-information-iph3e0ca2db/ios)
- Mail autocomplete: shows a lower section labelled "Siri Found in Apps" with addresses taken from other apps. Spam addresses can appear there and are hard to remove (Macworld). [source](https://www.macworld.com/article/231029/siri-stop-suggesting-spammers-email.html)
- Linked cards: Contacts on Mac shows cards for the same person from different accounts as one card. Each account keeps its own card, and a linked card can be unlinked. [source](https://support.apple.com/guide/contacts/link-contacts-from-different-accounts-adrb33f38d93/mac)
- Mail Follow Up Suggestions: a sent message with no reply after three days moves back to the top of the inbox. Swipe to dismiss. The setting can be turned off. [source](https://support.apple.com/guide/mail/mark-emails-to-revisit-later-mlhlp1052/mac)
- Journaling Suggestions: groups moments on the device. The contacts option counts nearby mutual contacts over Bluetooth "without storing which of these specific contacts were around". [source](https://apple.com/legal/privacy/data/en/journaling-suggestions)
- Apple Intelligence (2024): "A cornerstone… is on-device processing". People examples include "When is Mom's flight landing?" and "Play that podcast that Jamie recommended". [source](https://www.apple.com/newsroom/2024/06/introducing-apple-intelligence-for-iphone-ipad-and-mac/)
- Semantic index: secondary coverage describes an on-device index that retrieval-augmented generation draws on. [source](https://www.wing.vc/content/unpacking-apple-intelligence-apples-vision-for-personalized-ai)
- Siri AI, announced 2026-06:
  - The system orchestrator uses the "Spotlight index and App Toolbox, which work entirely on device".
  - Personal context reaches third-party apps that integrate with Spotlight.
  - Private Cloud Compute requests are "not stored nor made accessible to Apple".
  [source](https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant/)
- Siri AI, shipped 2026-09 as a beta:
  - Uses personal context across messages, emails and photos.
  - Can "reflect how users usually communicate with each recipient".
  - Siri Recap summarises conversations.
  [source](https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/)

### Google

- Automatic "Other contacts": Google saves contact info for:
  - Gmail recipients you write to
  - people you share Drive files with
  - people in the same events or groups as you
  - senders of calendar invitations you accept
  
  This can be turned off in the Google Account. [source](https://support.google.com/accounts/answer/7345608?hl=en&co=GENIE.Platform%3DDesktop)
- People API: exposes `otherContacts` and `copyOtherContactToMyContactsGroup`, so the API keeps contacts inferred from interactions separate from contacts the user saved. [source](https://developers.google.com/people/api/rest/v1/otherContacts)
- Merge & fix: suggested duplicate merges that you accept one at a time or all at once. Contacts in different Google Accounts cannot be merged. [source](https://support.google.com/contacts/answer/7078226?hl=en&co=GENIE.Platform%3DDesktop)
- Gmail Nudges: "Suggest emails to reply to" and "Suggest emails to follow up on". Requires conversation view. [source](https://support.google.com/mail/answer/6585?hl=en&co=GENIE.Platform%3DDesktop)
- Gemini Personal Intelligence (2026-01-14):
  - Opt-in links to Gmail, Photos, YouTube and Search. Connections are "off by default".
  - Gemini tries to cite the sources it used.
  - Users can regenerate an answer without personalisation, or use temporary chats.
  - Google names its failure modes: "over-personalization", and struggles with "relationship changes, like divorce". Its example is a user with hundreds of golf photos who doesn't like golf (they are for the user's son).
  [source](https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/)

### Microsoft

- Viva Topics: retired 2025-02-22. AI-generated topic pages "will no longer be available", and Microsoft moved its knowledge work into Copilot. [source](https://learn.microsoft.com/en-us/microsoft-365/topics/changes-coming-to-topics?view=o365-worldwide) [source](https://learn.microsoft.com/en-us/microsoft-365/topics/topics-changes-faq?view=o365-worldwide)
- Graph People API (updated 2025-08):
  - Ranks people by "communication and collaboration patterns and business relationships". Sources are contacts, the directory and recent communications.
  - Search is fuzzy: "tiler" matches Tyler.
  - Each address has a `relevanceScore`.
  - Other people see your "working-with" list only where a public relationship exists.
  [source](https://learn.microsoft.com/en-us/graph/people-insights-overview)
  - Microsoft's own Q&A says the docs don't explain how the score is computed. [source](https://learn.microsoft.com/en-us/answers/questions/1685296/graph-api-people-relevance-score)
- Viva Insights: the Briefing email listed:
  - commitments you made
  - requests others made of you
  - follow-ups you were waiting on

  Microsoft says it shows "to whom you have made commitments and requests" by applying "basic calculations and rules" to the data. The data is "stored and computed in your Exchange Online mailbox" and is visible only to the user. [source](https://support.microsoft.com/en-us/viva/insights/privacy-guide-for-personal-insights)
  - The Briefing was later paused. Third-party guides describe the Outlook add-in's "outstanding tasks" and "follow up on your requests" cards, which prompt you when a sent task or question gets no response. [source](https://m365scripts.com/news/microsoft-viva-puts-pause-on-daily-briefing-emails-in-microsoft-365/) [source](https://hsc.unm.edu/about/cio/_tips/insights-plugin.pdf)
- Copilot "Prepare for this meeting":
  - Summarises "relevant context, tasks, documents, and other resources" for the event.
  - Summaries are offered only for 1:1 meetings and meetings with related content. Others get generic answers.
  - Each person's summary depends on what that person can access.
  [source](https://support.microsoft.com/en-us/outlook/prepare-for-your-meeting-with-copilot)

## 4. AI memory products

- **Rewind / Limitless:**
  - Rewind kept video, audio and transcripts on the Mac and processed them locally. [source](https://intercom.help/rewind-ai/en/articles/6526620)
  - Meta acquired Limitless on 2025-12-05. The Rewind desktop app was wound down, and users got export and in-app deletion. [source](https://techcrunch.com/2025/12/05/meta-acquires-ai-device-startup-limitless/)
  - Some users said they did not trust the new owner with their data. [source](https://www.producthunt.com/p/rewind-2/meta-has-acquired-limitless)
- **Mem.ai (Mem 2.0):**
  - Deep Search returns keyword matches first and AI matches after.
  - Chat is time-aware and can be scoped to one note or collection.
  - "Heads Up" shows your history with a person.
  
  This is all vendor copy. [source](https://get.mem.ai/blog/mem-2-dot-0-transition-guide)
- **Khoj:** open source and self-hostable, with local or cloud LLMs. It does semantic search over PDF, Markdown, org-mode, Word and Notion files, and has agents and automations. It does no people extraction. [source](https://github.com/khoj-ai/khoj)
- **Personal.ai:** a "Memory Stack" of memory blocks, each with time, source, scope and text, that the user can "add, delete, or edit". [source](https://docs.personal.ai/documentation/training/memory-stack)
- **Granola:**
  - "People and Companies" is built from calendar attendees when you take notes. It is enriched with photos, titles and company info, and opens to all notes that include the person.
  - Users cannot add entries by hand. Wrong names have to be reported to support.
  - A person is missing if they weren't an attendee or declined.
  [source](https://docs.granola.ai/help-center/people-and-companies)
  - Pre-meeting briefs are 2–3 bullets prepared overnight from prior notes with the same people or company, the web (including LinkedIn), the event and optionally Gmail. They cover external meetings only and are skipped when there isn't enough information. [source](https://docs.granola.ai/help-center/taking-notes/pre-meeting-briefs)
- **Otter:** "My Action Items" collects tasks assigned to you across meetings. Each item links back to the moment in the transcript where it came up, and a weekly digest lists open items. [source](https://otter.ai/blog/streamline-workflows-with-my-action-items-otter-ai-can-now-keep-track-of-all-your-action-items-across-all-your-meetings)
- **ChatGPT memory:**
  - "Saved memories" (explicit) are separate from "reference chat history" (inferred).
  - Deleting a chat does not delete a memory created from it.
  - Users can ask it to forget something or manage memories in settings.
  [source](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)
- **Claude memory:**
  - Saved as individual topics that can be read, edited and deleted. It covers "the people and places in your work".
  - Each project has its own memory. Incognito chats are never saved.
  - Sensitive topics are excluded by default, and some kinds of data, such as government IDs, are never saved.
  [source](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- **User research:**
  - In a CHI '26 interview study (N=20), most participants reacted negatively when they learned what ChatGPT remembered, and they wanted visibility and control. [source](https://grady.uga.edu/research/ai-never-forgets-exploring-users-perceptions-of-ai-memory-and-chatgpts-memory-feature/)
  - In another study (N=18), users raised concerns about the accuracy of remembered information and wanted "granular control over memory generation, management, usage and updating". [source](https://arxiv.org/abs/2508.07664)
  - Background on personal knowledge graphs: [Balog & Kenter 2019](https://research.google/pubs/personal-knowledge-graphs-a-research-agenda/).

## 5. Synthesis

### What each question needs

| Question | Data | Freshness | Ranking and behaviour |
|---|---|---|---|
| "Who is Sam" | Contacts card(s), aliases and nicknames, handles seen in Mail and Messages, org and title, relationship label, notes, first met, last contact | Contacts on change; interaction stats daily is fine | Several Sams: rank by recency × frequency of two-way contact, as Graph People relevance does. Ask when the top two are close. Show provenance |
| "What am I waiting on from Sam" | Sent mail and messages containing a request or question with no reply; Sam's commitments in meeting notes and threads | Must reflect replies within minutes, or the answer is wrong | Open loops, oldest first. Close a loop automatically when Sam replies. Let the user dismiss. Pattern: Gmail Nudges, Apple Mail's 3-day rule, Viva follow-ups, Otter action items |
| "Prep me for my 2 pm" | Event, attendees resolved to people, last interactions, open loops both ways, previous meeting notes, related project and docs | Built shortly before the meeting | Copilot and Granola limit full briefs to meetings that have related content, and skip or give short output otherwise. Few bullets, with sources |
| "Kitchen remodel" | Project entity with aliases (contractor names, "reno", address), linked threads, events, notes and people; status timeline | Incremental | Latest activity first, plus open loops and next dated event. Notion's "latest date" rollup is the simple version |
| Cards / mail triage | Person relevance, VIP or relationship label, open loops with the sender | Live | Relevance from interaction patterns, not from enrichment |

### Recurring design patterns

- **Linking, not destructive merge:** Apple keeps each source card under a linked card. Google keeps interaction-derived "Other contacts" apart from saved ones. folk merges automatically only on name plus a strong identifier and queues everything else for review. [Apple](https://support.apple.com/guide/contacts/link-contacts-from-different-accounts-adrb33f38d93/mac) [Google](https://developers.google.com/people/api/rest/v1/otherContacts) [folk](https://help.folk.app/en/articles/5007403-manage-duplicates)
- **Recency is derived, not typed:** Monica's hand-logged `last_talked_to` and fixed-interval reminders are the weak case. Dex and Mesh compute last interaction from synced metadata. [Monica](https://www.monicahq.com/en/blog/stay-in-touch/) [Dex](https://getdex.com/docs/integrationsandfeatures/syncfeatures/sync-linkedin)
- **Metadata is enough for most CRM signals:** Mesh reads headers only and keeps only message counts for iMessage. Dex shows subject and date. [Mesh](https://library.me.sh/knowledge-base/security-and-privacy/) [Dex](https://guidev3.getdex.com/workflows/stay-informed)
- **Open-loop detection is a heuristic plus a dismiss button:** Apple uses no reply in 3 days. Gmail Nudges and Viva add language cues. [Apple](https://support.apple.com/guide/mail/mark-emails-to-revisit-later-mlhlp1052/mac) [Gmail](https://support.google.com/mail/answer/6585?hl=en&co=GENIE.Platform%3DDesktop)
- **Relationship labels** are small enums (family, partner, friend, coworker) plus free-form notes. [Monica](https://www.monicahq.com/)
- **Answers cite their sources:** Gemini tries to cite what it used, and Otter action items link back to the transcript. [Gemini](https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/) [Otter](https://otter.ai/blog/streamline-workflows-with-my-action-items-otter-ai-can-now-keep-track-of-all-your-action-items-across-all-your-meetings)

### What users dislike

- **Creepy or wrong inferences:** Google itself names over-personalisation and misreading relationship changes such as divorce. [source](https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/) Users react badly when they discover what an assistant remembered. [source](https://grady.uga.edu/research/ai-never-forgets-exploring-users-perceptions-of-ai-memory-and-chatgpts-memory-feature/)
- **Junk entities:** spam senders show up as suggestions and are hard to remove. [source](https://www.macworld.com/article/231029/siri-stop-suggesting-spammers-email.html)
- **Bad dedup:** dedup that fails or is missing comes up in complaints about Dex and Mesh. [Dex review](https://justuseapp.com/en/app/1472132715/dex-rolodex-and-personal-crm/reviews) [Mesh review](https://getdex.com/blog/mesh-review/)
- **No way to fix entities:** Granola users cannot edit People entries and have to email support. [source](https://docs.granola.ai/help-center/people-and-companies)
- **Stale data and manual upkeep:** Monica requires every interaction to be logged by hand. [source](https://getdex.com/blog/monica-review/)
- **Cloud custody risk:** Rewind users had their data handed to a new owner (Meta). [source](https://www.producthunt.com/p/rewind-2/meta-has-acquired-limitless)

## Takeaways for Psyche

1. **Person = cluster of identifiers, not a row.** Model a person as a stable ID with linked handles (Contacts card IDs, emails, phone numbers, iMessage handles), the way Apple links cards. Never rewrite the source Contacts. Unmerging must be one action.
2. **Auto-merge only on strong evidence.** Merge automatically only when a shared email or phone number is backed by a name match, as folk does. Send fuzzy name matches to a review queue that says why the pair was flagged. Keep people seen only in Mail apart from saved Contacts, as Google's "Other contacts" does.
3. **Aliases are first-class and user-editable.** "Sam", "Samantha", "Sam (contractor)", a project's "reno"/"kitchen". When resolving "Sam", rank by recency × frequency of two-way contact. Ask the user when the top candidates are close.
4. **Derive last contact automatically, both ways.** Compute last contact and contact frequency from Mail, Messages and Calendar metadata. Never rely on manual logs (Monica's weakness). Store the counts and timestamps, not message bodies, in the graph.
5. **Open loops are the core feature.** Waiting-on items come from sent messages that ask something and get no reply. Commitments come from what the owner promised. Close loops automatically when a reply arrives, keep an explicit dismiss, and link every loop to its source message. Answering "What am I waiting on from Sam" depends on mail and message state being fresh within minutes.
6. **Meeting prep is a join, not a new store.** Event → attendees → people → last interactions, open loops and prior notes → related project. When there is little context, produce a short brief or skip it, as Copilot and Granola do. Prepare briefs ahead of time.
7. **Projects need the same machinery as people.** A project needs aliases, linked threads, events, notes and people, a "latest activity" date and open loops. Let the owner create and rename projects and confirm suggested links. Don't let projects silently pile up from clustering.
8. **Every fact shows its source and is correctable.** Every card field and answer cites its source (message, event, note) and offers edit, "that's wrong" and forget, unlike Granola. Deleting a source should remove facts derived from it. ChatGPT's "deleting a chat keeps the memory" behaviour is the failure to avoid.
9. **No sensitive inferences by default.** Don't infer health, religion, politics or relationship status. Don't relabel a relationship (such as "ex") without the user. Claude and Gemini both exclude sensitive topics by default.
10. **Don't enrich from the web by default.** Skip LinkedIn and web lookups by default. They break the local-only promise and are where most "creepy" reactions start. Make enrichment opt-in per person.
11. **Filter junk at ingestion.** Ignore no-reply senders, mailing lists and bulk mail, and people who have only ever emailed the owner, so spam never becomes a person (the "Siri Found in Apps" failure).
12. **Keep all of it local and exportable.** Psyche's advantage over Mesh, Dex and Limitless is that nothing leaves the Mac. Write the graph down so it can be exported and inspected, for example as people and project Markdown notes in Obsidian style.

## Sources

- Mesh security and privacy: https://library.me.sh/knowledge-base/security-and-privacy/ (updated 2026-06-26)
- Mesh homepage: https://me.sh/
- Dex review of Mesh: https://getdex.com/blog/mesh-review/ (2026-04-06)
- Dex review of Monica: https://getdex.com/blog/monica-review/ (2026-04-06)
- Dex product overview: https://getdex.com/product-overview.md
- Dex LinkedIn sync: https://getdex.com/docs/integrationsandfeatures/syncfeatures/sync-linkedin
- Dex Gmail sync: https://guidev3.getdex.com/workflows/stay-informed
- Dex security: https://getdex.com/security/
- Dex app reviews: https://justuseapp.com/en/app/1472132715/dex-rolodex-and-personal-crm/reviews
- Monica README: https://github.com/monicahq/monica
- Monica site: https://www.monicahq.com/
- Monica stay-in-touch post: https://www.monicahq.com/en/blog/stay-in-touch/ (2018-05-03)
- Monica Contact model (4.x): https://raw.githubusercontent.com/monicahq/monica/4.x/app/Models/Contact/Contact.php
- Monica CreateCall service (4.x): https://raw.githubusercontent.com/monicahq/monica/4.x/app/Services/Contact/Call/CreateCall.php
- folk duplicates: https://help.folk.app/en/articles/5007403-manage-duplicates (2026-06-02)
- folk data intelligence: https://education.folk.app/6-use-data-intelligence
- folk pipelines: https://www.folk.app/products/pipelines-management
- Covve App Store: https://apps.apple.com/us/app/-/id958935377
- Obsidian backlinks: https://obsidian.md/help/plugins/backlinks
- Dataview: https://blacksmithgu.github.io/obsidian-dataview/
- obsidian-crm: https://github.com/TalkingQuickly/obsidian-crm
- obsidian-contacts-ng: https://github.com/jwir3/obsidian-contacts-ng
- Obsidian daily notes pattern: https://obsidian.rocks/supercharge-your-daily-notes-in-obsidian/
- Notion relations and rollups: https://www.notion.com/help/relations-and-rollups
- Logseq aliases: https://discuss.logseq.com/t/how-to-create-aliases-and-external-links-in-logseq/8435/3
- Logseq unlinked references: https://discuss.logseq.com/t/filter-or-exclude-from-unlinked-references/15566
- Apple contact suggestions: https://support.apple.com/guide/iphone/add-and-use-contact-information-iph3e0ca2db/ios
- Apple linked contacts: https://support.apple.com/guide/contacts/link-contacts-from-different-accounts-adrb33f38d93/mac
- Apple Mail Follow Up: https://support.apple.com/guide/mail/mark-emails-to-revisit-later-mlhlp1052/mac
- Macworld on Siri Found in Apps: https://www.macworld.com/article/231029/siri-stop-suggesting-spammers-email.html
- Journaling Suggestions privacy: https://apple.com/legal/privacy/data/en/journaling-suggestions
- Apple Intelligence (2024-06): https://www.apple.com/newsroom/2024/06/introducing-apple-intelligence-for-iphone-ipad-and-mac/
- Siri AI announcement (2026-06): https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant/
- Siri AI release (2026-09): https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/
- Wing VC on the semantic index: https://www.wing.vc/content/unpacking-apple-intelligence-apples-vision-for-personalized-ai
- Google saved contacts: https://support.google.com/accounts/answer/7345608?hl=en&co=GENIE.Platform%3DDesktop
- People API otherContacts: https://developers.google.com/people/api/rest/v1/otherContacts
- Google merge duplicates: https://support.google.com/contacts/answer/7078226?hl=en&co=GENIE.Platform%3DDesktop
- Gmail Nudges: https://support.google.com/mail/answer/6585?hl=en&co=GENIE.Platform%3DDesktop
- Gemini Personal Intelligence: https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/ (2026-01-14)
- Viva Topics changes: https://learn.microsoft.com/en-us/microsoft-365/topics/changes-coming-to-topics?view=o365-worldwide
- Viva Topics FAQ: https://learn.microsoft.com/en-us/microsoft-365/topics/topics-changes-faq?view=o365-worldwide
- Graph People API: https://learn.microsoft.com/en-us/graph/people-insights-overview (updated 2025-08-06)
- Graph relevance Q&A: https://learn.microsoft.com/en-us/answers/questions/1685296/graph-api-people-relevance-score
- Viva Insights privacy: https://support.microsoft.com/en-us/viva/insights/privacy-guide-for-personal-insights
- Briefing email pause: https://m365scripts.com/news/microsoft-viva-puts-pause-on-daily-briefing-emails-in-microsoft-365/
- Insights Outlook add-in guide (UNM): https://hsc.unm.edu/about/cio/_tips/insights-plugin.pdf
- Copilot meeting prep: https://support.microsoft.com/en-us/outlook/prepare-for-your-meeting-with-copilot
- Rewind local storage: https://intercom.help/rewind-ai/en/articles/6526620
- TechCrunch on Meta and Limitless: https://techcrunch.com/2025/12/05/meta-acquires-ai-device-startup-limitless/ (2025-12-05)
- Product Hunt reactions: https://www.producthunt.com/p/rewind-2/meta-has-acquired-limitless
- Mem 2.0 guide: https://get.mem.ai/blog/mem-2-dot-0-transition-guide
- Khoj: https://github.com/khoj-ai/khoj
- Personal.ai Memory Stack: https://docs.personal.ai/documentation/training/memory-stack
- Granola People and Companies: https://docs.granola.ai/help-center/people-and-companies
- Granola briefs: https://docs.granola.ai/help-center/taking-notes/pre-meeting-briefs
- Otter My Action Items: https://otter.ai/blog/streamline-workflows-with-my-action-items-otter-ai-can-now-keep-track-of-all-your-action-items-across-all-your-meetings
- ChatGPT memory: https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- Claude memory: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- Chen et al., CHI '26: https://grady.uga.edu/research/ai-never-forgets-exploring-users-perceptions-of-ai-memory-and-chatgpts-memory-feature/
- Zhang et al. 2025: https://arxiv.org/abs/2508.07664
- Balog & Kenter 2019: https://research.google/pubs/personal-knowledge-graphs-a-research-agenda/
