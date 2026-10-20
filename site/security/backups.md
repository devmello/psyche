---
title: Backups
---

# Backups

A backup holds your transcripts, memory, receipts and the vault, so it is as sensitive as the machine itself. Psyche writes every backup as one `age`-encrypted archive, checks it against a manifest before it restores anything, and never lets a restore undo a revocation you made after the backup. This page covers the security side. For the commands, scheduling and Docker steps, follow the [backup and restore guide](/guides/backup-restore).

## What a backup holds

| Included | Left out |
| --- | --- |
| `state/`: threads, tasks, approvals, grants, receipts, channel sessions | `security/`: the revocation ledger and the audit anchor key |
| `workspace/`: your agent's Markdown files | `cli/`: the CLI's device key (each machine pairs again) |
| `vault/`: the vault database, still encrypted | `run/`, logs, browser profiles |
| `library/`: files and recordings | Sandbox workspaces and VM disks |
| `audit/`: the audit log | Earlier backups |
| `config.json` | |

Every archive carries a manifest with the SHA-256 of each file, so a damaged or altered archive is detected before anything is restored.

## Choose how to encrypt

- **An age key** (recommended for scheduled backups). The machine needs only the public key (`age1…`) to make backups. Keep the private key elsewhere, so someone who copies the backups off the machine cannot open them.
- **A passphrase** of at least 12 characters. Anyone with the passphrase can open the backup. In the app, the passphrase is sent to the Gateway once and not stored.

`--no-encrypt` writes a plain `.tar.gz`. Do not use it: the archive holds your transcripts. `psyche security audit` flags unencrypted backups (`backups.unencrypted`) and backups older than 7 days (`backups.stale`).

Keep the backup key or passphrase, and the vault recovery key, somewhere other than the machine and the backup.

## The vault and the recovery key

The vault inside a backup stays encrypted with its own key. On the same machine it opens as before. On a new Mac it does not, because the Keychain entry (or the key file on an unsigned build) does not travel with the backup. You unlock it with the vault **recovery key** that onboarding showed you once. See [Key storage](/security/key-storage).

## What a restore does

Restoring replaces Psyche's data with the backup. It runs only from the CLI, with the Gateway stopped, and:

1. verifies the archive against its manifest before it touches anything;
2. with `--force`, moves your current data to `$PSYCHE_HOME/.pre-restore-<time>/` instead of refusing;
3. rolls back if it fails partway.

### Revocations are not undone

A backup is a snapshot. If you revoke a device, a grant or a vault item after making it, restoring that backup must not bring it back. Psyche records every device revocation, grant revocation and vault item deletion (including revoked connector tokens) in `$PSYCHE_HOME/security/revocations.jsonl`. That ledger is never put in a backup. After a restore:

- at the next start, the Gateway replays the ledger against the restored devices and grants;
- the vault drops recorded items from its metadata when it starts, and from the encrypted store when it unlocks (`vault.restored_items_dropped` in the audit log).

Restoring into a home with no ledger, such as a new machine where no Gateway has run yet, is treated more strictly. The Gateway cannot know what you revoked after the backup, so it un-pairs every device and revokes every standing grant. You pair your devices again and re-approve what you need. Vault items cannot be judged that way and stay. The [migrate guide](/guides/migrate) explains what to expect.

The audit log's anchor head is also reset to the restored log, and the reset is logged. Run `psyche audit verify` after a restore; see [Audit log and receipts](/security/audit-log).

## Deleting backups

Settings › Backups lists the archives in `$PSYCHE_HOME/backups/`. Delete needs an admin device, and once a passkey or the helper's Touch ID key is registered, fresh proof that you are present.

::: info Screenshot placeholder
Settings › Backups with two archives, each showing its size, "encrypted", when it last verified, and Verify and Delete buttons.
:::

## Known gaps

- The Scheduled backups setting in the app is saved, but the Gateway does not run scheduled backups yet. Use cron or a systemd timer, as the [guide](/guides/backup-restore) shows.
- Backups made by the CLI on a schedule are not pruned.
- A backup on the same disk does not protect you from losing the disk. Copy archives off the machine.

## Learn more

- [Backup and restore guide](/guides/backup-restore)
- [Move to another machine](/guides/migrate)
- [Key storage](/security/key-storage)
- [docs/05 §14, data handling and privacy](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#14-data-handling-and-privacy)
- [packages/backup](https://github.com/devmello/psyche/tree/main/packages/backup)
