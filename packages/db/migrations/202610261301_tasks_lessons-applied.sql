-- The teaching loop (T1, #679; docs/agent/teaching-loop-2026.md §5.1, §7): the lessons the
-- Gateway put in a task's run prompts, accumulated across runs. JSON array of LessonRef; NULL
-- when none. Filled by the Gateway after each run. Owner of the table: S04.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

ALTER TABLE tasks ADD COLUMN lessons_applied TEXT;
