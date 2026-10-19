# @psyche/connectors

**Owner:** S09 (`prompts/s09-mcp-connectors.md`). Features M4 (directory data), M5 (Google), M8 (web search and fetch), M11 (action matrices) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md). Later: M6 Microsoft, M7 IMAP / JMAP, M10 shopping helpers.

First-party connectors behind one framework: a `Connector` interface, a `ConnectorRegistry` that enforces the owner's action matrix and scope mode, a catalogue for the Connectors directory, and `connectors.*` API handlers for the Gateway.

## Public API

- **Framework** (`src/framework/`): `ConnectorRegistry` (`catalogue`, `list`, `get`, `connect`, `disconnect`, `remove`, `status`, `setMatrix`, `sync`, `permissionRows`, `instance`), `MemoryConnectorStore`, the types in `types.ts`, `bindingHash` / `canonicalJSON` (security §3.5), `startLoopback` / `createPkce` (installed-app OAuth), `REMOTE_MCP_PRESETS` (Slack, Notion, Linear, GitHub) and `VERIFIED_MCP_HOSTS`, `COMING_SOON`.
- **Gateway API**: `connectorHandlers(registry)` and `CONNECTOR_METHODS` for `connectors.catalogue | list | get | connect | disconnect | status | setMatrix`.
- **Web** (`src/web/`): `safeFetch`, `vetUrl`, `checkAddress`, `htmlToMarkdown`; search providers `braveProvider`, `exaProvider`, `tavilyProvider`, `searxngProvider`; factories `webSearchFactory` / `webFetchFactory`.
- **Google** (`src/google/`): `googleFactory({ openBrowser, approveSecret? })`, `GOOGLE_CATALOGUE`, `GOOGLE_ACTIONS`, and the Gmail / Calendar / Drive clients.

## How the registry enforces policy

Tools register into the agent-core `ToolRegistry` as `mcp__<connectorId>__<tool>`, the same naming as MCP tools, so allow / ask / deny rules look the same everywhere (ToolSpec contract). Each registration carries `describeCall`, which gives the broker the approval kind, target, binding fields and grant key for that call. The executor wrapper then:

1. refuses `deny` rows (`policy_denied`) and write tools on a read-only connection. Read-only connections don't even register write tools;
2. refuses an `ask` row with no approval when an `approvalFor` resolver is wired (`approval_required`);
3. re-checks the approval right before dispatch with `PermissionBroker.verifyBinding(approvalId, bindingHash(kind, bindingFields))`, failing `binding_mismatch` if the arguments changed;
4. records a receipt for every write: `ok`, `failed`, or `uncertain` when the call threw mid-flight.

`setMatrix` refuses unknown actions, and refuses `allow` on `destructive` / `financial` rows (security §3.4: no standing grants). The registry emits `invalidated` when the account behind a connection changes, when a connection is narrowed to read-only, disconnected, or its token is revoked. Tasks and approvals bound to that connection must be dropped (M5).

## Writing a connector

1. Write a `CatalogueEntry`: `type`, `id`, label, `auth`, scopes per mode, and the `actions` matrix rows with their `sideEffect`, `approvalKind` and `defaultRule` (`ask` for anything that sends or changes data; never `allow` for destructive rows).
2. Implement `Connector`:
   - `connect` runs the sign-in and returns the account and scopes. Tokens go to `ctx.tokens` (vault), never into `config`; secrets in config are `{{cred:slug}}` placeholders resolved through `ctx.credentials` with an approval.
   - `tools()` returns `ConnectorTool`s, each tagged with its matrix `action`. Write tools implement `describeCall` with the security §3.5 binding fields for their kind.
   - Tool outputs are `provenance: "untrusted"` whenever they contain third-party content.
   - Use `ctx.fetch` for every network call, so tests run on recorded fixtures.
   - `sync(cursor)` returns the next cursor (stored as `lastSync`); `health()` probes cheaply.
3. Export a `ConnectorFactory` and pass it to `ConnectorRegistry({ factories })`.
4. Tests: recorded response fixtures through a fake `fetch` (see `test/google/fake-google.ts`), `assertNoSecrets` over outputs, records and events, a binding-mismatch case for every write tool, and no network.

## Google setup guide (M5)

The owner creates their own Desktop OAuth client. The steps and copy are in [docs/copy/onboarding.md "Setting up Google"](../../docs/copy/onboarding.md#setting-up-google):

1. Create a Google Cloud project, and enable the Gmail API, the Google Calendar API and the Google Drive API.
2. Google Auth Platform → Branding: set the audience to **External**. Under Audience, **Publish app** so its status is **In production**. Leaving it in **Testing** makes Google expire refresh tokens 7 days after consent. In production, an unverified app used only by its owner falls under Google's personal-use exemption (fewer than 100 users) and needs no verification or CASA assessment. The owner clicks through the "unverified app" screen once.
3. Clients → Create client → **Desktop app**. Psyche needs the client id. Store the client secret in the vault and pass it as `{{cred:<slug>}}`; Google desktop secrets are not confidential, but they still never go in config.
4. Connect with `connectors.connect { catalogueId: "google", scopeMode, config: { clientId, clientSecret?, gmailScopes? } }`. Psyche opens Google's consent page and receives the code on `http://127.0.0.1:<random port>/callback`. It checks `state`, verifies PKCE S256 and requests `access_type=offline`.

Scopes:
- `read_act`: `gmail.modify` (or `gmail.readonly` + `gmail.send` with `gmailScopes: "readonly_send"`, which drops labelling), `calendar`, `drive.file`.
- `read`: `gmail.readonly`, `calendar.readonly`, `drive.file`.

A grant that lacks a requested scope fails the connect. A refresh token that dies roughly 7 days after consent is reported as the Testing-mode expiry (copy in docs/copy/system-messages.md). Any other revocation moves the connector to `needs_auth` and emits `invalidated`.

Tools: `gmail_search_threads`, `gmail_read_thread` (text/plain preferred; HTML stripped of hidden elements, scripts and comments), `gmail_list_labels`, `gmail_save_attachment` (to the Library, 25 MB limit), `gmail_modify_labels`, `gmail_create_draft`, `gmail_send` (`send_email` binding: account, recipients lowercased and sorted, subject, body hash), `calendar_list_calendars`, `calendar_list_events` (bounded, at most 366 days), `calendar_free_busy`, `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` (`calendar_write` binding; delete is `destructive`), `drive_download` (Google Docs exported as PDF), `drive_upload` (text).

Sync (`registry.sync(id)`, run by the Gateway every 1–5 min):
- Gmail: `history.list` from the saved `historyId`. A 404 triggers a full resync of recent inbox messages.
- Calendar: `events.list` with the saved `syncToken`. A 410 triggers a full sync.
- The cursor is `{ gmail: { historyId }, calendars: { <id>: syncToken }, newMessageIds }`.

Parsing hardening (`src/google/mime.ts`) caps part depth (16), part count (300) and body text (200k characters). Undecodable parts and unknown charsets produce warnings instead of errors. Attachment names are sanitized, and attachments over 25 MB are listed but never downloaded. Outgoing MIME refuses line breaks in headers and validates addresses (no header injection), and RFC 2047-encodes non-ASCII subjects.

## Web search and fetch (M8)

- `safeFetch(url)` allows http(s) only. It resolves the host and refuses loopback, private, link-local (including `169.254.169.254`), CGNAT, multicast, IPv4-mapped IPv6 and `localhost` / `.internal` / `.local` names, then connects to the exact address it checked (DNS-rebinding guard). Redirects are followed manually (at most 5, each re-vetted, no https→http downgrade). The body is capped at 5 MB, the Markdown at about 200k characters, and the default timeout is 20 s. HTML becomes Markdown via `turndown` with scripts, forms and hidden elements dropped; JSON is fenced; binary is refused. Results are `untrusted`.
- Search providers are Brave, Exa, Tavily and SearXNG (local instances need the owner's explicit `privateAllowlist`). API keys are `{{cred:slug}}` placeholders resolved per call for the provider's origin only, and they never appear in results or errors.

## Stubbed / not yet

- Persistence: `ConnectorStore` is in memory. The `connectors` table needs a migration plus `schema.ts` from S01 (docs/status/s09.md).
- Token storage: `TokenVault` is injected and needs the S06 vault write API.
- `connectors.*` beyond `list` / `get` are not in packages/protocol yet. `CONNECTOR_METHODS` is the proposal for a `protocol:` PR.
- Drive upload takes text content only. Uploading Library items needs a Library reader (S13).
- Gmail attachments on outgoing mail (the builder supports them; no tool exposes them yet), Microsoft Graph (M6), IMAP / JMAP (M7), shopping helpers (M10).
