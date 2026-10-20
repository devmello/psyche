---
title: Security for owners
---

# Security for owners

Psyche is an agent that can read your mail, browse, run commands and spend money, so its security model is the product. This section explains, in plain words, what Psyche protects, where the trust boundaries are, and what you control. The binding design is [docs/05-security-and-permissions.md](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md); these pages summarize it and say where the code does not match it yet.

## The six goals

Psyche's security design has six goals, in priority order.

1. **The model never sees a secret.** Passwords, API keys, tokens and payment details live in an encrypted vault. The agent only sees placeholders such as `{{cred:github-login}}`. The real value is filled in at the last step, after you approve, and masked afterwards. See [Key storage](/security/key-storage).
2. **Nothing happens without you.** Web pages, emails, documents and messages from other people are evidence, never permission. Only the Permission Broker in the Gateway can allow a side effect, and only you can answer its questions. See [Permissions](/security/permissions) and [Approvals and tiers](/security/approvals-and-tiers).
3. **A hijacked turn can only do limited damage.** Commands run in a container with no network. The browser runs in its own profile. When the agent has read untrusted content, standing grants stop covering new targets. See [Untrusted content and taint](/security/taint).
4. **Every external write can be reconstructed.** Each send, purchase, file write and command leaves a receipt. An action whose outcome is unknown is never retried on its own. Everything is recorded in a hash-chained audit log. See [Audit log and receipts](/security/audit-log).
5. **Remote access is never an accident.** The Gateway listens on `127.0.0.1` only. Every client is a paired device that signs a challenge. Remote access goes through Tailscale, an SSH tunnel or an identity-aware proxy.
6. **You can see, edit, export and delete everything.** Memory is Markdown files. Grants, receipts and the audit log are visible in the app and exportable. See [What stays on your machine](/security/on-device).

## Trust boundaries

Psyche has three zones.

| Zone | What is in it | What Psyche assumes |
| --- | --- | --- |
| The untrusted world | Web pages, mail, documents, third-party MCP servers, other people who message the agent, merchants | Anything here may try to steer the agent. It is treated as data. |
| Executors | The agent browser, the sandbox container, host helpers under `srt`, remote nodes, the VM guest | Content can compromise them. They get only what one action needs. |
| The Gateway (`psyched`) | The agent loop, Permission Broker, Credential Broker, audit log | The trusted core. It is the only process that talks to model providers, holds the vault key in memory, and decides allow, ask or deny. |

Clients (the desktop app, the web UI, the CLI) hold no secrets and decide nothing. They render approval cards and send back your answers. The Mac helper (Psyche Helper) holds the macOS permissions and the Keychain, and connects to the Gateway as a node. Chat channels such as Telegram are the weakest surface: they can answer only low-risk approvals.

::: info Screenshot placeholder
A diagram of the three zones: untrusted content on top, executors in the middle, the Gateway at the bottom, with clients and the Mac helper connecting to the Gateway.
:::

## What Psyche never does

Some actions are refused in every mode, whatever you or the content says. The agent never types a password, card number, bank account or government ID it can see; never solves a CAPTCHA; never makes a financial transfer or trade; never deletes data permanently without a typed confirmation; never follows instructions found in content; never changes its own permissions, grants or pairing from a tool call; and never reads Safari or Passwords.app credentials, your keychains, browser profiles, `~/.ssh` or cloud CLI credentials. The full list is in [docs/05 §3.9](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#39-hard-prohibitions-not-configurable) and in Settings → Permissions under Hard prohibitions.

## Check your own install

Run the security audit from a terminal:

```bash
psyche security audit
```

It checks the bind address, proxy and passkey setup, admin devices, standing grants without expiry, open chat channels, the vault slot and recovery key, file modes under `$PSYCHE_HOME`, the sandbox and egress proxy, `exec_host`, MCP servers, skills, real-Chrome mode, computer-use overrides, backups and the update check. A check whose data the Gateway cannot provide is listed as "not checked", never as passed. The rule ids are listed in [docs/05 §10](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#10-control-plane-and-remote-access).

## Where the code is not done yet

Psyche is alpha software (0.3). These parts of the design are not built, or only partly:

- The injection corpus has 68 cases; the design target is at least 200. There are no cases yet for the coding helper, travel and VM mode (issue [#423](https://github.com/devmello/psyche/issues/423)). See [Untrusted content and taint](/security/taint).
- Unsigned builds keep the vault key in a file, not the Keychain. See [Key storage](/security/key-storage).
- `state/psyche.sqlite`, your workspace and the Library are not encrypted by Psyche. They rely on FileVault (or LUKS on Linux).
- Per-task origin sets for the browser are honored by the broker, but nothing fills them yet.
- The Gateway does not yet check the code signature of a local client. Any process running as you that can read the per-launch handshake secret can pair as the desktop or the helper, with read, write and approval scopes but never admin.
- Mobile TLS pinning is not built; there is no mobile client yet.
- The auto-update check stays off until a release signing key is embedded in the app.

## Report a vulnerability

Report privately. Do not open a public issue, discussion or pull request.

- Use GitHub private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**.
- A security email address is not set up yet.

You get an acknowledgement within 72 hours. Fix targets are 7 days for critical, 30 for high and 90 for medium issues. The full policy, scope and safe-harbour terms are in [SECURITY.md](https://github.com/devmello/psyche/blob/main/SECURITY.md); how a report becomes a fix, an advisory and a write-up is in the [disclosure process](https://github.com/devmello/psyche/blob/main/docs/security-disclosure.md).

## Learn more

- [Permissions](/security/permissions)
- [Approvals and tiers](/security/approvals-and-tiers)
- [Untrusted content and taint](/security/taint)
- [What stays on your machine](/security/on-device)
- [Audit log and receipts](/security/audit-log)
- [Backups](/security/backups)
- [Key storage](/security/key-storage)
- [SECURITY.md](https://github.com/devmello/psyche/blob/main/SECURITY.md)
- [Disclosure process](https://github.com/devmello/psyche/blob/main/docs/security-disclosure.md)
- [docs/05-security-and-permissions.md](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md)
- [reports/m3-threat-model-review.md](https://github.com/devmello/psyche/blob/main/reports/m3-threat-model-review.md)
