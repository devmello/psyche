# Move Psyche to another machine

You move Psyche with a backup: make an encrypted backup on the old machine, restore it on the new one with the same version of Psyche, then pair your devices again. This guide covers a Mac to a new Mac, a Mac to a Linux server with Docker Compose and back, and Compose to a systemd host and back. [backup-restore.md](backup-restore.md) explains backups in detail.

## What travels and what does not

A backup holds `state/` (the database and channel sessions), `workspace/`, `vault/`, `library/`, `audit/` and `config.json`. These do not travel:

- The device keys in `cli/`: the CLI on the new machine pairs as a new device.
- Sockets in `run/`, logs, browser profiles, sandbox workspaces and VM disks. The agent's browser starts signed out of every site.
- `security/`: the revocation ledger and the audit anchor key (see below). The new machine makes its own.
- The vault's key slot. On a Mac the vault key is kept in the keychain, which stays on the old Mac, so the new machine needs the vault **recovery key**. After `psyche vault unlock --recovery`, the Gateway stores the key in the new machine's slot when it has one (the keychain, through the Mac helper).
- Vault items you keep in the macOS keychain instead of the vault: their secrets are in the old Mac's keychain. Add them again.
- Anything outside `$PSYCHE_HOME`: `deploy/.env` (model keys, `PSYCHE_IMAGE`, `TS_AUTHKEY`), a Telegram token file, the Tailscale state volume, and macOS permissions (Accessibility, Screen Recording and so on).

Connector sign-ins kept in the vault travel with it.

Before you start, have the backup passphrase or age private key, and the vault recovery key, on the new machine.

## Paths

`$PSYCHE_HOME` is `~/.psyche` on a Mac and on a systemd host (for the user that runs the service). With Docker Compose it is `/data` inside the container: the named volume `psyche-home`. The CLI and the backup scripts handle the difference; you never copy directories by hand.

## Revoked devices, grants and vault items

Revocations that happened before the backup are in the database and stay in effect on the new machine.

The revocation ledger, `$PSYCHE_HOME/security/revocations.jsonl`, records every device revocation, grant revocation and vault item deletion (including revoked connector tokens). It is never in a backup. Every Gateway start replays it, so on the machine that has it, restoring an older backup cannot bring back a device, grant or vault item revoked after that backup was made.

The ledger does not move with you, so on the new machine:

- If no Gateway has run there yet, the first start after the restore cannot know what was revoked after the backup. It un-pairs every device and revokes every standing grant. You pair your devices and grant access again. Vault items stay.
- If a Gateway already ran there (you opened the app, or ran `docker compose up`), it has its own empty ledger, and devices and grants come back as they were in the backup. Revoke the old machine's devices yourself.

Either way, make your final backup after your last change on the old machine, and stop using the old machine once you have made it.

## Upgrading and moving at once

Move first, with the same version on both machines. Upgrade on the new machine afterwards, following [upgrade.md](upgrade.md). If something goes wrong, you then know which step caused it, and the backup you moved with is the one you go back to. `psyche version` on the old machine tells you which version to install.

## Mac to a new Mac

On the old Mac:

1. Make an encrypted backup. With Psyche running, the Gateway takes it without downtime and writes it to `~/.psyche/backups/`. Leave out `--recipient` to use a passphrase:

   ```bash
   psyche backup create --recipient age1…
   ```

2. Verify it, then copy the file to the new Mac:

   ```bash
   psyche backup verify ~/.psyche/backups/psyche-<time>.tar.gz.age -i key.txt
   ```

On the new Mac:

3. Install the same version of the app and the CLI ([install.md](install.md)). Homebrew installs the newest release; for an older one, use that release's DMG and CLI binary. Confirm the version:

   ```bash
   psyche version
   ```

4. If you opened the app, stop the Gateway. It stays stopped until you start it:

   ```bash
   psyche stop
   ```

5. Restore. `--force` moves any fresh data aside to `~/.psyche/.pre-restore-<time>/`. Leave out `-i key.txt` for a passphrase backup:

   ```bash
   psyche backup restore psyche-<time>.tar.gz.age --force -i key.txt
   ```

6. Check that this version accepts the data. It must end with `Safe to start Psyche <version> on this data.`:

   ```bash
   psyche migrate --check
   ```

7. Start the Gateway by opening the app, or from the terminal:

   ```bash
   psyche start --psyched /Applications/Psyche.app/Contents/Resources/psyched/psyched
   ```

8. Unlock the vault with its recovery key. The first time, the CLI prints a pairing code instead; approve it, then run the command again:

   ```bash
   psyche vault unlock --recovery
   ```

   ```bash
   /Applications/Psyche.app/Contents/Resources/psyched/psyched devices approve <CODE>
   ```

9. Pair your other devices again if they were un-paired, and revoke the old Mac's devices. Find them with `psyche devices list --all`:

   ```bash
   psyche devices revoke <id>
   ```

10. Grant macOS permissions again when Psyche asks, then run the checks:

    ```bash
    psyche doctor
    ```

    ```bash
    psyche security audit
    ```

## Mac to a Linux server with Docker Compose

1. On the Mac, make and verify a backup as in steps 1 and 2 above, and copy it to the server.
2. On the server, set up Compose for the **same version** ([install.md](install.md#on-a-linux-server-with-docker-compose)): pin `PSYCHE_IMAGE` to that release's digest, or use its `psyche-compose-<version>.tar.gz`. Add your model variables as in [server-mode.md](server-mode.md#docker-compose-on-linux). Do not start the Gateway yet.
3. Create the backup directory and put the backup in it. Both belong to uid 10001, the user in the image:

   ```bash
   sudo install -d -o 10001 -g 10001 -m 700 /srv/psyche-backups
   ```

   ```bash
   sudo install -o 10001 -g 10001 -m 600 psyche-<time>.tar.gz.age /srv/psyche-backups/
   ```

4. Create the container without starting it, so no Gateway runs on empty data:

   ```bash
   docker compose -f deploy/docker-compose.yml up -d --no-start
   ```

5. Restore. The script verifies the archive, restores it into the volume, and starts the Gateway. Leave out `key.txt` and set `PSYCHE_BACKUP_PASSPHRASE` for a passphrase backup:

   ```bash
   deploy/backup/restore.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
   ```

   The script starts the Gateway as soon as it is done, so there is no pause for `psyche migrate --check`. With the same version there is nothing to migrate.

6. Unlock the vault. The CLI in the container pairs first; approve its code, then run the command again:

   ```bash
   docker compose -f deploy/docker-compose.yml exec gateway psyche vault unlock --recovery
   ```

   ```bash
   docker compose -f deploy/docker-compose.yml exec gateway psyched devices approve <CODE>
   ```

7. Pair your laptop's CLI and the desktop app through a tunnel as in [install.md](install.md#5-pair-your-first-device), revoke the old Mac's devices, and run `psyche doctor`.

A server has no Mac helper and no agent browser; see [server-mode.md](server-mode.md#not-supported-yet). The server has a vault key slot only when `PSYCHE_VAULT_KEY_FILE` names a key file, which the shipped Compose file does not set; without it, each unlock needs the recovery key.

## From a Compose server back to a Mac

1. On the server, make a backup and verify it:

   ```bash
   deploy/backup/backup.sh /srv/psyche-backups age1…
   ```

   ```bash
   deploy/backup/verify.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
   ```

2. Copy the file to the Mac and follow steps 3 to 10 of "Mac to a new Mac".

## Between Compose and a systemd host

Both are Linux, so only the tools differ: the scripts in `deploy/backup/` for Compose, the `psyche` CLI for systemd. Read the limits of systemd units in [server-mode.md](server-mode.md#systemd-and-launchd) first: no release ships a `psyched`, and the unit passes no model variables.

**Compose to systemd.** Make and verify a backup with `deploy/backup/backup.sh` and `verify.sh` as above. Install the same version of `psyched` and the CLI on the host. Restore before the service first starts, then check and start it:

```bash
psyche backup restore psyche-<time>.tar.gz.age --force -i key.txt
```

```bash
psyche migrate --check
```

```bash
psyche start --psyched /usr/local/bin/psyched
```

Then unlock the vault, approving the CLI with `psyched devices approve <CODE>` on the host, and pair your devices again.

**systemd to Compose.** Make a backup with the CLI; with the Gateway running it lands in `~/.psyche/backups/`:

```bash
psyche backup create --recipient age1…
```

Then follow steps 2 to 7 of "Mac to a Linux server with Docker Compose". Afterwards, `psyche stop` on the old host keeps its service from starting again.

## If something is refused after the move

- `psyche migrate --check` says `the data is from a newer Psyche`: the new machine runs an older version. Install the version the old machine ran.
- A security change fails with `presence_required`: the old setup had a passkey or Touch ID key, and none can verify on the new machine (passkeys are tied to the Gateway's public origin). Run `psyched presence reset` on the new machine, then register a passkey or Touch ID key again.
- The vault stays locked: run `psyche vault unlock --recovery` again and check the recovery key. A backup cannot open the vault without it.
