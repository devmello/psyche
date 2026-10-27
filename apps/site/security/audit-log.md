---
title: Audit log and receipts
---

# Audit log and receipts

Psyche keeps two records of what it does. A receipt is the evidence for one side effect: what was sent, bought, written or run, which approval allowed it, and what the provider said back. The audit log is the full history: every decision, approval, grant, credential fill and setting change, in a hash-chained file you can verify. This page explains both, how to check the log, and how to export it.

## Receipts

Every side effect leaves a receipt, whether it worked or not: sends, calendar changes, purchases, file writes outside the sandbox workspace, shell commands, form submissions, computer-use actions and MCP writes.

A receipt records:

- the task and tool call it belongs to;
- the approval that allowed it, and who answered (`decidedBy`);
- a hash of the exact request;
- the provider's own ids, such as an email message id or an order number;
- the outcome, and when it started and finished;
- for some kinds, a check by an evaluator that the provider really did it.

The outcome is one of three:

| Outcome | Meaning |
| --- | --- |
| ok | It worked. |
| failed | It did not happen. |
| uncertain | The Gateway stopped mid-action and cannot tell. The receipt reads "outcome unknown · not retried". |

Psyche never repeats an uncertain action by itself. The evaluator asks the provider, or asks you. This is what keeps a restart from sending the same email twice.

### Where to see receipts

- In the conversation, next to the action.
- In the agent sheet's Activity tab (⇧⌘A): open a task to see each action with its time, tool, summary and outcome.
- In Approvals → Recent, for the decisions of the last 7 days and where they were answered.

::: info Screenshot placeholder
A task in Activity with three actions: a file write (ok), an email send (ok, with its message id) and a command marked "outcome unknown · not retried".
:::

## The audit log

The log lives in `$PSYCHE_HOME/audit/`, one JSON Lines file per month (`2026-10.jsonl`). It records every tool call decision with the rule that decided it, every approval and its answer, every grant created, used or revoked, every credential fill, every send and purchase, device pairing and revocation, setting changes, and refusals such as rate limits.

It records what happened, not the content:

- tool results are logged as sizes and hashes only;
- setting changes are logged as key names and hashes;
- secrets pass through the vault's redactor before anything is hashed or written;
- a retracted memory fact is logged as "a retraction happened", without its text.

Receipts and audit entries are never deleted by Psyche's cleanup. They are kept until you delete your data.

### How the chain works

Each entry carries the hash of the entry before it (`prev`) and its own hash over its canonical JSON. The first entry of a month carries the last hash of the previous month. Changing, removing or reordering any entry breaks every hash after it.

A hash chain alone cannot show that the end was cut off. So the Gateway also signs an anchor every 1,000 entries and at least once an hour, with an Ed25519 key in `$PSYCHE_HOME/security/audit-anchor-key.json`. The same file remembers the last anchored entry, so deleting the newest entries together with their anchors still fails verification.

The anchor key is a software key on the same machine, outside the vault (anchors are signed while the vault is locked) and outside backups. A process running as you could read it. The log is tamper-evident against edits and truncation, not against malware that already has full access to your account. Signing with the Mac's Secure Enclave through Psyche Helper is planned but not built.

## Verify the log

```bash
psyche audit verify
```

It walks the whole chain and every anchor, and reports how many entries it checked, how many anchors were signed and by which key, and the entry where signing started. It exits with code 1 if:

- the chain is broken anywhere;
- an anchor is missing, forged or does not match;
- the log ends before the last signed anchor.

Run it after a restore, after moving to a new machine, or whenever something looks wrong. `--json` gives machine-readable output.

After a restore, the anchor head is reset to match the restored log, and that reset is itself written to the log (`audit.anchor_head.reset`).

## Export the log

- `psyche export --out <dir>` writes a readable copy of your data, and copies the audit log files into `<dir>/audit/`.
- Backups include `audit/`; see [Backups](/security/backups).
- Integrators with an admin device can call `audit.list`, `audit.verify` and `audit.export` over the protocol; see [Protocol](/reference/protocol).

The files are plain JSON Lines, so you can read them with any text tool:

```bash
tail -n 5 ~/.psyche/audit/2026-10.jsonl
```

## Learn more

- [Approvals and tiers](/security/approvals-and-tiers)
- [Backups](/security/backups)
- [CLI reference](/reference/cli)
- [docs/05 §15, audit log and receipts](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#15-audit-log-receipts-incident-response-release-checklist)
- [docs/04-data-model.md](https://github.com/devmello/psyche/blob/main/docs/04-data-model.md)
- [packages/audit](https://github.com/devmello/psyche/tree/main/packages/audit)
