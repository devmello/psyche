-- Scheduled runs retry a transient model-provider error (429, 5xx, overloaded) up to three times.
-- `attempt` counts the retries already made; `retry_at` is set while the run waits for its next
-- attempt (the run stays `running`, so Scheduled shows "Retrying at HH:MM" and the Mac stays awake).
ALTER TABLE automation_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN retry_at TEXT;
