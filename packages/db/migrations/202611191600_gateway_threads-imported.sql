-- Threads brought over from a claude.ai or ChatGPT export: read-only, archived, flagged by source.
-- `import_key` is "<source>:<conversation id>" so importing the same export again adds nothing.
ALTER TABLE threads ADD COLUMN imported TEXT CHECK (imported IS NULL OR imported IN ('claude', 'chatgpt'));
ALTER TABLE threads ADD COLUMN import_key TEXT;
CREATE UNIQUE INDEX threads_import_key ON threads(import_key) WHERE import_key IS NOT NULL;
