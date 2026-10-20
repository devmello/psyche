# @psyche/connectors

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
