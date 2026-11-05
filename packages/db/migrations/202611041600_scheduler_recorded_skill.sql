-- Scheduled runs of a skill made from a recording (docs/design/teach-by-showing-2026.md §8).
-- `automations.recorded_skill`: the {skill} JSON. Set only when the owner schedules the skill from
-- the Psyche app; such a run uses the normal approvals, stops on a changed page and never does a
-- sensitive or ask-each-time step. No update path writes this column.
ALTER TABLE automations ADD COLUMN recorded_skill TEXT
  CHECK (recorded_skill IS NULL OR (json_valid(recorded_skill) AND json_type(recorded_skill) = 'object'));
