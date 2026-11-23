-- Citations for canvas artifacts (docs/design/chat-experience-2026.md): the sources the agent
-- drew on when it made the artifact, as a JSON array of AnswerSource. Set at creation only;
-- NULL for artifacts made before this column existed and for the owner's own.
ALTER TABLE artifacts ADD COLUMN sources TEXT;
