-- People graph blocklist (owner: S07). docs/memory/people-and-projects-2026.md §4.9: a masked hint
-- ("s•••@acme.com"; a domain whole) so Settings can show what is blocked; the value stays hashed.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

ALTER TABLE graph_blocklist ADD COLUMN hint TEXT;
