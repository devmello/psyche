-- Night shift W1 (docs/design/night-shift-2026.md §2.2; fork-a-plan-2026.md §3.1): the `staging`
-- block of a task whose run only prepares changes, as JSON: {"kind":"night","nightId"} or
-- {"kind":"fork","forkId","branchId"}. Set by the server when it creates the task, never by a
-- client. NULL for every other task.
ALTER TABLE tasks ADD COLUMN staging TEXT CHECK (staging IS NULL OR json_valid(staging));
