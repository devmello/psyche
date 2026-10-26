-- Voice conversation (owner: S17). docs/voice/voice-mode-2026.md §7: `Message.via` marks a message
-- the owner spoke ("voice"), for the waveform glyph; NULL for typed messages.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

ALTER TABLE messages ADD COLUMN via TEXT;
