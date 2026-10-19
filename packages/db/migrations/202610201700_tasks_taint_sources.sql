-- S04 tasks: the creating turn's taint sources (S23 design-08; architecture §4.6). A Task
-- created in a tainted turn keeps the sources for its whole life, so every run starts tainted
-- with them and its approval cards name the origins. JSON array of TaintSource, NULL when the
-- creating turn was not tainted.
ALTER TABLE tasks ADD COLUMN taint_sources TEXT
  CHECK (taint_sources IS NULL OR (json_valid(taint_sources) AND json_type(taint_sources) = 'array'));
