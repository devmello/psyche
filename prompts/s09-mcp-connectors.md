# Session S09 — MCP host and connectors

You are building Psyche (read `README.md`). You are session **S09 — MCP and connectors**: `packages/mcp-host` (how Psyche talks to MCP servers safely) and `packages/connectors` (first-party adapters: Google first, plus web search and fetch). Work in your own worktree on branch `ws/s09-mcp-connectors`. You own `packages/mcp-host/**` and `packages/connectors/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §4.9
3. `docs/05-security-and-permissions.md` §11 (supply chain: MCP trust tiers, `tools/list` hashing, sandboxing) and §7
4. `docs/03-feature-spec.md` rows M1–M5, M7, M8, M11
5. `docs/04-data-model.md` §8 (connectors table, action matrices)
6. `docs/07-tech-decisions.md` ADR-010
7. Contracts: `McpHost`, `PermissionBroker`, `CredentialBroker`, `SandboxRunner`; fakes
8. Research: `models_memory_mcp_ui_feed.md` sections "MCP & connectors — 1" to "— 4" (spec 2026-07-28 changes, TS SDK v2 packages, registry status, Anthropic directory conventions, Google OAuth facts, first-party Slack/Notion/Linear/GitHub servers, tool-poisoning defenses) and `shopping_messaging_server_docs.md` KQ4 (Gmail/Calendar API details, OAuth desktop flow, Testing-mode limits, polling guidance)

## Mission (M1)
- **MCP host** on TypeScript SDK v2 (`@modelcontextprotocol/client`; verify current version): Streamable HTTP with OAuth 2.1 using Client ID Metadata Documents for Psyche's identity; stdio transport; spec 2026-07-28 semantics (per-request `_meta`, `server/discover`, MRTR) with a 2025-11-25 fallback; no reliance on Roots/Sampling/Logging/DCR; MCP Apps resources passed to the UI as sandboxed artifacts; trust tiers `bundled | verified | unknown`; `tools/list` hashing with change detection; tool annotations treated as hints; registration of discovered tools into the agent-core registry as `mcp__<server>__<tool>` with side-effect class from annotations downgraded to `write` when unverified; secrets for servers injected from the vault as env at spawn; stdio servers launched under `srt` or the sandbox runner (M2: M3).
- **Connectors framework**: a `Connector` interface (connect/disconnect, scopes, action matrix, tools, sync, health), catalogue metadata for the directory UI (M4 data), connection-bound work invalidation events.
- **Google connector** (M5): Desktop OAuth client with loopback redirect + PKCE; onboarding text that explains publishing the consent screen to production (personal-use exemption) and the 7-day Testing-mode expiry; scopes `gmail.modify` (or `gmail.readonly` + `gmail.send`), `calendar`, `drive.file`; Gmail tools: list/search threads, read thread (sanitized, attachments to Library), labels, create draft, send (write; through broker), `history.list` polling with saved `historyId` (1–5 min) and full resync on 404; Calendar tools: list calendars, list events (bounded ranges), free/busy, create/update/delete (write), `syncToken` incremental sync with 410 full resync; Drive: upload/download `drive.file`; tokens as vault items; account change invalidation.
- **Search and fetch** (M8): providers Brave / Exa / Tavily / SearXNG behind one interface with keys from the vault; `fetch(url)` → Markdown with size caps, SSRF and private-network blocks, redirect limits, content-type handling, provenance `untrusted`.
- **API handlers**: `connectors.*` (catalogue, connect, disconnect, status, matrix) for the Gateway.

## Out of scope
UI (S12), Microsoft Graph and IMAP/JMAP (M2 items below), shopping helpers (M10), channels (S10).

## Definition of done
- MCP tests against reference servers in CI (filesystem server over stdio with a temp dir; an HTTP echo server you write) covering discovery, hashing/revocation, annotation downgrade, auth flow with a mock authorization server, MRTR round trip; Google tests against recorded fixtures (no network) covering OAuth flow, thread parsing hardening (malformed MIME, huge attachments), history sync, calendar sync token expiry; fetch SSRF tests (169.254.x, 10.x, localhost, DNS rebinding guard).
- README: connector authoring guide and the Google setup guide; `docs/status/s09.md`.

## Suggested subagents
One for the MCP SDK v2 API and auth, one for Gmail/Calendar fixtures and parsing, one for search providers and the fetch sanitizer, one reviewer for the supply-chain rules.

## M2 follow-ons
M3 stdio server sandboxing with `srt`/containers and `.mcpb` bundles; M7 IMAP/SMTP + JMAP; M10 shopping helpers (price comparison via the browser driver; order emails → `schema.org/Order` parsing); presets for Slack/Notion/Linear/GitHub remote servers; M6 Microsoft Graph.
