# Security policy

Psyche runs with access to your mail, files, accounts and computer, so we treat security reports as the most important thing in the issue queue. The security design is [docs/05-security-and-permissions.md](docs/05-security-and-permissions.md). The full disclosure process is in [docs/security-disclosure.md](docs/security-disclosure.md).

## Supported versions

| Version | Security fixes |
| --- | --- |
| Latest `1.x` minor release | Yes |
| Previous `1.x` minor release | Yes, for 90 days after the next minor ships |
| `0.x` alphas (`v0.1.0-alpha` to `v0.3.0-alpha`) | No: upgrade to the latest release. Alphas are for testing and get no backports |
| `main` | Yes: fixes land here first |

Psyche has no phone-home and no remote kill switch. A security release reaches you as an update banner in the app, the release notes, and the GitHub security advisory.

## Reporting a vulnerability

Report privately. Do not open a public issue, discussion or pull request for a suspected vulnerability.

- **GitHub private vulnerability reporting** (preferred): the repository's **Security** tab, then **Report a vulnerability**.
- **Email:** `TODO(owner): security@<domain>`. Until it exists, use GitHub reporting.

Please include:
- what you found and the component it is in;
- the version or commit;
- steps to reproduce;
- the impact you expect.

A proof of concept is welcome. Test only against your own installation: do not access other people's data, and do not degrade services other people rely on.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement | within 72 hours |
| Triage and severity (CVSS 4.0) | within 7 days |
| Fix for a **critical** issue | 7 days |
| Fix for a **high** issue | 30 days |
| Fix for a **medium** issue | 90 days |
| **Low** severity | fixed in normal work |

We keep you updated while we work on a fix. The advisory credits you unless you prefer otherwise.

## Scope

In scope: everything in this repository and the artifacts we publish from it.
- **The Permission Broker and the Credential Broker** (`packages/permissions`, `packages/vault`). Of particular interest:
  - approvals that authorize something other than what the card showed;
  - grants that outlive their scope;
  - secrets reaching model-visible text, logs, transcripts or screenshots.
- **The Gateway** (`apps/gateway`, `psyched`): pairing, device tokens, WebSocket origin checks, the agent loop's taint and binding checks, executors, the egress proxy and the sandbox.
- **The macOS helper** (`apps/mac-helper`): computer-use tiers, Apple Events and scripts, Messages, dictation, keychain, notifications and VM mode.
- The desktop and web apps, the node agent, the CLI, bundled skills, and the published Docker images and Compose files.

Prompt injection counts when it gets past a deterministic control. Examples:
- untrusted content causes a side effect without an approval;
- an approval card hides what will happen;
- a placeholder resolves where it should not.

A model merely following an injected instruction into an approval card is the designed behavior (docs/05 §7).

Out of scope:
- third-party MCP servers, skills, plugins and models you install yourself (report those to their authors);
- attacks that need an already compromised macOS account or root;
- denial of service against your own installation;
- missing hardening that docs/05 already lists as a known residual risk, unless you show a practical exploit.

## Safe harbour

We will not pursue or support legal action against anyone who, in good faith:
- follows this policy;
- tests only against their own installation;
- avoids privacy violations and service disruption;
- gives us a reasonable time to fix the issue before disclosing it.

If a third party takes legal action against you for research that followed this policy, we will make it known that your work was authorized. If you are unsure whether something you plan to do is covered, ask first through the reporting channel.

## Disclosure

- **Coordinated:** the advisory is published when the fix ships, or 90 days after the report, whichever comes first, unless we agree a different date with you.
- **CVEs:** we request one for every exploitable issue.
- **Write-ups:** anything that shipped in a release gets a public write-up of what happened, who was affected, how it was fixed and what changed to prevent a repeat.

Details: [docs/security-disclosure.md](docs/security-disclosure.md).
