# Security policy

**Status: design phase / pre-release.** Psyche has no released builds yet, so there are no supported versions to patch. This policy applies from the first release and to the code on `main` in the meantime. The full security design is in [`docs/05-security-and-permissions.md`](docs/05-security-and-permissions.md).

## Reporting a vulnerability

Please report privately. Do not open a public issue, discussion or pull request for a suspected vulnerability.

- **GitHub private vulnerability reporting** (preferred): the repository's **Security** tab, then **Report a vulnerability**.
- **Email:** `TODO(owner): security@<domain>` (security address not set up yet; use GitHub reporting until it is).

Include what you found, the affected component and version or commit, steps to reproduce, and the impact you expect. Proof-of-concept code is welcome; please do not access other people's data or degrade shared services while testing.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of your report | within 72 hours |
| Fix for a **critical** issue | 7 days |
| Fix for a **high** issue | 30 days |
| Fix for a **medium** issue | 90 days |

Low-severity issues are fixed as part of normal work. We will keep you updated while we work on a fix and credit you in the advisory unless you prefer otherwise.

## Disclosure

- Coordinated disclosure: we publish the advisory when the fix ships, or after 90 days from the report, whichever comes first, unless we agree a different date with you.
- We request a CVE for every exploitable issue.
- Anything that shipped in a release gets a public write-up: what happened, who was affected, how it was fixed, and what changed to prevent a repeat.
- Security releases surface in the app as an update banner. Psyche has no phone-home and no remote kill switch.

## Scope

In scope: the Gateway, desktop and web apps, the macOS helper, the node agent, the CLI, the packages in this repository, bundled skills, and the published deploy files. Particularly interesting: permission or approval bypasses, secrets reaching model-visible text, logs or transcripts, prompt-injection paths from untrusted content to side effects, sandbox escapes, pairing or authentication flaws, and update-signature bypasses.

Out of scope: third-party MCP servers, skills or plugins you install yourself (report those to their authors), and issues that need an already compromised host account.
