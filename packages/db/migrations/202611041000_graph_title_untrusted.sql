-- Memory for everything: who wrote an item's title (owner: S07, packages/memory).
-- docs/design/memory-everything-2026.md §7.1 W3, W4.
--
-- graph_entities.title_untrusted is 1 when the name came from someone else's text: an accepted
-- suggestion (Track on a calendar invite, a shared Reminders list, a work sender), a rule over an
-- untrusted source, or an ingested contact. The owner creating the item, or renaming it, makes it 0.
-- A title is only ever inlined into a chat message, a context card or a thread name when it is 0.
-- Rows that exist now cannot be told apart, so they start untrusted (safe: they are quoted and
-- taint a chat about them) until the owner renames them.

ALTER TABLE graph_entities ADD COLUMN title_untrusted INTEGER NOT NULL DEFAULT 1 CHECK (title_untrusted IN (0, 1));
