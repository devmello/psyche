-- Scheduled automations as specialists (docs/agent/specialists-2026.md §4.10; #683).
-- `automations.specialist`: the optional {role, budget?, deliver?} JSON. When set, each run of
-- the automation is an unattended specialist job instead of a plain Task.
ALTER TABLE automations ADD COLUMN specialist TEXT
  CHECK (specialist IS NULL OR (json_valid(specialist) AND json_type(specialist) = 'object'));
