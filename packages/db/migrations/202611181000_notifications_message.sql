-- Gateway-authored notices as message ids plus values (JSON), so clients word them in their own
-- language. `title` and `body` stay the English fallback. Null for notices without ids.
ALTER TABLE notifications ADD COLUMN message TEXT CHECK (message IS NULL OR json_valid(message));
