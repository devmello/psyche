-- S02 (background specialists, docs/agent/specialists-2026.md §7.1): the `specialist` block of a
-- Task that is a specialist's job, as JSON (`SpecialistSpec`: role, parent ids, model, tools,
-- permission mode, budget, deadline, inputs, delivery, result). NULL for every other task.
ALTER TABLE tasks ADD COLUMN specialist TEXT;
