-- The teaching loop (T1, #679; docs/agent/teaching-loop-2026.md §5.1, §7): the lessons the
-- Gateway put in an answer's prompt ("Used 2 lessons"). JSON array of LessonRef; NULL when none.
-- Filled by the Gateway after each run, never by a client. Owner of the table: S01.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

ALTER TABLE messages ADD COLUMN lessons_applied TEXT;
