-- An automation made from a tainted turn keeps that taint (security §3.6).
-- `automations.taint_sources`: the TaintSource[] JSON of the turn that created it. Every run starts
-- tainted with these sources. Only `schedule.create` writes it, at creation; no update clears it.
ALTER TABLE automations ADD COLUMN taint_sources TEXT
  CHECK (taint_sources IS NULL OR (json_valid(taint_sources) AND json_type(taint_sources) = 'array'));
