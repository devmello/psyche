---
title: Connectors
---

# Connectors

Connectors give the agent your accounts and tools: mail, calendar and files through Google or a mail server, and anything that speaks the Model Context Protocol (MCP). Each connector has its own permissions, everything it reads is untrusted content, and every write it makes leaves a receipt. Today only MCP servers can be connected, and only through a setting. Google, other mail and web search are built but cannot be connected yet.

## Turn it on

### MCP servers

Add servers with the `mcp.servers` setting, a JSON list. You need a device paired as admin; the CLI pairs as its own device the first time and prints a code to approve.

```bash
psyche config set mcp.servers '[{"id":"example","name":"Example","transport":{"kind":"http","url":"https://mcp.example.com/mcp"}}]'
```

Each entry has:

- `id` and `name`.
- `transport`: `{"kind":"http","url":"…"}` for a remote server, or `{"kind":"stdio","command":["…"]}` for a program on the Gateway's machine, with optional `env` and `cwd`.
- `trust`: `bundled`, `verified` or `unknown`. Leave it out and it is `unknown`.
- `auth` for a remote server: `{"kind":"none"}`, `{"kind":"oauth"}`, or `{"kind":"bearer","credential":"…"}` naming a vault item, sent as a bearer token.
- `sandbox` for a stdio server: which domains it may reach and where it may write. By default it gets no network and no writes.

::: v-pre
An environment value can be a vault placeholder such as `{{cred:notion-token}}`. Each one asks you before it is filled.
:::

Local (stdio) servers must run isolated. Start the Gateway with one of:

- `PSYCHE_SRT_PATH` pointing at `srt`, to run each stdio server under it; or
- `PSYCHE_MCP_LAUNCHER=container`, to run each in its own sandbox container, reaching the network only through Psyche's egress proxy and the server's allowlist.

With neither, stdio servers that are not bundled are refused and only remote servers run. `PSYCHE_MCP=off` turns MCP off. `psyche doctor` and `psyche security audit` report which launcher is in use and each server's trust, transport and network reach.

### Google, mail and others

Settings → Connectors and onboarding's Connectors step list Google (Gmail, Calendar, Drive), Microsoft (Outlook, Calendar), Other email (IMAP), Apple Notes, Apple Reminders and MCP server. None of them can be connected from there yet. In onboarding, use **Skip for now**.

You can already prepare a Google Cloud OAuth client for when connecting works; the [Connectors guide](/guides/connectors) has the steps.

## What it can do

### MCP servers

The server's tools appear to the agent as `mcp__<server>__<tool>`. How Psyche treats them depends on trust:

- For a server that is not bundled, its own claims about a tool (such as "read only") can only make Psyche more careful, never less.
- Results from a server that is not bundled are untrusted content.
- Tool descriptions are framed as data. A tool whose description reads like instructions to the agent, or hides markup or invisible characters, is not registered at all.
- Secrets in a server's output are redacted before the model sees them.

### Google (once it can be connected)

Gmail, Google Calendar and Google Drive, on your own Google Cloud OAuth client, so your mail never passes through anyone else's server. You choose **Read only** or **Read and act** when you connect, and Drive is limited to files the agent creates or you open with it. See the [Connectors guide](/guides/connectors).

### Shopping

There is no shopping connector in the Gateway. The agent compares prices and builds carts in its own browser, guided by the `shopping-compare` skill, and stops at a purchase card before paying. See [Browser](/using/browser) and [Credentials and payments](/using/credentials-and-payments).

## What it asks you

- **Calling an MCP tool** with a side effect: an "MCP tool" card with the server, the tool and the full arguments. Reads follow your permission mode: the first read from a new server in a task asks.
- **Grants end when a server changes.** A standing grant is bound to the server's exact tool list. If the server changes its tools or their descriptions, grants for it are revoked and the agent asks again. Removing a server revokes all its grants.
- **Per-tool rules.** You can set Allow, Ask or Deny for one MCP tool in the `permissions.policy` setting, under `connectors`, keyed by server id and tool name.
- **After reading untrusted content**, writing or sending to a target you did not name asks even if a grant covers it. See [Untrusted content](/security/taint).

## Limits today

- **Google cannot be connected.** The Gateway has the connector, but no screen or command offers the connect step.
- **IMAP, SMTP and Fastmail (JMAP) mail are not available.** The code exists but the Gateway does not include it.
- **Microsoft, Apple Notes and Apple Reminders** do not connect from Settings. Apple apps can be used through [Computer use](/using/computer-use).
- **Web search is not available.** Brave, Exa, Tavily and SearXNG are implemented, but the Gateway does not configure any of them. The agent opens pages in its browser instead.
- **There is no screen for MCP servers.** Use `psyche config set mcp.servers`. OAuth sign-in for remote MCP servers has not been confirmed to work end to end.
- Settings → Permissions has a Connector actions group (Allow, Ask or Deny per action). It stays empty because no connector can be connected, and the values it would save are not read by the Gateway yet.
- A vault placeholder in a server's environment needs a credential-fill approval, which needs Touch ID or a passkey. Touch ID approvals cannot be approved in the desktop app yet (see [Credentials and payments](/using/credentials-and-payments)).
- Drafting your own API connector from a description is not built.

## Learn more

- [Connectors guide](/guides/connectors)
- [Permissions](/security/permissions)
- [Untrusted content](/security/taint)
- [Settings reference](/reference/settings)
- [MCP host and connectors in the architecture](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md#49-mcp-host-and-connectors)
- [MCP host package](https://github.com/devmello/psyche/tree/main/packages/mcp-host)
- [Connectors package](https://github.com/devmello/psyche/tree/main/packages/connectors)
