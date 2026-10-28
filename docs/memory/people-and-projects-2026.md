# People and projects: a local memory graph (2026)

**Owner:** S07 (memory). **Status:** spec, 2026-10-25. **Issues:** epic #649; PG0 #650, PG1 #651, PG2 #652, PG3 #653. **Asked by:** the owner ("build a people and project memory graph").

Research behind this plan, with sources:
- [research/personal-crm-and-assistants.md](research/personal-crm-and-assistants.md): personal CRMs (Clay, Dex, Monica, Folk), notes-based people pages (Obsidian, Notion, Logseq), platform assistants (Apple, Google, Microsoft), AI memory products (Rewind/Limitless, Mem, Khoj, meeting-notes apps), and what users dislike.
- [research/graph-memory-extraction-and-privacy.md](research/graph-memory-extraction-and-privacy.md): graph memory for agents (GraphRAG, LightRAG, Zep/Graphiti, mem0, Letta, Cognee), entity resolution on personal data, commitment ("open loop") detection, memory poisoning, and privacy rules for data about people who never consented.

**Next:** [everything memory](../design/everything-memory-2026.md) extends this graph with events, topics, cited facts from message and mail bodies, a review queue and a quarantined extractor.

**The short version.** Psyche remembers files, not people. It cannot answer "who is Sam", "what am I waiting on from Sam", "prep me for my 2 pm" or "what's going on with the kitchen remodel" without searching raw mail every time and guessing. This plan adds a small graph in the existing SQLite database: **people, organisations, projects and places**, their **identifiers** (emails, phones, Contacts ids, channel handles), **facts** with provenance and validity dates, **interactions** (mail, messages, meetings, notes, chats) stored as pointers rather than copies, and **open loops** (what I owe, what I'm waiting on). It is built **deterministically first** from headers, attendees and Contacts, then **enriched nightly by the utility model** inside the dreaming window. Every card is also a Markdown file the owner can read and edit, and edits teach the graph. Third-party text never becomes an owner fact, and sensitive traits are never inferred. Four workstreams deliver it: protocol, data and extraction, UI, and skills.

## 1. Where we are (main, 2026-10-25)

| Piece | Today | Gap for people and projects |
| --- | --- | --- |
| Workspace files | `USER.md` (4,000-char budget; Directives and a dated **Learned** section written by the learner, #509), `MEMORY.md` (curated nightly by dreaming with source dates; sections People, Projects and goals …), `interests.md`, daily notes | People and projects are free-text bullets. Nothing links "Sam" in a note to sam@acme.com in mail. |
| Index | `memory_chunks` + FTS5 + vectors, `memory_claims` (provenance, supersedes, retraction), `memory_recalls` | Claims have no subject. There is no entity, identifier or relationship. |
| Learner (`apps/gateway/src/compose/user-profile.ts`) | Proposes facts of kind `name / preference / routine / person / project / other` from the owner's own messages into USER.md Learned | `person` and `project` facts are strings in USER.md, unlinked and unbounded. |
| Dreaming (`packages/memory/src/dreaming.ts`) | 03:00 local through `@psyche/scheduler`; promotes daily-note facts into MEMORY.md | No per-entity summaries, no project clustering. |
| Channels identities (`packages/channels/src/identity.ts`) | `identityLinks` merge one person's senders across channels (owner-only policy) | Channel people and mail people are separate worlds. |
| Connectors | Mail (Apple scripting, IMAP/JMAP, Gmail, Microsoft), Calendar (EventKit, Google, Microsoft), Messages (`chat.db` via the helper, as a channel), Notes; `Connector.sync(cursor)` for incremental pulls; `ConnectorRegistry.instance(id)` for Gateway pollers | Wave 1 of docs/connectors/apple-apps-2026.md adds what this plan relies on: **Contacts P1–P3**, **Mail M2–M9** (mailboxes, selected, links, flags), **Calendar C1 attendees**, **Notes N1 search**. Until those land, ingest falls back to the existing tools (§5.1). |
| Search (`packages/search`) | One index; memory hits come live from `MemoryStore.search` | No People or Projects group. |
| Skills | `inbox-triage`, `calendar-planning`, `weekly-review`, `reply-drafting`, `memory-hygiene` | Meeting prep and triage cannot ask "who is this and what do we owe each other". |

## 2. What users want (evidence summary)

See the research notes for sources. The patterns that matter for Psyche:

- **The five questions need different data.** "Who is Sam" is identity plus a few facts plus recency. "What am I waiting on from Sam" is open loops with a counterpart. "Prep me for my 2 pm" is attendees → people → last interactions + open loops + the project the meeting belongs to. "What's going on with the kitchen remodel" is a project with members, recent interactions, loops and status. Mail triage needs relationship strength (two-way, recent, frequent) more than facts.
- **Personal CRMs converge on the same objects:** a contact merged across sources, a timeline of interactions, notes, reminders or "keep in touch" cadence, and tags or groups. Their worst failures are **wrong merges** and **stale or creepy enrichment** pulled from the web.
- **Assistants that read mail detect commitments.** Outlook and Viva surface "you said you'd…" and "follow up on…" from sent mail; Gmail nudges unanswered threads; Apple Mail suggests follow-ups after 3 days without a reply. Humans agree only moderately on what counts as a commitment (kappa ≈ 0.54 in the research literature), and models trained on one mailbox degrade on another. So the reliable core is deterministic (an ask with no reply), model-detected loops are suggestions with the quoted sentence, and precision matters more than recall: a wrong "you owe Sam" is worse than a missed one.
- **Graph memory for agents** (GraphRAG, Graphiti, mem0) stores entities, typed relations and time-bounded facts, resolves entities with deterministic keys first and an LLM second, and invalidates facts instead of deleting them. The parts worth copying are small: typed edges, validity windows and per-entity summaries. Community detection over a whole corpus is overkill for one person's data.
- **Privacy:** the people in the graph never agreed to be in it. Under GDPR, *inferring* a special-category trait counts as processing it (CJEU C-184/20), and studies of assistant memory find most users react badly when they discover what was inferred. Store as little as answers the five questions, keep it local, never infer sensitive traits (health, religion, politics, sexuality, ethnicity, immigration status, criminal history, others' finances), never enrich from the web on your own, and let the owner see, correct and forget everything.

## 3. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where does the graph live? | **The main SQLite database**, tables `graph_*`, owned by `packages/memory`; one migration. FTS5 over names, aliases, facts and summaries. | ADR-004 (one store), backups and export already cover it, and the memory forget and provenance machinery is in the same package. |
| What is the source of truth? | **The database.** Each entity also has a generated Markdown card in the workspace, `people/<slug>.md` and `projects/<slug>.md`, rewritten when the entity changes. The owner's edits to a card are parsed back as corrections (§5.4). | Matches MEMORY.md: machines write a readable file, and the owner's edits win. Cards are indexed like other notes, so `memory_search` finds them. |
| Entity kinds | `person`, `org`, `project`, `place`. **No "thing" kind** in v1 (devices, pets and so on stay facts on a person or project). | Covers the five questions; more kinds widen extraction errors. |
| Who creates entities? | **Contacts and the owner always. Mail, calendar and messages only past a threshold** (§5.1). The model **suggests** projects and merges, and the owner confirms them. | Newsletters, no-reply senders and one-off correspondents should not become people. |
| How are people merged? | **Only on deterministic identifiers** (normalised email, E.164 phone, Contacts id, channel id) **or the owner's confirmation**. Names alone never merge. | Wrong merges are the top complaint in personal CRMs. Two "Sam"s are normal. |
| Interactions | **Pointers plus headers**: kind, time, participants, subject (truncated), direction, thread key, and a link back (`message://`, event id, chat guid). **No bodies.** Bodies are re-read through the connector when a tool needs them. | Minimal data about third parties; the source app stays the record. |
| Facts | Typed attribute allowlist, provenance (`owner / agent / untrusted / system`), confidence, sources, validity window (`valid_from`, `valid_to`) and supersession. | Same rules as memory claims; time-bounded like Graphiti so "Sam moved to Initech" invalidates rather than deletes. |
| Open loops | Detected from **owner-authored text** (sent mail, the owner's chat, notes) as `i_owe` / `waiting_on`; asks in **received** mail become **suggested** `i_owe` loops marked as coming from that sender. Owner confirms, dismisses or completes. | Precision over recall. Third-party text never creates a commitment on its own authority. |
| Model use | The **utility model** (local by default), **nightly** in the dreaming window, plus a small **after-run** pass for entities touched in a turn; hard token caps per night. | The deterministic pass answers most questions; the model adds summaries, roles and loops. |
| Agent access | **Read-only tools** (`people_lookup`, `project_brief`, `waiting_on`, `meeting_prep`) in v1. Corrections and merges are owner actions in the UI. | The agent should not rewrite who people are. Loops can be marked done through a write tool that asks (§6.2). |
| Sensitive traits | **Never inferred, never stored** as facts, edges or summaries. The attribute allowlist has no slot for them, and summaries are filtered. | Security §8 filters, GDPR Art. 9 categories, and the research's creepiness evidence. |

## 4. Model

### 4.1 Entities

| Kind | Required | Optional | Notes |
| --- | --- | --- | --- |
| `person` | `name` | aliases, identifiers, facts, `is_owner` (exactly one: the owner), `pinned`, `hidden` | The owner's own entity backs "what Psyche knows about me" and is linked to USER.md. |
| `org` | `name` | domain identifiers (`acme.com`), aliases | Created from Contacts `organization`, signature lines (suggested), or mail domains of known people (never from free-mail domains). |
| `project` | `name` | `status` (`active / paused / done`), `due_at`, members (edges), keywords, a calendar-series or mail-thread anchor | Created by the owner, by the owner's own words ("the kitchen remodel"), or confirmed from a model suggestion. |
| `place` | `name` | address text, geo (only if the owner adds it) | From Contacts addresses (owner-curated) or meeting locations; never from tracking. |

Every entity has `status` (`active / archived / merged`), `merged_into`, `created_at`, `updated_at`, `last_interaction_at` and a model-written `summary` (≤ 400 characters, provenance `agent`, regenerated when stale).

### 4.2 Identifiers and aliases

- **Identifiers** are unique keys: `email` (lower-cased; Gmail dots and `+tags` folded only for gmail.com / googlemail.com), `phone` (E.164 via the owner's region), `contact` (CNContact identifier), `channel` (`telegram:123`, `imessage:+1…`, `slack:T/U`), `domain` (orgs), `calendar` (event series), `url`. One identifier belongs to one entity at most. This is the merge key.
- **Aliases** are names and nicknames (non-unique): the display names seen in headers, Contacts nicknames, names the owner uses in chat. Lookup uses aliases; merging never does.
- **Never people, never keys:** addresses matching `no-reply`, `noreply`, `notifications@`, `mailer-daemon`; role addresses (`info@`, `support@`, `hello@`, `team@`, `sales@`, `billing@` …); messages with `List-Id`, `List-Unsubscribe`, `Precedence: bulk/list` or `Auto-Submitted` other than `no` (RFC 2369, 2919, 3834); calendar resources (rooms). Such senders can become an `org` (the company) but not a `person`.
- **Shared addresses:** an address seen with two or more distinct display names (a family or team inbox) is marked `shared`. It is shown on the entities that use it but never resolves an interaction to one person on its own, so it cannot chain two people together.
- **Links are reversible:** each identifier records `linked_by` (`rule / owner / model`) and when. A model-proposed link affects answers only after the owner confirms it, and a split restores the previous assignment in one action.

### 4.3 Facts

`graph_facts`: `entity_id`, `attribute`, `value`, `provenance`, `confidence` (0–1), `sources` (interaction ids, chunk ids, Contacts id, thread id), `evidence` (the quoted span it came from, ≤ 200 characters, shown on the card), `valid_from`, `valid_to`, `recorded_at`, `superseded_by`, `retracted_at`.

**Expiry:** `agent` and `untrusted` facts get `valid_to` 12 months after their newest evidence unless new evidence refreshes them. `owner` facts never expire.

**Attribute allowlist** (v1): `role`, `title`, `employer`, `team`, `email_pref` (how they like to be reached), `timezone`, `city`, `birthday` (from Contacts or the owner only), `relationship_to_owner` (from Contacts "related names" or the owner only: `partner`, `parent`, `child`, `sibling`, `friend`, `colleague`, `manager`, `report`, `client`, `vendor`, `teacher`, `doctor`, `other`), `preference` (owner-stated only), `note` (owner only), project-only `status`, `next_step`, `budget_note` (owner only), `deadline`.

There is **no attribute** for health, religion, politics, sexuality, ethnicity, immigration status, criminal history, union membership, or anyone else's finances, and extraction may not invent one. `note` is the owner's free text and is filtered like USER.md (secrets, cards, government ids, account numbers, health) before it is stored.

**Who may set what:**
- `owner` facts come from the owner's card edits, the owner's chat (via the learner), and Contacts fields the owner maintains.
- `agent` facts are the model's inferences from **owner-authored** text or from deterministic data (an attendee list, a signature block the owner replied to).
- `untrusted` facts are claims inside third-party mail or messages ("Sam says he's moving to Berlin"). They show on a card as "From Sam's mail, Oct 12: …" with the source, never as plain facts, and **never** feed merges, relationship edges or loops on their own.
- `system` facts come from the extractor's deterministic rules (first and last contact dates, counts).

### 4.4 Relationships

`graph_edges`: `src`, `dst`, `rel`, `provenance`, `confidence`, `sources`, `valid_from`, `valid_to`.
- **`rel` allowlist:** `works_at` (person → org), `member_of` (person → project), `stakeholder_of` (person or org → project), `located_at` (entity → place), `reports_to` (person → person, owner-stated or from Contacts), `related_to` (person → person, carrying a `relationship_to_owner`-style label only when the owner or Contacts says so), `part_of` (project → project).
- Interaction-derived ties (who appears together) are **not edges**; they are computed at query time from `graph_participants`, so they cannot drift from the data.

### 4.5 Interactions

`graph_interactions`: `id`, `kind` (`mail / message / meeting / call / note / chat / task`), `source` (connector id), `external_ref` (Message-ID, event id, chat guid; unique per source), `occurred_at`, `direction` (`in / out / both / none`), `subject` (≤ 200 characters, untrusted), `thread_key`, `link` (`message://…`, `calendar://…` or the connector's own), `project_id` (nullable), `created_at`.
`graph_participants`: `interaction_id`, `entity_id`, `role` (`from / to / cc / attendee / organizer / mentioned`).

Messages are stored **one interaction per conversation per day**, not per message. A meeting is one interaction with all attendees. Bodies are never stored.

### 4.6 Open loops

`graph_loops`: `id`, `direction` (`i_owe` | `waiting_on`), `text` (≤ 200 characters, phrased by the extractor: "Send Sam the revised budget"), `evidence` (the quoted sentence), `counterpart_id`, `project_id`, `due_at`, `status` (`suggested / open / snoozed / done / dismissed`), `source_interaction_id`, `provenance`, `confidence`, `detected_by` (`rule / model / owner`), `created_at`, `closed_at`, `closed_by` (`owner / reply_seen / due_passed`).

- `open` loops come from the owner's own words: sent mail ("I'll send you the deck by Friday" → `i_owe`; "could you send me the quote?" → `waiting_on`), the owner's chat ("remind me Sam owes me the keys"), and confirmed suggestions.
- `suggested` loops come from received mail and messages ("Can you review the draft?" → a suggested `i_owe` from that sender). The owner confirms them; the agent never acts on them unasked.
- **No-reply rule (deterministic):** a sent mail or message from the owner that asks something (a question mark or a request phrase addressed to the recipient) and has no reply in the thread after 3 days becomes a `waiting_on` loop, as Apple Mail's follow-up suggestions and Gmail's nudges do (research: personal CRMs, open loops). The model pass only rephrases it and adds a due date when the text names one.
- **Auto-close:** a `waiting_on` loop closes as `reply_seen` when the counterpart replies in the same thread with an attachment or a matching phrase (rule first, model second). An `i_owe` loop closes when the owner sends a reply in the thread, and that close is shown as a suggestion. M12 (follow-up check) in the connectors plan reuses these loops.

### 4.7 Storage

One migration, `packages/db/migrations/<ts>_memory_graph.sql`, with a drizzle mirror in `packages/db/src/schema-s07.ts`:

```text
graph_entities (id PK 'ent_…', kind, name, sort_name, status, merged_into, is_owner, pinned, hidden,
                summary, summary_at, last_interaction_at, card_path, created_at, updated_at)
graph_identifiers (kind, value_norm, value_display, entity_id FK, source, verified, created_at,
                   PRIMARY KEY (kind, value_norm))
graph_aliases (entity_id FK, alias_norm, alias, source, created_at)
graph_facts (id PK, entity_id FK, attribute, value, provenance, confidence, sources JSON,
             valid_from, valid_to, superseded_by, retracted_at, created_at, updated_at)
graph_edges (id PK, src FK, dst FK, rel, provenance, confidence, sources JSON, valid_from, valid_to, …)
graph_interactions (id PK, kind, source, external_ref, occurred_at, direction, subject, thread_key,
                    link, project_id FK NULL, created_at, UNIQUE (source, external_ref))
graph_participants (interaction_id FK, entity_id FK, role, PRIMARY KEY (interaction_id, entity_id, role))
graph_loops (…as §4.6)
graph_feedback (id PK, kind, entity_id, other_id, key_hash, created_at)   -- corrections (§5.4)
graph_blocklist (kind, value_hash, created_at, PRIMARY KEY (kind, value_hash))  -- forgotten/hidden identifiers
graph_cursors (source PK, cursor JSON, updated_at)                        -- incremental ingest
graph_fts (FTS5 over entity name, aliases, current facts, summary)
```

Settings key `memory.graph`: `{enabled, sources: {contacts, mail, calendar, messages, notes, chats}, interactionRetentionDays (default 540), entityRecall (default true), model: {nightly: true, afterRun: true, maxEntitiesPerNight: 200, maxTokensPerNight: 150000}}`. Every source is **off until the owner turns it on** in onboarding or Settings, except chats (the owner's own words), which follow `memory.userProfile`.

### 4.8 The card files

`people/sam-lee.md` (generated; the owner may edit anything):

```markdown
---
id: ent_01JB…
kind: person
aliases: [Sam, Samuel Lee]
emails: [sam@acme.com]
phones: ["+14155550100"]
---
# Sam Lee
Head of product at Acme. You last talked on Oct 22 (mail). [summary · Oct 24]

## Facts
- Works at: Acme [contacts]
- Role: Head of product [mail, Oct 12]
- Prefers: email over calls [you, Oct 3]

## Open loops
- [ ] You owe: send the revised budget (due Oct 28) [mail, Oct 22]
- [ ] Waiting on: signed SOW [mail, Oct 19]

## Projects
- Kitchen remodel — stakeholder

## Notes
<!-- Yours. Psyche never rewrites this section. -->
```

- **Budget:** a card renders at most **2,000 characters** (facts newest first, at most 5 loops and 3 projects; overflow gets a "more in Psyche" line). Cards are never injected wholesale into the prompt (§6.3).
- **Round trip:** the watcher (`store.sync`) parses edited cards. A deleted fact line is a correction. An added fact line becomes an `owner` fact. A ticked loop is `done`. The Notes section is stored verbatim and never rewritten. Front-matter edits to aliases, emails and phones are owner changes and may cause a merge, which is shown before it applies.
- Cards sit under `people/` and `projects/` in the workspace, are indexed (searchable), and are protected like `MEMORY.md`: only the graph writer and the owner write them. The agent's `memory` tool gets `approval_required` there.

### 4.9 Retention, forget and export

- **Following the source:** when a mail, event or chat is deleted in its app, the next sync removes its interaction and anything derived only from it (facts, loops, evidence).
- **Retention:** interactions older than `interactionRetentionDays` (default 18 months) are deleted nightly. Entities, facts and loops stay until forgotten. An entity with no interactions, facts or edges for 18 months is archived (hidden from search, kept for merges).
- **Forget a person or project** (`memory.entities.forget`): deletes the entity, its identifiers, aliases, facts, edges, participants and loops, and its card file. Its identifiers' hashes go into `graph_blocklist`, so ingest never recreates it. The owner can clear the blocklist entry from Settings. The person's mentions are also removed from memory with the existing `forget(subject)` on the name, which shows a dry run first. The audit log records counts, never names. Forget runs with SQLite `secure_delete` on, rebuilds the graph FTS index, checkpoints the WAL and runs an incremental vacuum, so deleted rows do not linger in free pages.
- **Hide ("don't track")** keeps nothing new about a person: they are blocklisted but their existing card stays until forgotten.
- **Export:** `memory.export` adds `graph.json` (entities, identifiers, facts, edges, loops; interactions as pointers) next to the workspace zip, which already includes the card files.
- **Reset:** `memory.reset` clears the `graph_*` tables too.

## 5. Extraction

### 5.1 Deterministic pass (Gateway poller, incremental)

Runs every 15 minutes while the Gateway is up, and right after a connector sync, for the enabled sources only. It uses cursors in `graph_cursors` and connector reads (reads are `allow`). Outputs are tagged `untrusted` where they carry third-party text.

| Source | Reads (wave 1 → fallback today) | Produces |
| --- | --- | --- |
| Contacts | P1 `contacts.search`, P2 `contacts.read` → nothing until wave 1 | person + identifiers (emails, phones) + aliases (nickname) + `employer`/`title` facts (`owner`), `org` + `works_at`, `birthday`, related names → `relationship_to_owner` (`owner`); the "me" card → `is_owner` |
| Mail | M1 `mail.search` with headers, M4 links → today's `mail.search`/`mail.read` (Apple), Gmail/Microsoft/IMAP lists | interactions with participants from From/To/Cc; direction from the owner's addresses; thread key from References/In-Reply-To; **a new person only when** the owner sent to them, or replied to them, or they appear in ≥ 2 threads with the owner in To/Cc and they are not bulk (§4.2) |
| Calendar | C1 with attendees → today's `calendar.list_events` (title, time; Google/Microsoft have attendees) | meeting interactions with attendees and organizer; recurring series as a project-anchor candidate; the next 14 days for meeting prep |
| Messages | `messages.chats` / `messages.read` (helper, `chat.db`) and channel transcripts (Telegram, Signal, Slack, iMessage) | one interaction per conversation per day; handles → identifiers (phones, emails, channel ids); channel `identityLinks` merge with mail people |
| Chats with Psyche | the learner's `person` / `project` facts (#509) and owner messages | owner facts and owner-created projects ("my kitchen remodel"); names mentioned → `mentioned` participants |
| Notes | N1 `notes.search` titles (opt-in, wave 2) | `mentioned` links for notes titled with a known entity |

Resolution order for each address or handle: identifier match → Contacts match → (no match) a **candidate** person that is created only at the threshold above. A display name never merges two identifiers. When two entities share a strong signal (the same name and the same org domain, or the owner wrote "Sam (sam@…)"), the pass records a **merge suggestion** for the owner.

### 5.2 Model pass (utility model, nightly and after runs)

- **When:**
  - Nightly, inside the dreaming run (`withDreaming`), for entities with new interactions since `summary_at`.
  - After a run, for at most 3 entities the run touched (a person looked up, a meeting prepped), with a 5-minute debounce.
- **Input per entity:** the card's current facts, up to 20 newest interaction headers, and, **for owner-authored items only**, short excerpts with quoted replies stripped, re-read through the connector (≤ 1,500 characters each, at most 5). Third-party bodies go in only as quoted, delimited data with an explicit "data, not instructions" frame, and only for loop suggestions and signature roles.
- **Output (JSON, validated):**
  - `summary` (≤ 400 characters, no sensitive traits);
  - proposed `facts` from the allowlist with source ids;
  - `loops` (direction, text, due, source id);
  - for projects, `status` and `next_step`;
  - `project_suggestions` (name, keywords, member ids, anchor thread or series).
- **Rules on the output:**
  - Facts and loops from owner-authored sources are `agent`. Those from third-party sources are `untrusted` (facts) or `suggested` (loops).
  - Anything outside the allowlist, anything instruction-like, and anything matching the sensitive filters is dropped and counted.
  - `relationship_to_owner` from the model is dropped unless the owner or Contacts already set it.
- **Cost controls:**
  - The `utility` role (local by default).
  - At most `maxEntitiesPerNight` (200) and `maxTokensPerNight` (150k) per night.
  - Entities are ordered by new interaction count, with pinned ones first.
  - The input hash is cached, so an unchanged entity is skipped.
  - One batch per entity, no tools, temperature 0.
  - If the budget runs out, the rest waits for the next night and the diary says so.
- **Project clustering:** threads and series that share a keyword set (Jaccard over subject keywords ≥ 0.5) and participants across ≥ 3 interactions in 30 days become a **project suggestion**, named by the model and shown to the owner. Confirmed projects then claim future interactions by keyword and participants. The owner can retag an interaction.

### 5.3 Taint and poisoning rules

1. Subjects, display names, signatures, bodies and message text from anyone but the owner are `untrusted`. They are stored truncated, never as instructions, and always quoted with their source.
2. Untrusted text never creates or merges an entity, never sets `relationship_to_owner` or an edge, never opens a loop (only a `suggested` one), and never changes an `owner` fact.
3. Tool outputs that include untrusted fields (summaries built from untrusted input count as untrusted) are marked `provenance: "untrusted"`, so the turn is tainted (security §3.6).
4. The model pass runs with no tools. Its output is data validated against the schema and is never executed.
5. An entity's summary is regenerated from facts and headers, never from a previous summary alone, so poisoned text cannot persist through summaries.

### 5.4 Corrections: the teaching loop

The owner edits a card in the app or in the file, and the graph keeps the change:

| Owner action | Stored as | Effect from then on |
| --- | --- | --- |
| Deletes or edits a fact ("not head of product") | the fact is retracted; `graph_feedback(kind: wrong_fact, key_hash)` | the same attribute and value is never proposed again for that entity |
| Adds a fact or note | an `owner` fact | outranks model facts; shown first |
| Renames, or adds an alias | the alias becomes preferred | lookups and prompts use the owner's name for them |
| Merges two people | identifiers move; `merged_into`; `graph_feedback(merge)` | future addresses resolve to the merged entity |
| Splits a person (moves identifiers out) | `graph_feedback(do_not_merge, a, b)` | never suggested for merging again |
| "Not a project" on a suggestion | `graph_feedback(not_project, keyset hash)` | the cluster is never suggested again |
| "Don't track" | blocklisted identifiers | nothing new is stored about them |
| Completes, snoozes or dismisses a loop | loop status | dismissed text from that source is not re-suggested |

Corrections from anywhere use the same write path. That includes this card, the Markdown file, and the agent's teaching loop (docs/agent/teaching-loop-2026.md, where a correction about a person or project becomes a lesson): `GraphStore.correct({entityId, attribute | rel, value, source})` in-process, or `memory.entities.facts.set` / `.edges.set` / `.retract` over the API. The graph keeps every version (§4.3 validity and supersession), so the previous value and its source are always available from `memory.entities.history`. A lesson keeps only its own id, which goes in the fact's `sources`.

For each entity, the model pass also sees a short "the owner corrected: …" list (the last 5 corrections, as key and value without third-party text), so the next summary respects them.

## 6. Surfaces

### 6.1 Protocol (additive; `memory.entities.*`, `memory.loops.*`)

| Method | Scope | Notes |
| --- | --- | --- |
| `memory.entities.search {q, kinds?, limit?}` | read | ranked by FTS + recency + interaction count; returns `EntitySummary[]` |
| `memory.entities.get {id}` | read | entity, identifiers, aliases, current facts (with provenance and sources), edges, projects, open loops, last 10 interactions, card etag |
| `memory.entities.interactions {id, cursor?, limit?}` | read | newest first; pointers and links |
| `memory.entities.update {id, name?, aliases?, status?, pinned?, hidden?, etag}` | write | owner edit |
| `memory.entities.facts.set {entityId, attribute, value, source?}` / `.retract {factId, source?}` | write | owner facts; a set on an attribute that already has a current value supersedes it (the old row keeps its value, provenance, sources and `valid_to`); retract records a correction. `source` is `{kind: "owner_edit" \| "owner_feedback" \| "chat", ref?}` (for example the teaching loop's lesson id), stored in the fact's `sources` |
| `memory.entities.edges.set {src, rel, dst, source?}` / `.retract {edgeId, source?}` | write | owner relations (§4.4 allowlist); same supersession and `source` rules |
| `memory.entities.history {entityId, attribute?}` | read | every version of the entity's facts (current and superseded) and edges, newest first, with provenance and sources: what "learned from you, refined 3 times" reads |
| `memory.entities.create {kind, name, …}` | write | owner-created person, org, project, place |
| `memory.entities.merge {ids, into}` / `.split {id, identifiers}` | write | preview with `dryRun` |
| `memory.entities.suggestions {}` / `.suggestions.answer {id, accept}` | read / write | merge and project suggestions |
| `memory.entities.forget {id, dryRun?}` | admin | §4.9 |
| `memory.loops.list {status?, direction?, entityId?, projectId?, dueBefore?}` | read | |
| `memory.loops.update {id, status?, dueAt?, text?}` | write | |
| `memory.graph.status {}` | read | per-source counts, last ingest, last model pass, budget used, and **loop precision**: suggested loops confirmed vs dismissed per source over 30 days (the metric that tunes or turns off model loop detection) |

Events: `memory.entity.updated {id, kind, changed}`, `memory.loop.updated {loop}`, `memory.suggestion.created {id, kind}`. `SearchIndexDocKind` gains `person` and `project`. Settings use the existing `settings.*` with the `memory.graph` key.

### 6.2 Agent tools

| Tool | Side effect | Returns |
| --- | --- | --- |
| `people_lookup {query}` | none | up to 3 matching people or orgs as compact cards: name, who they are, how you know them, last contact, open loops, projects. Candidates are ranked by recency × frequency of **two-way** contact; when the top two are close, it lists both with one distinguishing line each and the agent asks which one |
| `project_brief {query}` | none | the project card: status, next step, members, the last 10 interactions with links, open loops, upcoming meetings |
| `waiting_on {person?, project?, direction?}` | none | open loops, oldest first, with due dates and links |
| `meeting_prep {event_id? \| when?}` | none | for one event: attendees as compact cards, the project, open loops with attendees, the last 3 interactions per attendee, and links |
| `loop_update {id, status}` | write (`ask`, owner-only surfaces) | marks a loop done, snoozed or dismissed |

All results carry `provenance: "untrusted"` when they include untrusted facts, suggested loops or subjects. Mail bodies are not in these results; the agent reads them through the mail tools if it needs them.

### 6.3 Entity recall in context

In the owner's **private** sessions only, when the owner's message names a known entity unambiguously (an exact alias match, or the agent resolved it this turn), context assembly adds one compact line per entity (≤ 300 characters, at most 3 entities): "Sam Lee — head of product at Acme; last talked Oct 22; you owe: revised budget". It is behind `memory.graph.entityRecall` and never applies in group, delegated or channel-peer sessions.

### 6.4 Search

People and Projects become the first two groups in ⌘K and the Search page (redesign §5.5). A row shows a 20 px monogram (or the Contacts photo, if the owner turned on photos later), the name, and a callout line ("Acme · last talked Oct 22 · 2 open loops"). The preview pane shows the card.

### 6.5 Person and project cards (UI)

Following docs/design/redesign-2026.md: a level-1 card, 16 px padding, no outline.
- **Header:** the name in `text-title-2`, a kind line in `text-caption` ("Person · Acme"), and the summary in `text-reading`.
- **Grouped rows (§5.8 style)** for Facts (each with a provenance glyph and its source; untrusted ones read "From Sam's mail, Oct 12"), Open loops (checkbox rows: due, link, "Done", "Not a loop"), Projects, Recent (interaction rows with app glyphs, newest first, linking back to Mail, Calendar or Messages) and Notes (an editable text area).
- **Edit in place:** a fact row gets "Edit" and "This is wrong" on hover or focus. "Merge…" and "Forget…" sit under ⋯.
- **Project card:** a status segmented control (Active / Paused / Done), next step, members as avatar chips, a timeline and loops.
- **Where they appear:** the Search preview, a new **People & projects** section in the agent sheet's Soul & Memory tab (a list with search and filter chips: People, Projects, Suggestions, Waiting on), and links from chat (names the agent mentions in results link to the card).
- **Suggestions:** "Is Sam Lee the same as sam@acme.com?" and "Is this a project: kitchen remodel?" use the inferred-goal pattern (a sparkle glyph; Confirm / Not the same / Later).

### 6.6 Meeting prep, triage and the brief

- **Meeting prep:** 15 minutes before a meeting with external attendees (setting, default on once Calendar is on), a scheduler job runs `meeting_prep` and posts a Feed card ("Prep: 2 pm with Sam and Dana"). The `meeting-prep` skill can also append it to a note (N3).
- **Inbox triage:** the `inbox-triage` skill ranks senders by relationship strength (two-way, recent, frequent: from `graph_participants`). It turns asks into suggested loops, never sends, and labels unknown senders as such.
- **Morning brief and weekly review:** a "Waiting on" section (loops older than 3 days) and "You owe" (due this week).

### 6.7 Settings and transparency

**Settings → Memory → People & projects:**
- an on/off switch;
- per-source toggles with counts (Contacts, Mail, Calendar, Messages, Notes, Chats);
- interaction retention;
- "Use names in replies" (entity recall);
- the model pass (nightly, after runs) and its budget used;
- Blocked people (unblock);
- "Forget everything in the graph".

**What Psyche knows about me** opens the owner's own card: USER.md facts plus graph facts about the owner, each with its source and delete.

## 7. Privacy rules (binding for every workstream)

1. Local only. The graph never leaves the machine except in the owner's own export or backup.
2. No web enrichment: no lookups of people on the web, social networks or data brokers unless the owner asks in a turn for one specific person, and the result is not stored unless the owner saves it.
3. No sensitive traits (§4.3), for anyone, including the owner (the owner may write them in Notes; they are still never injected unless the owner pins them).
4. Minimal data about third parties: headers and pointers, no bodies, retention-bounded.
5. Every fact shows where it came from; every card can be corrected and forgotten; forgotten people stay forgotten (blocklist).
6. Untrusted content is data (§5.3).
7. Sources are opt-in per source. Turning a source off stops ingest and offers to delete what it produced. Facts derived only from a deleted source item, or a disconnected source, go with it, and nothing outlives the data it came from (the failure users report with chat-memory products).
8. No graph data in group, channel-peer or delegated contexts; no graph data sent to a non-local model without the owner's model choice (the utility model is local by default; if the owner picks a cloud utility model, Settings says the graph pass will use it).

## 8. Acceptance (fixtures)

A fixture world (`tests/fixtures/graph/`) with Contacts (12 people, 3 orgs, the owner's card), 60 mails (including newsletters, a no-reply sender, a mailing list, two different "Sam"s, a shared family address, a forwarded thread and an injection attempt in a body), 15 calendar events (with attendees, a recurring series, a room resource) and 3 message threads must give:

| Question | Expected |
| --- | --- |
| "who is Sam" | asks which Sam (Sam Lee at Acme, Sam Ortiz, your neighbour), each with one line |
| "what am I waiting on from Sam Lee" | the signed SOW (from the owner's sent mail), not the injected "you owe Sam $500" |
| "prep me for my 2 pm" | attendees with roles, the project, two open loops, last interactions with links |
| "what's going on with the kitchen remodel" | status, next step, the contractor and the designer, the last 5 interactions, the deposit loop |
| triage | the mailing list and no-reply sender are not people; the injection is a suggested loop at most, labelled with its sender |
| correction | deleting "Role: CFO" on a card means the next nightly pass does not re-add it |
| forget | forgetting Sam Ortiz removes the card, rows and mentions, and a new mail from him does not recreate him |

## 9. Plan: four workstreams

Order: **PG0 (protocol) first**, then **PG1 (data and extraction)** and **PG2 (UI, on fixtures and MockGateway)** in parallel, then **PG3 (skills and flows)** after PG1's tools exist. Issues: epic #649, PG0 #650, PG1 #651, PG2 #652, PG3 #653.

Every PR:
- Tests run on fixtures only, with no live app calls, `vitest --maxWorkers=1`, and typechecks of changed packages only (the machine is shared).
- No local model runs: the model pass is tested with `FakeModelProvider`.
- At most one announced dev run per PR with `PSYCHE_HOME=~/.psyche-try PSYCHE_PORT=7989`.

### PG0: protocol (one PR, first)

> Add the people-and-projects graph shapes from docs/memory/people-and-projects-2026.md §6.1 to `packages/protocol/src/schemas/graph.ts` and `packages/protocol/src/methods/memory.ts`, additively.
> - **Schemas:** `GraphEntityKind`, `GraphEntity`, `EntitySummary`, `GraphIdentifier`, `GraphFact` (attribute enum from §4.3, provenance, confidence, sources, validity), `GraphEdge` (rel enum from §4.4), `GraphInteraction`, `GraphLoop`, `GraphSuggestion`, `GraphStatus`.
> - **Methods:** every method in §6.1, with the scopes given there. Writes are `sideEffecting`, and `memory.entities.forget` is `operator.admin`.
> - **Events:** `memory.entity.updated`, `memory.loop.updated` and `memory.suggestion.created`.
> - **Search:** `SearchIndexDocKind` gains `person` and `project`.
> - **Documentation:** each param carries a one-line `description`.
>
> Then:
> - add a CHANGES.md entry and a changeset;
> - run `pnpm protocol:gen` and check `pnpm protocol:check`;
> - update `FakeMemoryStore` only if a contract interface changes (it should not).
>
> Touch only `packages/protocol/**`, `packages/testing/src/fakes/**` and the generated files. Title: `protocol: people and projects graph (part of #650)`.

### PG1: data and extraction (packages/memory + Gateway composition)

> You own the graph's data and extraction for docs/memory/people-and-projects-2026.md:
> - `packages/memory/src/graph/**` (new);
> - one migration `packages/db/migrations/<ts>_memory_graph.sql` and its mirror in `packages/db/src/schema-s07.ts` (plus the table list in `packages/db/test/open.test.ts`);
> - `apps/gateway/src/compose/people.ts` (new), and one wiring hunk in `apps/gateway/src/compose/index.ts`;
> - `packages/search/src/graph.ts` (new: the People / Projects adapter), and one hunk in `packages/search/src/index.ts`.
>
> Build in this order, one PR each:
> 1. **Store** (§4): tables, FTS, identifiers/aliases/facts/edges/interactions/loops/feedback/blocklist, the attribute and rel allowlists, provenance rules, sensitive filters (reuse `blockingKinds`), card files under `people/` and `projects/` protected like MEMORY.md, the card round trip through `store.sync`, forget/blocklist/export/reset, retention.
> 2. **Deterministic ingest** (§5.1): resolution (identifier → Contacts → candidate threshold), the bulk / no-reply / list rules, interactions and participants, cursors, and the merge suggestions. Sources: Contacts (P1/P2 once #638/#639 land; until then a fixture adapter), mail headers (today's tools and the wave-1 additions), calendar attendees, messages and channel identities, and the learner's person/project facts.
> 3. **Model pass** (§5.2–§5.4): per-entity batches on the `utility` role inside `withDreaming`, plus the after-run pass. JSON output validated against the allowlists; taint rules; budgets; input-hash caching; loops with auto-close; project suggestions; the teaching loop from `graph_feedback`.
> 4. **Surfaces** (§6.1–§6.3, §6.6 hooks): `createGraphHandlers` for every `memory.entities.*` / `memory.loops.*` method, the five agent tools with `classifyMemoryCall` rows, entity recall in context assembly (private sessions only), the Search adapter, and the meeting-prep scheduler job behind its setting.
>
> **Proof:** the §8 fixture world under `tests/fixtures/graph/` is shared with PG3. Each PR's tests use it with `FakeModelProvider`:
> - every row of §8's table;
> - the untrusted-never-promoted cases;
> - two different "Sam"s are never merged;
> - forget plus blocklist;
> - card round trip;
> - budgets.
>
> No live connectors or local models. Title each PR `feat(memory): people graph — <part> (part of #651)`.

### PG2: UI (packages/ui)

> You own the people and project UI for docs/memory/people-and-projects-2026.md §6.4–§6.7, following docs/design/redesign-2026.md (§3, §5.5, §5.7, §5.8) and its tokens and motion.
> - **Components:** `PersonCard`, `ProjectCard`, `EntityRow`, `LoopRow` and `SuggestionCard` in `packages/ui/src/people/**` (new).
> - **Search:** the People and Projects groups and the preview pane in Search and ⌘K (one hunk in the search screen, coordinated with its owner).
> - **Agent sheet:** the People & projects section in Soul & Memory.
> - **Settings:** Settings → Memory → People & projects, and "What Psyche knows about me".
> - **Interactions:** edit in place, "This is wrong", merge preview, forget with a dry-run count, and suggestions (Confirm / Not the same / Later).
>
> Build against MockGateway responses that follow PG0's schemas. Every string goes through `t()` in `messages/people.ts`. Every animation has its reduced-motion form. Stories cover populated, empty, loading, error, dark and compact states, and A12 must be clean. Run only `vitest --maxWorkers=1` for packages/ui and apps/web. Title: `feat(ui): people and project cards (part of #652)`.

### PG3: skills and flows (content + scenarios)

> You own the people-and-projects flows for docs/memory/people-and-projects-2026.md §6.6:
> - **New skill:** `skills/meeting-prep/` (SKILL.md + acceptance.md) using `meeting_prep`, `people_lookup` and the mail and notes tools.
> - **Updated skills:** `inbox-triage` (relationship strength, suggested loops, unknown senders), `weekly-review` and the morning brief (Waiting on / You owe), and `memory-hygiene` (review suggestions and corrections).
> - **Agent guidance:** the system-prompt guidance for the five tools (when to look up, never assume which Sam, untrusted facts are quotes).
> - **Scenarios:** `tests/scenarios/people-*.md` on the §8 fixture world, one per question in §8.
>
> Gate the skills on `requires.tools` for the new tool names. Write original text; restate the privacy rules of §7 plainly where a skill touches people. Title: `feat(skills): meeting prep and people-aware triage (part of #653)`.

### What each workstream must prove before its last PR merges

| Workstream | Proof |
| --- | --- |
| PG0 | `protocol:check` clean; registry tests list every method and event |
| PG1 | the §8 table on fixtures; taint and forget tests; budgets enforced; no bodies stored (a test scans the tables) |
| PG2 | MockGateway tests for cards, edit and correction, merge and forget flows; stories; A12 clean |
| PG3 | gating tests; scenario fixtures for the four questions and triage pass |

## 10. Risks

- **Wrong merges.** Only identifiers or the owner merge; suggestions explain why; split is one click and is remembered.
- **Creepiness.** No sensitive traits, no web enrichment, sources opt-in, and "what Psyche knows" is visible.
- **Prompt injection through mail.** §5.3; scenario fixtures include injection attempts, and loops from third parties are only suggestions.
- **Cost and battery.** Deterministic first; a local utility model with nightly caps; input-hash caching; the after-run pass is limited to 3 entities.
- **Connector dependencies.** Contacts and attendees arrive with wave 1 (#638, #639). PG1 builds against fixture adapters and switches over when they land.
- **Stale summaries.** Summaries carry a date and regenerate when new interactions arrive; cards show "as of".
- **File and database drift.** The database is the source of truth; card edits are parsed as corrections; a malformed card is left alone and flagged in the diary, never overwritten silently.

## 11. Decisions the owner should confirm

1. Sources default to **off** and are offered in onboarding and Settings (proposed), rather than on for Contacts and Calendar.
2. Meeting-prep cards 15 minutes before meetings with external attendees, on by default once Calendar is connected.
3. Interaction retention of 18 months.
4. Entity recall in context (one line per named person, private sessions only) on by default.
