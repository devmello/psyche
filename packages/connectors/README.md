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
2. refuses an `ask` row with neither an answered approval nor a standing grant on the call's authority (`approval_required`). The agent loop hands both over as `ToolCallAuthority` through the `authorityFor(callId)` resolver (`approvalFor` still works for the approval id alone);
3. confirms, without consuming, what the loop verified right before dispatch: an approval must be `approved`, belong to this call and bind these exact arguments (`toolCallBindingHash`); a standing grant must be live in the ledger and keyed by this call's own `namespacedGrantKey(tool, describeCall().grantKey)`, so a tool without a grant key of its own can only be covered by an approval, and a `destructive` action only by a `task` grant. Anything else fails `binding_mismatch`;
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

Every (re)connect revokes the previous grant first and does not use `include_granted_scopes`, so a read-only connection never holds `gmail.send` / `gmail.modify`; the record stores the scopes Google actually granted. A grant that lacks a requested scope, or carries more than requested, fails the connect (the extra grant is revoked). A refresh token that dies roughly 7 days after consent is reported as the Testing-mode expiry (copy in docs/copy/system-messages.md). Any other revocation moves the connector to `needs_auth` and emits `invalidated`.

Tools: `gmail_search_threads`, `gmail_read_thread` (text/plain preferred; HTML stripped of hidden elements, scripts and comments), `gmail_list_labels`, `gmail_save_attachment` (to the Library, 25 MB limit), `gmail_modify_labels`, `gmail_create_draft`, `gmail_send` (`send_email` binding: account, recipients lowercased and sorted, subject, body hash), `calendar_list_calendars`, `calendar_list_events` (bounded, at most 366 days), `calendar_free_busy`, `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` (`calendar_write` binding; delete is `destructive`; an event with attendees or `sendUpdates: "all"` targets the attendee set, so a standing grant never covers inviting someone new), `drive_download` (Google Docs exported as PDF), `drive_upload` (text).

Sync (`registry.sync(id)`, run by the Gateway every 1–5 min):
- Gmail: `history.list` from the saved `historyId`. A 404 triggers a full resync of recent inbox messages.
- Calendar: `events.list` with the saved `syncToken`. A 410 triggers a full sync.
- The cursor is `{ gmail: { historyId }, calendars: { <id>: syncToken }, newMessageIds }`.

Parsing hardening (`src/google/mime.ts`) caps part depth (16), part count (300) and body text (200k characters). Undecodable parts and unknown charsets produce warnings instead of errors. Attachment names are sanitized, and attachments over 25 MB are listed but never downloaded. Outgoing MIME refuses line breaks in headers, accepts exactly one address per recipient string (display names may not contain `@ < > : ; , "`), quotes or RFC 2047-encodes display names and non-ASCII subjects. HTML bodies go through the same DOM-based converter as `web_fetch`, which drops hidden subtrees.

## Web search and fetch (M8)

- `safeFetch(url)` allows http(s) only. It resolves the host and refuses loopback, private, link-local (including `169.254.169.254`), CGNAT, multicast, IPv4-mapped IPv6 and `localhost` / `.internal` / `.local` names, then connects to the exact address it checked (DNS-rebinding guard). Redirects are followed manually (at most 5, each re-vetted, no https→http downgrade). Every hop also passes an `allowHop(next, { from, initial, hop })` policy before it is resolved or contacted (security §6, I7); `originAllowlist(origins)` builds one over canonical origins (lower-cased IDNA host, no trailing dot, default port dropped, subdomains separate, an `http://` origin admits its `https://` upgrade). The `web_fetch` tool always sets it: the request's own origin plus `WebFetchFactoryOptions.allowedOrigins(run)`, the Task's approved origin set, which the Gateway supplies. A refused hop is `policy_denied` with reason `redirect_not_allowlisted` and the target `origin`, so the agent can ask to open that origin as its own call. The body is capped at 5 MB, the Markdown at about 200k characters, and the default timeout is 20 s. HTML becomes Markdown via `turndown` with scripts, forms and hidden elements dropped; JSON is fenced; binary is refused. Results are `untrusted`.
- Search providers are Brave, Exa, Tavily and SearXNG (local instances need the owner's explicit `privateAllowlist`). API keys are `{{cred:slug}}` placeholders resolved per call for the provider's origin only, and they never appear in results or errors.

## Other mail: IMAP / SMTP and JMAP (M7)

`src/mail/` gives any mailbox Gmail's tool surface: `mail_search_messages`, `mail_read_message`, `mail_list_mailboxes`, `mail_save_attachment` (read), `mail_modify_flags` (flags and moves; `connector_action` binding), `mail_create_draft` (`connector_action`), `mail_send` (`destructive`, the same `send_email` binding as `gmail_send`: account, recipients lowercased and sorted, subject, body hash). The matrix rows are `mail.read`, `mail.attachments`, `mail.labels`, `mail.draft`, `mail.send` with Gmail's side effects and defaults, so the owner's Permissions screen looks the same for every mail account. One `MailConnector` runs over a `MailBackend`:

- **JMAP** (`jmapFactory`, catalogue id `jmap`, Fastmail by default): `config: { token: "{{cred:<slug>}}", account: "<address>", sessionUrl?, extraHosts? }`. RFC 8620 / 8621 / 8617 subset: session resource, `Mailbox/get`, `Email/query` + `Email/get`, blob download for the raw message, `Email/set` for keywords and mailboxes, blob upload + `Email/import` for drafts, `Identity/get` + `EmailSubmission/set` for sending, `Email/changes` for sync (full sync on `cannotCalculateChanges`). The bearer token is sent only over HTTPS to the session host plus `extraHosts` (Fastmail's download host is implied for `api.fastmail.com`); redirects are refused. Fastmail: create an API token with the Mail scope at Settings → Privacy & Security → Integrations, store it in the vault, pass the placeholder.
- **IMAP / SMTP** (`imapFactory`, catalogue id `imap`, app passwords): `config: { host, port?: 993, username, password: "{{cred:<slug>}}", smtpHost?, smtpPort?: 465, smtpUsername?, account }`. A minimal IMAP4rev1 client (`src/mail/imap/`): LOGIN (quoted or literal), CAPABILITY, LIST with SPECIAL-USE roles (name heuristics otherwise), SELECT, `UID SEARCH` (TEXT / FROM / TO / SUBJECT / SINCE / BEFORE / UNSEEN, `CHARSET UTF-8` with literals for non-ASCII; `BADCHARSET` becomes `invalid_params`), `UID FETCH` of header fields for summaries and `BODY.PEEK[]` for reads, `UID STORE`, `UID MOVE` or COPY + `\Deleted` + (UID) EXPUNGE with the new UID from `COPYUID`, APPEND for drafts (`APPENDUID`) and the Sent copy, LOGOUT. Sending uses a minimal SMTP submission client (`src/mail/smtp/`): EHLO, AUTH PLAIN, MAIL FROM / RCPT TO, DATA with dot-stuffing, QUIT. Message ids are mailbox UIDs, so every ref carries its `mailbox` (default INBOX) and summaries have no snippet. Transport is implicit TLS only (`tls.connect`, TLS 1.2+, certificates verified): no STARTTLS, no plaintext, `tls: false` is refused. The app password is read from the vault handle once per session, used for the IMAP login and the SMTP AUTH, and dropped on close.

Credentials: the token or app password is a vault item bound to `{ connector: <connectorId> }` and is resolved through `CredentialBroker.resolve` for every call (`executor: "connector"`), handed once to the backend's `open`, and disposed after the call. Reads need a standing approval the Gateway supplies (`MailFactoryOptions.approveCredential`; without it, only a tool call's own approval id can resolve the credential, and `connect` makes no network call). A rejected credential moves the connector to `needs_auth` and emits `invalidated`, like a revoked Google token.

`mail_read_message` also returns `authenticationResults` (each RFC 8601 header parsed into `authservId`, method results such as `dkim` / `spf` / `dmarc`, and their `header.d` / `smtp.mailfrom` properties, topmost first; forgeable, so trust only the topmost entry whose `authservId` is the owner's provider), `autoSubmitted`, `listId` and `precedence`, so the email channel can check DKIM and drop automated mail (N9). Raw messages (IMAP `BODY[]`, JMAP blobs) are parsed by `src/mail/rfc822.ts` into Gmail's part shape and then by the same bounded `parsePayload`: RFC 2047 header words, RFC 2231 parameters, base64 and quoted-printable transfer encodings, nested multiparts (depth and part-count limits reported as warnings), attachments by part id; HTML bodies go through the hidden-text-dropping converter. Tests run against `FakeMailStore` + `FakeJmapServer`, `FakeImapServer` and `FakeSmtpServer` from `@psyche/testing` (in-memory sockets, no network), with the secrets registered in the leak checker and the servers' command logs checked for them.

## Shopping helpers (M10)

`src/shopping/` (`shoppingFactory({ browser })`, catalogue id `shopping`) drives the `BrowserDriver` contract over an owner allowlist of stores: `config: { merchants: [{ id, name, origin: "https://…", searchPath: "/search?q={q}", cartPath?: "/cart" }] }` (bare https origins only, at most 20). Tools, named by merchant id or exact origin:

- `shop_list_merchants` (`none`), `shop_search` and `shop_compare` (`read`; offers ranked by price across stores, one clean browser session per store), `shop_view_cart` (`read`).
- `shop_add_to_cart` (`write`, `connector_action` bound to the connector, merchant and arguments): finds the named offer, clicks its own `Add to cart` control, returns the cart.
- `shop_checkout_handoff` (`financial`, `purchase` binding per security §3.5: merchant host, amount in minor units, currency, line-item hash, payment source `none`; no grant key, so `once` only and device-only): the card shows seller, items and total; the executor re-reads the live cart and refuses with `conflict` when it differs from what was approved. It never clicks checkout, never fills payment details and never places an order: payment is Stripe Link (G12, later). The receipt says nothing was paid.
- `shop_parse_order_email` (`none`): schema.org `Order` from JSON-LD (order number, status, merchant, items, total, tracking), with a text fallback, for order tracking.

Parsing (`src/shopping/parse.ts`) reads snapshot text and refs only: one price per line is an offer (shipping and threshold lines are skipped), `Add to cart` buttons pair with offers in page order, a cart is `Seller:`, item rows with a quantity and price, and `Total:`. Page text is untrusted; all outputs are `untrusted`. Tests: `test/shopping/` (11) and scenario V3 (`tests/scenarios/v3-shopping`), where the scripted runner drives the real connector over fixture storefronts.

## Microsoft 365 (M6)

`microsoftFactory({ openBrowser?, showDeviceCode? })`, catalogue id `microsoft`, over Microsoft Graph v1.0. The owner registers a public client in Entra (Microsoft Entra admin center → App registrations → New registration; supported accounts as they need, often "personal and work"; platform **Mobile and desktop applications** with redirect URI `http://127.0.0.1/callback`; Authentication → "Allow public client flows" on for the device code flow). No client secret. Connect with `config: { clientId, tenant?: "common" | "consumers" | "organizations" | <tenant id or domain>, flow?: "auth_code" | "device_code" }`:

- `auth_code` (desktop): PKCE S256 on a `127.0.0.1` loopback (Entra ignores the port for loopback redirects), `prompt=select_account`.
- `device_code` (server mode, no browser): the owner enters the shown code at `https://microsoft.com/devicelogin`; Psyche polls at the given interval, backing off on `slow_down`.

Scopes: `read` = `offline_access User.Read Mail.Read Calendars.Read Contacts.Read`; `read_act` = `offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.Read Files.ReadWrite.AppFolder`. Microsoft returns every scope the app was ever granted, so a grant with more (or fewer) scopes than the mode needs fails the connect; there is no per-app revocation API, so the owner removes Psyche at `https://myaccount.microsoft.com/applications`. Refresh tokens rotate and are replaced on every refresh; `invalid_grant` moves the connector to `needs_auth` and emits `invalidated`. The token is sent only to `https://graph.microsoft.com`: paging and delta links are checked to stay there, and OneDrive downloads follow Graph's redirect to the pre-authenticated URL without it.

Tools:
- **Mail**: the shared `mail_*` tools (same names, matrix rows, side effects and `send_email` binding as IMAP / JMAP and Gmail). Reads fetch the raw MIME (`$value`) through the same parser; drafts and sends upload the MIME the tool built (`POST /me/messages`, `POST /me/sendMail`, base64), so Outlook sends exactly what the owner approved. Search uses `$filter`, or KQL `$search` when there is free text or a recipient. Flags map to `isRead`, the follow-up flag and categories; a move returns the message's new id.
- **Calendar**: `calendar_list_calendars`, `calendar_list_events` (`calendarView`, at most 366 days, UTC), `calendar_free_busy` (`getSchedule`), `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` with Google's input shape and the `calendar_write` binding. Outlook emails attendees on every change, so any event with attendees binds as an invite. Recurrence rules are refused for now.
- **Contacts**: `contacts_search` (read).
- **OneDrive**: `onedrive_list`, `onedrive_download` (to the Library, 25 MB, untrusted), `onedrive_upload` (text, 4 MB, `connector_action`), limited to Psyche's app folder; not offered in `read` mode (Graph has no read-only app-folder scope).

Sync polls Graph delta queries (inbox messages and a −7 / +365 day `calendarView`), restarting on 410 / `syncStateNotFound`. Change-notification subscriptions are not used: they need a public HTTPS webhook (see docs/status/s09.md).

## Stubbed / not yet

- Persistence: `ConnectorStore` is in memory. The `connectors` table needs a migration plus `schema.ts` from S01 (docs/status/s09.md).
- Token storage: `TokenVault` is injected and needs the S06 vault write API.
- `connectors.*` beyond `list` / `get` are not in packages/protocol yet. `CONNECTOR_METHODS` is the proposal for a `protocol:` PR.
- Shopping: no payment (G12), no login to store accounts, no quantity other than one per add, no order-email polling (the tool parses an email the agent read).
- Mail: threads for JMAP (messages carry `threadId`, there is no thread tool yet); attachments on outgoing mail; the Gateway does not compose `jmapFactory` / `imapFactory` yet (INT). IMAP: no STARTTLS, no modified-UTF-7 mailbox names, no `STATUS` counts, no OAuth (XOAUTH2) for Gmail / Outlook over IMAP (use the Google connector).
- Drive upload takes text content only. Uploading Library items needs a Library reader (S13).
- Gmail attachments on outgoing mail (the builder supports them; no tool exposes them yet), Microsoft Graph (M6), IMAP / JMAP (M7), shopping helpers (M10).
