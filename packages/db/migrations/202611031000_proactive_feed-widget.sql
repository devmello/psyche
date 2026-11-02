-- A static widget snapshot on a Feed post (generative-ui-2026 §8, D8): the spec and its taint,
-- JSON, no bindings. Only Psyche's own producers (and later the agent) write it.
ALTER TABLE feed_posts ADD COLUMN widget TEXT CHECK (widget IS NULL OR json_valid(widget));
