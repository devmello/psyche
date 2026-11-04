-- Memory for everything: the source behind a conversation gist (owner: S07, packages/memory).
-- docs/design/memory-everything-2026.md §2.6 and docs/roadmap/future-features.md §1.
--
-- graph_interactions.gist_doc_id is the search document id of the passage the gist was written
-- from (a mail message, a Messages conversation day, a calendar event), set when the gist is
-- stored. It is a pointer only: the Gateway resolves it, and checks the caller may open it,
-- before any client sees it. Gists stored before this have none and show no source chip.

ALTER TABLE graph_interactions ADD COLUMN gist_doc_id TEXT;
