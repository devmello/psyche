---
title: Connectors
---

# Connectors

Connectors give the agent your accounts and tools: mail, calendar and files through Google or a mail server, and anything that speaks the Model Context Protocol (MCP). Each connector has its own permissions, everything it reads is untrusted content, and every write it makes leaves a receipt. Today only MCP servers can be connected, and only through a setting. Google, other mail and web search are built but cannot be connected yet.

## Turn it on

### MCP servers

Add servers in **Settings → Connectors → Add MCP server**, with no terminal needed. Choose a command (it runs sandboxed) or an HTTPS URL, give it a name, and for a command add any environment variables it needs. **Check server** starts it in the sandbox and lists its tools; nothing is added until you approve the trust card that shows what it can reach. Variables whose names look like secrets (token, key, password) are saved to your vault and are never shown again: the field then says Saved. Paste a server's JSON into the form to fill it in.

Each server in the list shows whether it is connected, not working or paused. Its detail page lists its tools, lets you pause it or remove it (after a confirmation), and replaces its secret values. **Edit** opens the same form with the server's current settings filled in; secrets show Saved and are never read back. Changing only the name takes effect at once. Changing what runs or where it connects (the command, the URL, the allowed domains, or which variables and secrets it gets) works like adding: Psyche checks the new setup in the sandbox and shows a card with the old and the new side by side. The server you have keeps running until you approve; then it restarts with the new setup. A server Psyche wrote itself or one imported from a shared file can be renamed, but its command and connection can't be edited: remove it and add another.

**Test connection** checks the saved setup again and tells you how many tools it found, or what went wrong. It changes nothing and doesn't ask for approval, because you already approved that setup. It's unavailable while the server is paused.

You can also add servers with the `mcp.servers` setting, a JSON list. You need a device paired as admin; the CLI pairs as its own device the first time and prints a code to approve.

```bash
psyche config set mcp.servers '[{"id":"example","name":"Example","transport":{"kind":"http","url":"https://mcp.example.com/mcp"}}]'
```

Each entry has:

- `id` and `name`.
- `transport`: `{"kind":"http","url":"…"}` for a remote server, or `{"kind":"stdio","command":["…"]}` for a program on the Gateway's machine, with optional `env` and `cwd`.
- `trust`: `bundled`, `verified` or `unknown`. Leave it out and it is `unknown`.
- `auth` for a remote server: `{"kind":"none"}`, `{"kind":"oauth"}`, or `{"kind":"bearer","credential":"…"}` naming a vault item, sent as a bearer token.
- `sandbox` for a stdio server: which domains it may reach and where it may write. By default it gets no network and no writes.
- `keepAlive` for a stdio server: `true` keeps it running when it is idle. By default a stdio server stops after 10 minutes without a call, to give its memory back, and starts again on the next call. If its tools changed meanwhile, you approve them again. Set `keepAlive` for a server that pushes notifications or holds state that is slow to rebuild, such as a signed-in browser. It can only be set here, not in Settings.

Some stdio servers are never stopped for being idle and never restarted automatically: servers Psyche wrote, servers imported from a shared file, servers with a vault placeholder in their environment, and servers started through a package runner without an exact version such as `pkg@1.2.3` or `pkg==1.2.3`. Package runners include `npx`, `npm exec`, `npm create`, `pnpm dlx`, `yarn dlx`, `bunx`, `uvx`, `uv run --with`, `pipx run` and `deno run npm:`. A runner fetches the package again at every start, so a restart could run a newly published release. The same goes for commands Psyche can't see into: a shell or interpreter given a string to run (`sh -c`, `node -e`, `python -c`, `perl -e`), or a command named through a variable. Psyche can't see dependencies declared inside a file, so give `keepAlive` to two kinds of server: a wrapper script that calls a runner itself, and a `uv run` script with inline dependencies (a `# /// script` block) that aren't pinned. A server that keeps crashing stops trying after five quick failures, waits 10 minutes, then tries again on the next call. Editing or re-adding it starts it right away.

::: v-pre
An environment value can be a vault placeholder such as `{{cred:notion-token}}`. Each one asks you before it is filled.
:::

Local (stdio) servers must run isolated. By default they run under `srt` (Anthropic's sandbox runtime, on macOS's Seatbelt, no VM): an ordinary process on your Mac that can read your files but not your vault, keys or Psyche's private data, writes only to its own scratch folder and reaches only the hosts it declares. Psyche looks for `srt` at every launch, in this order:

- `PSYCHE_SRT_PATH`, an override;
- the `exec.srtPath` setting, chosen in the walkthrough below (it asks you to confirm on this device);
- `srt` on PATH, in Homebrew's and npm's folders, or next to the Gateway's Node.

`PSYCHE_MCP_LAUNCHER=container` runs each server in its own sandbox container instead, reaching the network only through Psyche's egress proxy and the server's allowlist.

Without a sandbox, the add page says so and offers **Set up sandbox**: a short walkthrough that shows the install command (`npm install -g @anthropic-ai/sandbox-runtime`) and checks again. Psyche installs nothing itself. A container runtime (Apple `container`, Colima or Docker Desktop) is listed there as optional stronger isolation. Onboarding offers the same as an optional step.

With neither, stdio servers that are not bundled are refused and only remote servers run. `PSYCHE_MCP=off` turns MCP off. `psyche doctor` and `psyche security audit` report which launcher is in use and each server's trust, transport and network reach.

### Google, mail and others

Settings → Connectors and onboarding's Connectors step list Google (Gmail, Calendar, Drive), Microsoft (Outlook, Calendar), Other email (IMAP), Apple Notes and Apple Reminders. Google connects from Settings with your own client. The others cannot be connected from there yet. In onboarding, use **Skip for now** for them. MCP servers are the exception: add them above.

Google connects with your own Google Cloud OAuth client. Paste its client ID in Settings → Connectors → Add connector → Google. The [Google guide](/guides/connectors-google) has the steps.

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
- **Payments.** A tool that moves money asks every time, once only, with Touch ID or your password. Psyche judges by the tool's name and description (`send_money` and "Places a stock market order" count; `git_checkout`, `transfer_file` and "Sends an adaptive card" do not), but a server writes those words itself. In Settings → Connectors → a server → Payments you can say that every tool of it moves money, or that none does. Choosing "No tool moves money" lowers protection, so it asks for your approval first.
- **After reading untrusted content**, writing or sending to a target you did not name asks even if a grant covers it. See [Untrusted content](/security/taint).

## Limits today

- **Google needs your own OAuth client.** Psyche has no Google client of its own. Add yours in Settings → Connectors → Add connector → Google. The [Google guide](/guides/connectors-google) has the Google Cloud steps.
- **IMAP, SMTP and Fastmail (JMAP) mail are not available.** The code exists but the Gateway does not include it.
- **Microsoft, Apple Notes and Apple Reminders** do not connect from Settings. Apple apps can be used through [Computer use](/using/computer-use).
- **On Windows**, local mail, calendar and contacts (Outlook Mail, Outlook Calendar, Outlook Tasks and Outlook contacts) work only with classic Outlook. The new Outlook app has no local route; connect the Microsoft, Google or IMAP connector instead. Apple Notes, Messages and the other Apple apps do not exist there.
- **On Windows, local (stdio) MCP servers cannot run under `srt`**, which has no Windows build. Set `PSYCHE_MCP_LAUNCHER=container` on the Gateway and run Docker or Podman to use them; the [sandbox PC](/using/vm-mode#on-windows-the-sandbox-pc) does not launch MCP servers. Remote (HTTP) servers are unaffected.
- **Web search: only Brave can be set from Settings.** Settings can save a Brave Search key. Exa, Tavily and SearXNG are implemented but cannot be set there. The agent opens pages in its browser instead.
- **Custom HTTP headers and a working directory cannot be set from Settings yet.** Use `psyche config set mcp.servers` for those. OAuth sign-in for remote MCP servers has not been confirmed to work end to end.
- Settings → Permissions has a Connector actions group (Allow, Ask or Deny per action). The Gateway reads these rules. The group is empty until a connector is connected.
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
