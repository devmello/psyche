# Research: graph memory, extraction, injection and privacy

Status: research notes, October 2026. Input to the people and project memory graph spec.
Scope: a local graph of people, projects, commitments and facts built from the owner's Contacts,
Mail, Calendar, Messages and notes, stored in SQLite (FTS5, optional vectors), with a cheap or
local LLM doing extraction.

Every factual claim has a source link. Where a claim comes from a secondary write-up and not the
primary source, it says so. "Psyche note" lines are our reading, not sourced facts.

---

## 1. Graph and entity memory for LLM agents

### Microsoft GraphRAG
- Paper: "From Local to Global: A Graph RAG Approach to Query-Focused Summarization", Edge et al., v1 24 Apr 2024, v2 19 Feb 2025. An LLM builds an entity graph from documents, pre-generates summaries of groups of related entities, then answers by combining partial answers from those summaries. [arXiv 2404.16130](https://arxiv.org/abs/2404.16130)
- Default pipeline: split text into 1,200-token units; the LLM extracts entities (title, type, description) and relationships (source, target, description) per unit. [GraphRAG dataflow docs](https://microsoft.github.io/graphrag/index/default_dataflow/)
- Dedup is naive: "any entities with the same title and type are merged by creating an array of their descriptions", and then an LLM summarizes the list into one description. There is no fuzzy or alias resolution step. [GraphRAG dataflow docs](https://microsoft.github.io/graphrag/index/default_dataflow/)
- "Claims" (covariates: time-bounded factual statements about entities) are off by default because they generally need prompt tuning. [GraphRAG dataflow docs](https://microsoft.github.io/graphrag/index/default_dataflow/)
- Communities come from hierarchical Leiden clustering; the LLM writes a report per community, then a second pass summarizes each report. [GraphRAG dataflow docs](https://microsoft.github.io/graphrag/index/default_dataflow/)
- Cost: LazyGraphRAG (MSR blog, 25 Nov 2024) swaps LLM extraction for NLP noun-phrase extraction and defers all LLM use to query time; its indexing cost is "identical to vector RAG and 0.1% of the costs of full GraphRAG". [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag/)
- Psyche note: community summaries over a personal corpus are expensive and go stale with every new email. Not worth it for v1.

### LightRAG
- Guo et al., Oct 2024; Findings of EMNLP 2025. Adds graph structure to text indexing and uses dual-level retrieval: low level for specific entities and relations, high level for broad themes. [arXiv 2410.05779](https://arxiv.org/html/2410.05779v3), [ACL Anthology](https://preview.aclanthology.org/new-sigs/2025.findings-emnlp.568/)
- Has an incremental update algorithm, so new data does not need a full index rebuild. [arXiv 2410.05779](https://arxiv.org/html/2410.05779v3)

### Zep and Graphiti (temporal knowledge graph)
- Paper: "Zep: A Temporal Knowledge Graph Architecture for Agent Memory", Rasmussen et al., Jan 2025. Graphiti is the open-source engine underneath. [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)
- Schema: three tiers. Episode nodes hold raw messages/text/JSON and are "a non-lossy data store from which semantic entities and relations are extracted"; entity nodes and fact edges sit above them; community nodes cluster strongly connected entities. [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)
- Bi-temporal model: timeline T (when a fact held) and T′ (when the system learned it). Each edge has `t_valid`, `t_invalid`, `t′_created`, `t′_expired`. [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)
- Invalidation: an LLM compares a new edge with semantically related existing edges; on a temporally overlapping contradiction it sets the old edge's `t_invalid` to the new edge's `t_valid`. Nothing is deleted. [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)
- Relative dates ("next Thursday") resolve against each message's reference timestamp; dates are ISO 8601 with offset. [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)
- Entity resolution in the paper: embed new entity, cosine search plus full-text search over names and summaries, then an LLM decides duplicate or not and writes the merged name/summary. Fact dedup is limited to edges between the same entity pair. [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)
- Later pipeline (Zep blog, 10 Nov 2025): normalized exact match first; an entropy gate sends short, low-entropy names (e.g. a four-letter first name) straight to the LLM because fuzzy matching is unstable for them; others go through 3-gram MinHash + LSH and are accepted above Jaccard 0.9; LLM only as fallback; a second pass catches duplicates within a batch. [Zep blog](https://www.getzep.com/blog/graphiti-hits-20k-stars-mcp-server-1-0/)
- Zep changelog (2026): custom entity types can declare identity properties, so a match on those values merges deterministically; a strict ontology mode drops entities outside defined types. [Zep changelog](https://help.getzep.com/changelog/2026/7/9)
- Retrieval mixes vector similarity, BM25 and graph traversal with no LLM reranking. [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
- Cost: about 1.6k tokens of context versus about 115k for full context; latency with gpt-4o-mini fell from 31.3 s to 3.2 s. Label propagation was chosen over Leiden partly because it updates incrementally. [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)

### mem0 and Mem0g (graph memory)
- Chhikara et al., Apr 2025. [arXiv 2504.19413](https://arxiv.org/html/2504.19413v1)
- Base mem0: an LLM extracts candidate facts, retrieves the top 10 similar memories, then picks ADD, UPDATE, DELETE or NOOP via a tool call. [arXiv 2504.19413](https://arxiv.org/html/2504.19413v1)
- Mem0g: directed labeled graph; nodes have a type (Person, Location, Event), embedding and creation time; edges are triplets like `lives_in`. Entity resolution is embedding similarity above a threshold (value not given). A conflict detector plus LLM "update resolver" marks conflicting edges invalid instead of deleting them. [arXiv 2504.19413](https://arxiv.org/html/2504.19413v1)
- LOCOMO (LLM judge): Mem0 66.9%, Mem0g 68.4%, full context 72.9%. Retrieved context about 1.8k (Mem0) and 3.6k (Mem0g) tokens versus 26k full context; p95 latency 1.4 s / 2.6 s vs 17.1 s. Graph helps temporal questions (58.1 vs 55.5) but slightly hurts single-hop and multi-hop. [arXiv 2504.19413](https://arxiv.org/html/2504.19413v1)

### Letta / MemGPT
- MemGPT (Packer et al., Oct 2023) treats the context window like OS main memory and pages data to external storage. [arXiv 2310.08560](https://arxiv.org/abs/2310.08560)
- Letta docs describe three layers: core memory blocks always in context (e.g. "human" and "persona" blocks), recall memory (searchable conversation history), and archival memory (a vector table with `archival_memory_search` / `archival_memory_insert`). The agent edits its own blocks via tools. [Letta docs (v1)](https://docs-v1.letta.com/guides/agents/architectures/memgpt)
- Psyche note: no entity resolution or temporal validity; memory is free text the agent rewrites.

### Cognee
- Extract, Cognify, Load pipeline; Cognify builds a graph, often grounded in RDF ontologies; storage is relational + vector + graph. [Cognee core concepts](https://docs.cognee.ai/core-concepts/overview)
- Current API exposes remember, recall, forget, improve. [PyPI](https://pypi.org/pypi/cognee/)

### LangChain and LlamaIndex
- LangChain's old `ConversationKGMemory` moved to `langchain_community`; the old memory classes were deprecated in favour of LangGraph persistence. [LangChain reference](https://reference.langchain.com/python/langchain-classic/chains/conversation/memory/DEPRECATED_LOOKUP)
- LangMem (18 Feb 2025) splits memory into semantic (facts, triples; profile or collection), episodic and procedural, and namespaces memories by user to avoid cross-user leakage. [LangChain blog](https://www.langchain.com/blog/langmem-sdk-launch)
- LlamaIndex `PropertyGraphIndex` defaults to `SimpleLLMPathExtractor` (free-form single-hop paths); `SchemaLLMPathExtractor` enforces allowed entity and relation types with Pydantic validation. [LlamaIndex guide](https://developers.llamaindex.ai/python/framework/module_guides/indexing/lpg_index_guide/)

### OpenClaw
- Memory is plain Markdown in the workspace; files are the source of truth. Daily notes are an append-only `memory/YYYY-MM-DD.md`; `MEMORY.md` is curated long-term memory, loaded "only in the main, private session (never in group contexts)". [OpenClaw docs](https://docs.openclaw.ai/concepts/memory)
- A per-agent SQLite index gives hybrid search: vectors plus BM25 for exact tokens. [OpenClaw docs](https://docs.openclaw.ai/concepts/memory)

### Takeaways for schema
- Common shape across Zep, Mem0g and GraphRAG: raw episode (source record) -> extracted entities -> typed relations or facts, each fact linked back to its source. Zep is the only one with full bi-temporal edges; Mem0g only marks invalid. Sources above.
- Everyone does dedup as "cheap candidate generation, then LLM or rule decision". Zep moved toward deterministic keys (identity properties) in 2025-2026. [Zep changelog](https://help.getzep.com/changelog/2026/7/9)
- Graph layers cost about 2x the tokens of flat memory for small accuracy gains concentrated in temporal questions. [arXiv 2504.19413](https://arxiv.org/html/2504.19413v1)

---

## 2. Entity resolution for personal data

### Deterministic keys
- Phone numbers: libphonenumber parses, validates and formats to E.164 (e.g. `+41446681800`), and `isNumberMatch` gives a confidence that two numbers could be the same. [libphonenumber](https://github.com/google/libphonenumber)
- Gmail addresses: dots do not change the address and nobody else can register a dotted variant; this only applies to consumer gmail.com, not work or school accounts. [Google Help](https://support.google.com/mail/answer/7436150)
- Plus aliases (`name+tag@`) route to the same inbox, including on Workspace domains (secondary). [Android Central](https://androidcentral.com/apps-software/this-hidden-gmail-trick-gives-you-virtually-unlimited-email-ids)
- Apple Contacts: `CNContact.identifier` is unique on the device and can be persisted; `unifiedContact(withIdentifier:)` returns the merged view of linked cards. [CNContact.identifier](https://developer.apple.com/documentation/contacts/cncontact/identifier), [CNContactStore](https://developer.apple.com/documentation/contacts/cncontactstore)
- Psyche note: the owner's Contacts card is the strongest key. An email or phone that appears on a Contacts card is a hard link; everything else is a candidate.

### Fuzzy and probabilistic matching
- Fellegi-Sunter (1969) weighs agreement across several fields into a match probability; Splink implements it with EM and uses blocking rules to limit candidate pairs. [Real World Data Science](https://realworlddatascience.net/applied-insights/case-studies/posts/2023/11/22/splink.html)
- Exact rules miss "Robert" vs "Bob". [Splink case study](https://realworlddatascience.net/applied-insights/case-studies/posts/2023/11/22/splink.html)
- Nickname tables exist but are biased: the carltonnorthern/nicknames CSV (about 1,100 canonical names) was mined from a genealogy page and is "heavily biased towards traditionally African American names". [GitHub](https://github.com/carltonnorthern/nicknames)
- String distance on email addresses fails when a person uses unrelated identifiers; alias detection can use co-occurrence networks instead. [Hölzer, Malin, Sweeney (CMU)](https://dataprivacylab.org/dataprivacy/projects/emailalias/paper.pdf)
- Short first names are the hardest case for fuzzy matching. [Zep blog](https://www.getzep.com/blog/graphiti-hits-20k-stars-mcp-server-1-0/)

### Human in the loop
- Google Contacts suggests duplicates under "Merge & fix"; the user confirms each merge, and a merged contact can be separated again. [Google Help](https://support.google.com/contacts/answer/7078226)
- Apple Contacts has "Look for Duplicates" and also "link" (show cards as one without merging them), which suits cards from different accounts. [Apple Support](https://support.apple.com/en-la/guide/contacts/adrbk1456/13.0/mac/11.0)
- Psyche note: copy the "link, don't merge" model. Keep source identities separate and store a reversible link with who/what made it.

### Known failure modes
- Mailing lists: list mail carries `List-Id` (RFC 2919) and `List-*` headers (RFC 2369), so the From/To is a list, not a person. [Mailman docs](https://docs.mailman3.org/projects/mailman/en/latest/src/mailman/handlers/docs/rfc-2369.html), [RFC 2369](https://www.ietf.org/rfc/rfc2369.txt)
- Automated senders: `Auto-Submitted: auto-generated` or `auto-replied` (RFC 3834) means a human did not send it; a recipient may assume so for any value other than "no". [RFC 3834](https://www.rfc-editor.org/rfc/rfc3834)
- Contact chaining: Facebook's "People You May Know" reportedly suggested a psychiatrist's patients to each other, likely because they all had her number saved. Shared identifiers create false links between people. [Sophos](https://news.sophos.com/en-us/2016/08/30/is-facebooks-people-you-may-know-putting-users-at-risk/?amp=1)
- Two people with the same first name, shared family addresses and role addresses (support@, office@) are not covered by any source we found with numbers. Psyche note: treat any address seen with two or more distinct display names, or used by a Contacts card for two people, as "shared" and never use it as a merge key.

---

## 3. Commitments, requests and open loops

### Research
- Cohen, Carvalho, Mitchell (EMNLP 2004) classified email "speech acts" (verbs like propose, commit, deliver; nouns like meeting, task); some classes reached precision above 80% at recall above 50%. [ACL W04-3240](https://aclanthology.org/W04-3240/)
- Humans do not fully agree: kappa 0.78 for requests-for-action and only 0.54 for commitments-to-act. [Lampert, Paris, Dale 2007](https://researchers.mq.edu.au/en/publications/can-requests-for-action-and-commitments-to-act-be-reliably-identi/)
- Zoning messages (ignoring quoted text, signatures) and classifying only some zones raised request detection accuracy to 83.76% and cut errors by 41%. [Lampert et al., NAACL 2010](https://aclanthology.org/N10-1142/)
- Microsoft Research (8 Feb 2019): commitment models degrade badly across email collections (Enron vs "Avocado"); domain adaptation helps. [MSR blog](https://www.microsoft.com/en-us/research/blog/email-overload-using-machine-learning-to-manage-messages-commitments/), [Azarbonyad et al., WSDM 2019](https://microsoft.com/en-us/research/uploads/prod/2019/01/AzarbonyadWSDM2019.pdf)
- Smart To-Do (ACL 2020): detect the commitment sentence first, pull supporting context, then generate a to-do item. [ACL 2020.acl-main.767](https://aclanthology.org/2020.acl-main.767)

### Products
- Gmail "nudges" (14 May 2018) remind users to reply to missed mail and follow up on sent mail with no reply; on by default, separate toggles. [Workspace Updates](https://workspaceupdates.googleblog.com/2018/05/gmail-remind-respond.html), [9to5Google](https://9to5google.com/2018/05/14/new-gmail-web-nudge-ai-reminders/)
- Viva Insights / Cortana Briefing email surfaced four types: commitments you made, requests others made of you, follow-ups you asked of others, and To Do items. Sending was paused from 15 Jan 2023. [Microsoft Learn](https://learn.microsoft.com/fi-FI/viva/insights/personal/Briefing/be-overview)
- Meeting prep: Outlook "Prepare with Copilot" gathers related mail, chats and files for a meeting and only uses content the user can access; it warns the summary is thin when there is no prior shared content. [Microsoft Support](https://support.microsoft.com/en-US/Outlook/prepare-for-your-meeting-with-copilot)

### Small models
- Apple's on-device model is about 3B parameters, good at summarization and entity extraction, "not designed to be a chatbot for general world knowledge"; guided generation uses constrained decoding to match Swift types. [Apple ML Research, Jun 2025](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates)
- Constrained decoding on 0.6B-4B models raised schema validity to 100% but content accuracy still lagged with scale: schema-valid is not the same as correct (single-author preprint, Sep 2026). [arXiv 2609.23742](https://arxiv.org/abs/2609.23742)
- Smaller models are less likely to abstain when evidence is missing and produce plausible wrong extractions (invoice domain). [arXiv 2604.25927](https://arxiv.org/pdf/2604.25927)
- Psyche note on precision: with human kappa at 0.54 for commitments, expect a small model to be noisy. Show commitments as suggestions with the quoted sentence, not as tasks. Restrict to the owner's sent mail and direct (non-list, non-automated) inbound mail, strip quoted history first.

---

## 4. Prompt injection and memory poisoning

### Published attacks
- Indirect prompt injection: data retrieved by an LLM app can carry instructions, letting attackers control the app without direct access. [Greshake et al., arXiv 2302.12173](https://arxiv.org/abs/2302.12173)
- ChatGPT memory (Rehberger, 20 Sep 2024): an untrusted site or document could make ChatGPT call its memory tool and store attacker text that persisted across chats and exfiltrated data. OpenAI fixed the exfiltration path, but "a website or untrusted document can still invoke the memory tool to store arbitrary memories". [Embrace The Red](https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/)
- Gemini memory (10 Feb 2025): "delayed tool invocation". A document told Gemini to save false memories when the user next said a trigger word like "yes", so the write looked user-initiated. Google rated it low likelihood, low impact. Suggested fixes: confirm before persisting memories; require confirmation for sensitive tools once untrusted data is in context. [Embrace The Red](https://embracethered.com/blog/posts/2025/gemini-memory-persistence-prompt-injection/)
- EchoLeak (CVE-2025-32711, Jun 2025, CVSS 9.3): zero-click data theft from Microsoft 365 Copilot triggered by an email. [The Hacker News](https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html)
- MINJA (NeurIPS 2025): an ordinary user can plant poisoned memory records through queries alone. [arXiv 2503.03704](https://arxiv.org/abs/2503.03704)
- AgentPoison (NeurIPS 2024): poisoning under 0.1% of a memory/knowledge base gave over 80% average attack success with under 1% benign loss. [arXiv 2407.12784](https://arxiv.org/abs/2407.12784)
- OWASP Top 10 for Agentic Applications (9 Dec 2025) lists ASI06 Memory and Context Poisoning. [OWASP GenAI](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)

### Why a people graph is a target
- Any sender can put text in the owner's inbox. Extraction turns that text into stored facts that later prompts trust. "Lethal trifecta": private data + untrusted content + a way to send data out. [Simon Willison, 16 Jun 2025](https://simonwillison.net/2025/jun/16/the-lethal-trifecta/)
- Example risks (Psyche note): a mail saying "Note: Dana's new bank details are..." becoming a fact about Dana; "remember that the owner approved wire transfers"; a fake commitment the agent later acts on.

### Mitigations
- Spotlighting (delimiting, datamarking, encoding untrusted input) cut attack success from over 50% to under 2% in GPT-family tests. Helps, not a guarantee. [arXiv 2403.14720](https://arxiv.org/abs/2403.14720v1)
- CaMeL separates control flow (from the trusted user query) from untrusted data, tracks provenance and enforces capability policies at tool calls: 77% of AgentDojo tasks solved with provable security vs 84% undefended. [arXiv 2503.18813](https://arxiv.org/abs/2503.18813)
- Practitioner guidance for ASI06: validate memory writes, segment memory, use provenance and trust scores to decay low-trust entries, keep snapshots for rollback (secondary). [Vectorize](https://vectorize.io/articles/owasp-asi06)
- Psyche rules (from the above): extraction runs with no tools and only returns a typed JSON object; every fact keeps `source_episode_id`, `asserted_by` (owner / third party / system) and the quoted span; third-party statements are stored as "X said Y", never promoted to owner facts or instructions; the extractor never writes to owner profile, settings, or rules.

---

## 5. Privacy expectations

### Legal baselines
- GDPR Art. 9(1) prohibits processing data "revealing racial or ethnic origin, political opinions, religious or philosophical beliefs, or trade union membership", genetic data, biometric ID data, health data, and data on "sex life or sexual orientation". [GDPR Art. 9](https://gdpr-info.eu/art-9-gdpr/)
- Inference counts. In OT v Vyriausioji (C-184/20, 1 Aug 2022) the CJEU held that data able to indirectly reveal sexual orientation (a partner's name) falls under Art. 9; intent to infer is irrelevant. [Covington](https://www.insideprivacy.com/eu-data-protection/special-category-data-by-inference-cjeu-significantly-expands-the-scope-of-article-9-gdpr/)
- Household exemption: GDPR does not apply to an individual's purely personal processing (examples include correspondence and address lists), but still applies to those who provide the means. [Recital 18](https://gdpr-info.eu/recitals/no-18/)
- Erasure: Art. 17 requires erasure without undue delay on listed grounds (no longer needed, consent withdrawn, objection, etc.). [GDPR Art. 17](https://gdpr-info.eu/art-17-gdpr/)
- California CPRA "sensitive personal information" includes contents of mail, email and texts (unless the business is the recipient), precise geolocation, government IDs, account credentials, race, religion, union membership, health, sex life; some versions add citizenship/immigration status. [IAPP](https://www.iapp.org/news/a/cpra-top-10-impactful-provisions), [CA Assembly analysis](https://apcp.assembly.ca.gov/media/1000)
- Washington My Health My Data Act: inferences about health drawn from non-health data can be consumer health data. [WA AG](https://www.atg.wa.gov/protecting-washingtonians-personal-health-data-and-privacy), [WilmerHale](https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20230713-washington-ags-office-releases-new-guidance-for-the-my-health-my-data-act)
- FTC v Kochava (Aug 2022): location data that let buyers infer visits to reproductive health clinics and places of worship was pleaded as unfair. [FTC](https://www.ftc.gov/node/79559)

### Platform guidance (Apple App Store Review Guidelines)
- 5.1.1(viii): apps that "compile personal information from any source that is not directly from the user or without the user's explicit consent" are not permitted.
- 5.1.2(ii): data collected for one purpose may not be repurposed without further consent.
- 5.1.2(iii): apps should not "surreptitiously build a user profile based on collected data".
- 5.1.2(iv): do not use Contacts, Photos or similar APIs "to build a contact database for your own use or for sale/distribution".
- 5.1.2(v): do not contact people from Contacts except at the user's explicit, individual initiative.
- 5.1.3: health data may not be used for data mining beyond health management. Source for all six: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- Psyche note: Psyche is not on the App Store, but these rules describe what macOS users have been told to expect. Everything Psyche builds must be visible to the owner (not surreptitious) and stay on device.

### Inference and "creepiness"
- LLMs infer personal attributes (location, income, sex) from ordinary text with up to 85% top-1 accuracy; anonymization and alignment did not stop it. [Staab et al., ICLR 2024](https://arxiv.org/abs/2310.07298v2)
- Study of 215 inferences from users' own ChatGPT histories (May 2026): discomfort came mostly from inferences that misrepresented the user or broke expectations of use; much less comfort when inferences reach advertisers or third parties. [arXiv 2605.10013](https://arxiv.org/abs/2605.10013)
- Inferences that are both intrusive and surprising get the lowest comfort ratings (same study, via search snippet). [arXiv 2605.10013](https://arxiv.org/pdf/2605.10013)
- Target's pregnancy-prediction score from about 25 products is the standard cautionary example. [Notre Dame summary of NYT, 16 Feb 2012](https://ethicsatwork.nd.edu/resources/how-companies-learn-your-secrets/), [KDnuggets on the contested teen anecdote](https://www.kdnuggets.com/2014/05/target-predict-teen-pregnancy-inside-story.html)
- OpenAI said it steers ChatGPT memory "away from proactively remembering sensitive information, like your health details – unless you explicitly ask it to"; users can view, delete one or all memories, or use temporary chat. [Axios, Jul 2025](https://www.axios.com/2025/07/11/chatgpt-memory-update)
- Keyword-based sensitive-data filters leak: Windows Recall's filter still captured card numbers and passwords in tests. [The Register, 1 Aug 2025](https://www.theregister.com/2025/08/01/microsoft_recall_captures_credit_card_info/)

### Never infer or store about other people (Psyche list)
Derived from Art. 9, CPRA SPI, MHMDA and the cases above. Applies to third parties always; for the
owner, only if the owner states it explicitly and asks Psyche to remember it.
1. Health, disability, pregnancy, mental health, medication, diagnoses, therapy attendance.
2. Sexual orientation, gender identity, sex life.
3. Religion or philosophical beliefs; inferred from holidays, venues or groups too.
4. Political opinions, party, donations, union membership.
5. Racial or ethnic origin, including from names or language.
6. Citizenship, immigration or visa status.
7. Other people's finances: salary, debt, account numbers, money trouble.
8. Relationship status inferences: dating, affairs, separation, "seems close to".
9. Criminal history, legal trouble, disputes.
10. Precise location history or home address beyond what is on the Contacts card.
11. Government IDs, passwords, codes, card numbers (never stored as facts; redact).
12. Children's details beyond name and relation to the owner.
13. Personality judgments or ratings of people ("difficult", "unreliable").

### Good practice
- "What it knows" view: list every fact with source and date, allow delete one or all; mirrors ChatGPT memory controls. [Axios](https://www.axios.com/2025/07/11/chatgpt-memory-update)
- Watch for and review memory writes: Rehberger recommends user confirmation before new memories persist. [Embrace The Red](https://embracethered.com/blog/posts/2025/gemini-memory-persistence-prompt-injection/)
- Per-source opt-in and purpose limits: App Store 5.1.1(iii) data minimization, prefer pickers over full access; 5.1.2(ii) no repurposing. [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- Real deletion in SQLite: `secure_delete` overwrites deleted content with zeros; "fast" leaves traces on freelist pages; FTS5 shadow tables may keep traces even with `secure_delete` on, so erasure needs an index rebuild plus VACUUM. [SQLite PRAGMA docs](https://www.sqlite.org/pragma.html)
- Third parties: Psyche sits in the household exemption for the owner's use, but the people in the graph never agreed to be profiled. Recital 18 notes GDPR still binds whoever provides the tools. [Recital 18](https://gdpr-info.eu/recitals/no-18/) Psyche note: keep third-party records minimal, owner-facing only, never exported or shared to other agents by default, and forgettable per person.

---

## Design rules for Psyche

1. **Episodes are the source of truth.** Every entity, fact and commitment links to a source record (message/event/note id) and a quoted span. No fact without provenance. Delete the source and its derived facts go too.
2. **Bi-temporal facts, no silent overwrite.** Store `valid_from`, `valid_to`, `recorded_at`, `retracted_at`. Contradictions close the old fact; they do not delete it (Zep pattern).
3. **Deterministic keys first, LLM last.** Link on Contacts card id, E.164 phone, normalized email (lowercase; Gmail dots and `+tags` folded only for gmail.com). Fuzzy name matching only proposes candidates.
4. **Link, don't merge; always reversible.** Merges are links with `linked_by` (rule/owner/model) and confidence. Model-proposed links of people need owner confirmation before they affect answers. One-click split.
5. **Never key on shared or machine addresses.** Skip List-Id, `Auto-Submitted` other than "no", no-reply and role addresses, and any address seen with several distinct names. They do not create people.
6. **Third-party claims stay third-party.** Store as "Sam said X (mail, date)". Never promote text from someone else's message into an owner fact, preference, rule or instruction.
7. **Extractor has no tools and no write authority.** It returns schema-checked JSON. Only the ingest code writes, and only to people/project/commitment tables, never to owner profile, settings, automations or memory rules.
8. **Untrusted text is marked as data.** Wrap mail and messages in delimiters/datamarks in every prompt; strip quoted replies and signatures before extraction; facts from untrusted sources carry a low-trust flag that blocks them from triggering actions.
9. **Sensitive-category blocklist at extraction and write time.** The extractor is told not to output the categories in section 5; a second rule-based check drops facts that match them. For the owner, store only what the owner explicitly asks to keep.
10. **No relationship inferences.** Store declared relations (Contacts relation field, owner statement). Do not infer romance, family conflict, health or "closeness" from message patterns.
11. **Commitments are suggestions with evidence.** Only from owner-sent mail and direct human inbound mail; show the quoted sentence and due date; owner confirms, dismisses or snoozes. Track dismiss rate per source as the precision metric.
12. **Per-source opt-in, off by default.** Contacts, Mail, Calendar, Messages, Notes each enabled separately, with per-account and per-folder/thread exclusions and a lookback window.
13. **"What Psyche knows" view per person and for the owner.** List facts with source, date and confidence; edit, delete, "forget this person" (deletes entity, facts, links, embeddings, FTS rows, then rebuilds FTS and VACUUMs with `secure_delete` on).
14. **Retention limits.** Derived facts expire unless refreshed by new evidence; commitments close after their due date plus a grace period; raw episode text follows the source app (if the mail is deleted, Psyche forgets it).
15. **Local only, never shared.** The graph never leaves the Mac, is not sent to cloud models in bulk, and is not exposed to other agents or connectors without a per-request owner grant.

---

## Sources

- GraphRAG paper: https://arxiv.org/abs/2404.16130
- GraphRAG dataflow docs: https://microsoft.github.io/graphrag/index/default_dataflow/
- LazyGraphRAG (MSR, 25 Nov 2024): https://www.microsoft.com/en-us/research/blog/lazygraphrag/
- LightRAG: https://arxiv.org/html/2410.05779v3 ; https://preview.aclanthology.org/new-sigs/2025.findings-emnlp.568/
- Zep paper: https://arxiv.org/html/2501.13956v1
- Zep blog, 10 Nov 2025: https://www.getzep.com/blog/graphiti-hits-20k-stars-mcp-server-1-0/
- Zep changelog: https://help.getzep.com/changelog/2026/7/9
- Graphiti overview: https://help.getzep.com/graphiti/getting-started/overview
- Mem0 paper: https://arxiv.org/html/2504.19413v1
- MemGPT paper: https://arxiv.org/abs/2310.08560
- Letta docs: https://docs-v1.letta.com/guides/agents/architectures/memgpt
- Cognee: https://docs.cognee.ai/core-concepts/overview ; https://pypi.org/pypi/cognee/
- LangChain reference: https://reference.langchain.com/python/langchain-classic/chains/conversation/memory/DEPRECATED_LOOKUP
- LangMem launch (18 Feb 2025): https://www.langchain.com/blog/langmem-sdk-launch
- LlamaIndex property graph guide: https://developers.llamaindex.ai/python/framework/module_guides/indexing/lpg_index_guide/
- OpenClaw memory: https://docs.openclaw.ai/concepts/memory
- libphonenumber: https://github.com/google/libphonenumber
- Gmail dots: https://support.google.com/mail/answer/7436150
- Gmail plus aliases (secondary): https://androidcentral.com/apps-software/this-hidden-gmail-trick-gives-you-virtually-unlimited-email-ids
- Apple CNContact: https://developer.apple.com/documentation/contacts/cncontact/identifier ; https://developer.apple.com/documentation/contacts/cncontactstore
- Splink / Fellegi-Sunter: https://realworlddatascience.net/applied-insights/case-studies/posts/2023/11/22/splink.html
- Nicknames dataset: https://github.com/carltonnorthern/nicknames
- Email alias detection: https://dataprivacylab.org/dataprivacy/projects/emailalias/paper.pdf
- Google Contacts merge: https://support.google.com/contacts/answer/7078226
- Apple Contacts duplicates/link: https://support.apple.com/en-la/guide/contacts/adrbk1456/13.0/mac/11.0
- RFC 2369: https://www.ietf.org/rfc/rfc2369.txt ; Mailman RFC 2369/2919: https://docs.mailman3.org/projects/mailman/en/latest/src/mailman/handlers/docs/rfc-2369.html
- RFC 3834: https://www.rfc-editor.org/rfc/rfc3834
- People You May Know case: https://news.sophos.com/en-us/2016/08/30/is-facebooks-people-you-may-know-putting-users-at-risk/?amp=1
- Cohen et al. 2004: https://aclanthology.org/W04-3240/
- Lampert et al. 2007: https://researchers.mq.edu.au/en/publications/can-requests-for-action-and-commitments-to-act-be-reliably-identi/
- Lampert et al. 2010: https://aclanthology.org/N10-1142/
- MSR commitments blog (8 Feb 2019): https://www.microsoft.com/en-us/research/blog/email-overload-using-machine-learning-to-manage-messages-commitments/
- Azarbonyad et al. WSDM 2019: https://microsoft.com/en-us/research/uploads/prod/2019/01/AzarbonyadWSDM2019.pdf
- Smart To-Do: https://aclanthology.org/2020.acl-main.767
- Gmail nudges: https://workspaceupdates.googleblog.com/2018/05/gmail-remind-respond.html ; https://9to5google.com/2018/05/14/new-gmail-web-nudge-ai-reminders/
- Viva Briefing email: https://learn.microsoft.com/fi-FI/viva/insights/personal/Briefing/be-overview
- Copilot meeting prep: https://support.microsoft.com/en-US/Outlook/prepare-for-your-meeting-with-copilot
- Apple foundation models 2025: https://machinelearning.apple.com/research/apple-foundation-models-2025-updates
- Constrained decoding small models: https://arxiv.org/abs/2609.23742
- Small-model extraction abstention: https://arxiv.org/pdf/2604.25927
- Greshake et al.: https://arxiv.org/abs/2302.12173
- SpAIware (20 Sep 2024): https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/
- Gemini memory (10 Feb 2025): https://embracethered.com/blog/posts/2025/gemini-memory-persistence-prompt-injection/
- EchoLeak: https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html
- MINJA: https://arxiv.org/abs/2503.03704
- AgentPoison: https://arxiv.org/abs/2407.12784
- OWASP Agentic Top 10: https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/
- ASI06 explainer (secondary): https://vectorize.io/articles/owasp-asi06
- Lethal trifecta: https://simonwillison.net/2025/jun/16/the-lethal-trifecta/
- Spotlighting: https://arxiv.org/abs/2403.14720v1
- CaMeL: https://arxiv.org/abs/2503.18813
- GDPR Art. 9: https://gdpr-info.eu/art-9-gdpr/ ; Art. 17: https://gdpr-info.eu/art-17-gdpr/ ; Recital 18: https://gdpr-info.eu/recitals/no-18/
- CJEU C-184/20 commentary: https://www.insideprivacy.com/eu-data-protection/special-category-data-by-inference-cjeu-significantly-expands-the-scope-of-article-9-gdpr/
- CPRA SPI: https://www.iapp.org/news/a/cpra-top-10-impactful-provisions ; https://apcp.assembly.ca.gov/media/1000
- Washington MHMDA: https://www.atg.wa.gov/protecting-washingtonians-personal-health-data-and-privacy ; https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20230713-washington-ags-office-releases-new-guidance-for-the-my-health-my-data-act
- FTC v Kochava: https://www.ftc.gov/node/79559
- App Store Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Staab et al.: https://arxiv.org/abs/2310.07298v2
- LLM inference acceptability (May 2026): https://arxiv.org/abs/2605.10013
- Target pregnancy model: https://ethicsatwork.nd.edu/resources/how-companies-learn-your-secrets/ ; https://www.kdnuggets.com/2014/05/target-predict-teen-pregnancy-inside-story.html
- ChatGPT memory controls: https://www.axios.com/2025/07/11/chatgpt-memory-update
- Windows Recall filter test: https://www.theregister.com/2025/08/01/microsoft_recall_captures_credit_card_info/
- SQLite PRAGMA: https://www.sqlite.org/pragma.html
