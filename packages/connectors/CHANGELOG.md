# @psyche/connectors

## Unreleased (pre-0.3.0)

### Minor Changes

- `MailMessageView` exposes parsed `Authentication-Results`, `Auto-Submitted`, `List-Id` and `Precedence` for the email channel (N9).
- M6: Microsoft 365 connector over Graph (auth code + PKCE or device code; Outlook mail through the shared mail tools, calendar, contacts, OneDrive app folder; delta sync). `mailTools()` is exported for reuse.
- M9: custom connectors from a declarative manifest or an OpenAPI 3 document, installed only through the device-only `skill_install` trust card (`details.kind: "connector"`); the agent can draft but never enable one.
- Google connect flow (#505): `connectors.connect` answers at once with the pending consent page and finishes as `connectors.updated`; durable connector records (`connectors` table, `SqliteConnectorStore`) restored at boot; the owner's OAuth client from `connectors.google` in `config.json` or `PSYCHE_GOOGLE_CLIENT_*` (secret only as a vault placeholder). Guide: docs/guides/connectors-google.md.
- Apple Notes, Reminders, Calendar and Mail connectors over the paired Mac helper's J6 app capabilities (#528); "needs the helper" when none is paired.
- Apple connectors are never "connected" without the macOS grant: needs permission with where to allow it, re-checked on status (#549). One-per-machine connectors refuse a second instance (`already_connected`) and duplicates are removed at start.
- Apple Mail tools, wave 1 (#639): mailboxes with unread counts, the selected email, reply and forward drafts, send a saved draft (bound to its recipients and body hash), mark read / flag, move or archive, save attachments.
- Apple Reminders and Calendar tools, wave 1 (#639): due-today / overdue / flagged / text filters, links, alarms and repeats on reminders, complete, flag and delete; event search with attendees and meeting links, alarms, recurrence and availability, free/busy, delete.
- Apple Notes tools, wave 1 (#639): search by text, folders, append (text or checklist), update bound to the note's previous body hash, Markdown create.
- Apple Contacts connector, wave 1 (#639): look people up by name, email, phone or company; read a contact; add people and add emails or phones (approval-gated). The Apple connector now supports other grants (Contacts, none) and non-Apple identities.
- Music connector (Apple Music and Spotify), wave 1 (#639): now playing, playback control, library search and play; the agent's playback tools are allowed by default (nothing leaves the Mac).
- Safari and Chrome connectors, wave 1 (#639): open tabs and the current tab, the text of a Safari page (untrusted), adding to Safari's Reading List; Chrome tabs.
- Files connector, wave 1 (#639): newest files in shared folders, move / rename (ask), put in the Trash (destructive, asks).
- Shortcuts connector, wave 1 (#639): list the owner's shortcuts; run one with text input and get its output (destructive, always asks; shortcuts the owner turned off never run).
- Things 3 connector, wave 1 (#639): list Inbox / Today / Upcoming / projects / areas / tags; add, reschedule and complete to-dos (ask).
- Obsidian connector (#639): a shared vault folder searched, read and written as Markdown in the Gateway (no helper, no plugin): search, read, append, the daily note, create. One connector per vault.
- calendar_find_free_time across connected Apple and Google calendars (#639), the free-slot finder, and the per-app guidance module (a tested copy of docs/connectors/agent-guidance.md).
- `connectors.configure` (#727): merges non-secret settings into a connector's config without reconnecting (`null` removes a key; secret-looking keys must be `{{cred:slug}}` placeholders; keys the Gateway manages are refused) and re-creates the live instance. Shortcuts honour `config.shortcutRules[id]` (off refuses before any card, ask asks, allow runs as a write with a receipt; a matrix deny still wins). Obsidian re-checks `vaultPath` and keeps the daily note in `config.dailyFolder`. Apple Mail attachments staged by the helper are imported into the Library (quarantined, `origin: connector`) and the staging path never reaches the model. The Gateway now gives connectors a default Library sink.
- The broker now applies the owner's Settings → Connectors rules (Allow / Ask / Deny per action group) to connector tool calls (#747).
  - **Registry:** stamps each call with its group; connector-write receipts record the deciding rule.
  - **Broker:** allow → no card; ask → card; deny → refused, with a receipt.
  - **Hard floors:** sends, destructive, financial and device-only calls always ask.
  - **Shortcuts:** each shortcut's rule applies (off → denied, allow → no card).
  - **Gateway:** syncs `permissions.connectors.*` and `shortcutRules` into the broker policy and the executor's matrix. Direct Apple helper calls follow the same groups.

### Patch Changes

- Apple connectors ask macOS for the grant when it has not decided (Check again asks again), send the owner to System Settings only after a denial, and show the helper's reason when no prompt appeared (#570).
- Apple Mail search: optional query plus unread, since / until and from filters, evaluated inside Mail, newest first (#626).
- Things update and complete get Things' auth token from the vault (connector config `authToken: {{cred:…}}`, read under a credential card), added to the helper call only (#719).

## 0.3.0-alpha.0

### Minor Changes

- 7d01f0e: Security §10 rate limits: inbound chat 30/minute per sender (`ChannelServiceOptions.admitInbound`) and `web_fetch` 60/minute per Task (`WebFetchFactoryOptions.beforeFetch`), configurable with `gateway.rateLimits` and audited as `rate_limit.exceeded`.
- 5dcf208: Standing grants reach connector executors: the loop puts what authorized a dispatch (approval or standing grant, binding hash, scope) on `ToolRunContext.authority`, and the connector registry confirms a grant the way it confirms an approval. The sender of a channel turn travels as `StartTurnInput.requester` into `PermissionBroker.decide` and the approval card's context. Taint persists across kill/restart: `tool_call` events carry the persisted details, thread state keeps the taint sources, and tasks carry `taintSources`.
- cdb5b62: Connector framework (registry with action-matrix and scope enforcement, binding re-verification and receipts, catalogue with remote MCP presets, `connectors.*` handlers) plus web search (Brave, Exa, Tavily, SearXNG) and an SSRF-safe fetch with HTML to Markdown.
- 0a0d2a6: Google connector: desktop OAuth with loopback and PKCE, Gmail threads / drafts / send / labels / attachments with hardened MIME parsing and `history.list` sync, Calendar CRUD and free/busy with `syncToken` sync, Drive `drive.file` upload and download.
- d02b6ef: M10: shopping helpers over the browser driver (compare, cart, checkout hand-off with a `purchase` binding and no payment, schema.org Order parsing) and scenario V3 in the scripted runner up to the hand-off.
- d2c228c: M7b: IMAP / SMTP mail backend (minimal clients over implicit TLS, app passwords through `{{cred:slug}}`) behind the shared mail connector, plus `FakeImapServer`, `FakeSmtpServer` and in-memory socket pairs.
- 6dda211: M7a: a shared mail connector with Gmail's tool surface over a `MailBackend`, the JMAP (Fastmail) backend with `{{cred:slug}}` tokens resolved per call, an RFC 5322 / MIME parser for raw messages, and `FakeMailStore` + `FakeJmapServer` fakes.
- 9bb5dd4: `safeFetch` checks every redirect hop against an `allowHop` policy (`originAllowlist`, canonical origins); `web_fetch` allows the request's origin plus the Task's origin set and refuses other hops with `redirect_not_allowlisted` (#72). The scenario world uses the real check.

### Patch Changes

- a49d8b1: Binding recipes hash the exact strings that run or are sent: no NFC folding in the loop's or the connectors' canonical JSON, or in the Gmail send binding (S23 design-13).
- 412aaa1: Connector writes reach an approval card again: `mcp__` tools may describe their connector kind, and the connector registry confirms the loop's approval with the loop's binding recipe instead of consuming it a second time (#78).
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [4bc7113]
- Updated dependencies [515b904]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
