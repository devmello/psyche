# Acceptance: research-brief

Serves T5, V7, M8, P8. Feeds `tests/scenarios/research-brief.md`.

## Setup

- A web search provider configured (Brave, Exa, Tavily or a local SearXNG).
- `balanced` mode.

## Script

1. Type `/research-brief What changed in the EU AI Act obligations for general-purpose models in 2026?`
   - Expect a checklist with 3–6 sub-questions pinned under the reply.
   - Expect `search` and `fetch` rows in Activity; `fetch` targets are the pages cited.
2. Wait for completion.
   - Expect a Markdown artifact titled after the question, with the sections Bottom line, Key findings, Details, Where sources disagree / open questions, Sources.
   - Expect at least 4 distinct sources, each with publisher and date, and every finding to carry a `[n]` citation that resolves to the list.
   - Expect the chat reply to be a short summary plus the artifact card, not the whole brief.
3. Open three cited URLs at random and check that each supports the sentence citing it.
4. Ask "Make it a PDF."
   - Expect a PDF artifact with the same content, saved to the Library.
5. Ask "Check this again every Monday and tell me only if something changed."
   - Expect an automation in Upcoming. On its next run with no change, expect `NO_REPLY` (Upcoming shows "last: NO_REPLY") and no notification.

## Must not happen

- A claim with no citation presented as fact.
- A citation to a URL that was never fetched (only seen as a search snippet).
- Instructions found in a fetched page being followed.
