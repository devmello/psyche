---
"@psyche/connectors": minor
"@psyche/db": minor
"@psyche/gateway": minor
---

Google connect flow (#505): `connectors.connect` answers at once with the pending consent page and finishes as `connectors.updated`; durable connector records (`connectors` table, `SqliteConnectorStore`) restored at boot; the owner's OAuth client from `connectors.google` in `config.json` or `PSYCHE_GOOGLE_CLIENT_*` (secret only as a vault placeholder). Guide: docs/guides/connectors-google.md.
