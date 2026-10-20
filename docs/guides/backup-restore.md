# Back up and restore Psyche

A Psyche backup is one encrypted file, `psyche-<time>.tar.gz.age`. You can make it while Psyche is running, check it without restoring it, and restore it on the same machine or a new one.

## What a backup holds

| Included | Not included |
| --- | --- |
| `state/`: the database (threads, tasks, approvals, grants, receipts) and channel sessions in `state/channels/` | `cli/`: the CLI's device key (each machine pairs again) |
| `workspace/`: your agent's Markdown files | `run/`: sockets |
| `vault/`: the encrypted vault database | Logs |
| `library/`: files and recordings | Browser profiles |
| `audit/`: the audit log | Sandbox workspaces and VM disks |
| `config.json` | Earlier backups in `$PSYCHE_HOME/backups/` |

Every archive also holds a manifest with the SHA-256 of each file, so a damaged or altered archive is detected.

The vault inside a backup stays encrypted. On a new Mac you unlock it with the vault **recovery key**, because the macOS keychain entry does not travel with the backup. Keep the recovery key, and the backup passphrase or age key, somewhere other than the machine and the backup itself.

## Choose how to encrypt

**Passphrase.** The CLI asks for it (at least 12 characters). For scripts, pass it on stdin with `--passphrase-stdin` or set `PSYCHE_BACKUP_PASSPHRASE`. Anyone with the passphrase can open the backup.

**age key (recommended for scheduled backups).** The machine only needs the public key (`age1…`) to make backups; the private key that opens them can stay elsewhere, so someone who copies the backups from that machine cannot open them.

1. Install [age](https://age-encryption.org) on a computer you trust and create a key:

   ```bash
   age-keygen -o key.txt
   ```

   It prints the public key, `age1…`. Copy it.
2. Move `key.txt` off the Psyche machine (a password manager, an offline drive). You need it to verify and restore.
3. Pass the public key with `--recipient` (repeatable), or list several in a file and use `--recipients-file`.

`--no-encrypt` writes a plain `.tar.gz`. Do not use it: the archive holds your transcripts and the vault database.

## Make a backup

### From the CLI (Mac, or Linux with systemd)

```bash
psyche backup create --recipient age1…
```

Leave out `--recipient` to be asked for a passphrase. With the Gateway running, the Gateway takes the snapshot itself, without downtime, and the file lands in `$PSYCHE_HOME/backups/`. Copy it off the machine afterwards; a backup on the same disk does not protect you from losing the disk.

To write the file somewhere else, use `--out`. That path needs the Gateway stopped; `--stop` stops it for the snapshot and starts it again:

```bash
psyche backup create --stop --out /Volumes/Backup/psyche.tar.gz.age --recipient age1…
```

### From the app

Settings › Backups lists the archives in `$PSYCHE_HOME/backups/` (the same files the CLI makes). **Back up now** encrypts with a passphrase you type; it is sent once to the Gateway and not stored. You can verify and delete each archive there. Restoring is not offered in the app, because it replaces the Gateway's own data; use the CLI.

The panel also has a **Scheduled backups** setting (Off, Daily, Weekly, and how many to keep). The Gateway does not run scheduled backups yet; until it does, schedule them with cron or a systemd timer as below.

### With Docker Compose

The scripts in `deploy/backup/` run `psyche` in a one-off container next to the Gateway. They stop the Gateway for the snapshot and always start it again.

1. Create the backup directory once. It must be owned by uid 10001, the user in the image:

   ```bash
   sudo install -d -o 10001 -g 10001 -m 700 /srv/psyche-backups
   ```

2. Make a backup:

   ```bash
   deploy/backup/backup.sh /srv/psyche-backups age1…
   ```

   For a passphrase instead, set `PSYCHE_BACKUP_PASSPHRASE` in the environment and leave out the recipient.

## Schedule backups

Use an age recipient for unattended backups, so no passphrase sits on the machine.

**Mac or Linux, cron.** Edit your crontab with `crontab -e` and add a line. Use the full path that `command -v psyche` prints. This one runs daily at 03:15:

```bash
15 3 * * * /usr/local/bin/psyche backup create --recipient age1… --json >> "$HOME/.psyche/logs/backup.log" 2>&1
```

Scheduled CLI backups are not pruned. Delete old ones from Settings › Backups.

**Linux, systemd user timer.** Create `~/.config/systemd/user/psyche-backup.service`:

```ini
[Unit]
Description=Psyche backup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/psyche backup create --recipient age1…
```

and `~/.config/systemd/user/psyche-backup.timer`:

```ini
[Unit]
Description=Daily Psyche backup

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

Then enable it:

```bash
systemctl --user enable --now psyche-backup.timer
```

**Docker Compose, cron.** In the crontab of a user who can run `docker`:

```bash
15 3 * * * /opt/psyche/deploy/backup/backup.sh /srv/psyche-backups age1…
```

Copy the archives to another machine or storage afterwards.

## Verify your backups

A backup you have never checked is a guess. Verify regularly, for example after each scheduled run or once a week. Verifying decrypts the archive, extracts it to a scratch directory inside `$PSYCHE_HOME`, and checks every file against the manifest. The Gateway keeps running.

For an age-encrypted backup, point `-i` at your private key:

```bash
psyche backup verify ~/.psyche/backups/psyche-<time>.tar.gz.age -i key.txt
```

For a passphrase backup, leave out `-i`; you are asked for the passphrase. With Docker Compose:

```bash
deploy/backup/verify.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
```

`OK: <n> files from <time> verified` means the backup is good. Anything else, or exit code 1, means it is not; make a new one.

## Restore

Restoring replaces Psyche's data with the backup. The Gateway must be stopped. The CLI verifies the archive before it touches anything, and with `--force` it moves your current data to `$PSYCHE_HOME/.pre-restore-<time>/` instead of refusing. If the restore fails partway, it rolls back.

### On the same machine (Mac, or Linux with systemd)

1. Verify the backup (see above).
2. Restore it. `--stop` stops the Gateway first and starts it again afterwards:

   ```bash
   psyche backup restore psyche-<time>.tar.gz.age --stop --force -i key.txt
   ```

   Leave out `-i key.txt` for a passphrase backup.
3. Check that Psyche works:

   ```bash
   psyche doctor
   ```

4. When you are satisfied, you can delete `$PSYCHE_HOME/.pre-restore-<time>/`. Until then it is your way back.

### On a new Mac

1. Install Psyche and open it once, so the Gateway service exists ([install.md](install.md)). Skip onboarding; the backup brings your settings.
2. Install the CLI and copy the backup file and your age key (or passphrase) to the Mac.
3. Restore. The fresh, empty data is moved aside:

   ```bash
   psyche backup restore psyche-<time>.tar.gz.age --stop --force -i key.txt
   ```

4. Unlock the vault with its recovery key. The keychain entry from the old Mac does not travel:

   ```bash
   psyche vault unlock --recovery
   ```

   The CLI's device key is not in the backup, so the first time the CLI prints a pairing code instead. Approve it, then run `psyche vault unlock --recovery` again:

   ```bash
   /Applications/Psyche.app/Contents/Resources/psyched/psyched devices approve <CODE>
   ```

5. Remove devices that belonged to the old machine. Find them with `psyche devices list --all`, then revoke each one:

   ```bash
   psyche devices revoke <id>
   ```

6. Run the checks:

   ```bash
   psyche doctor
   ```

   ```bash
   psyche security audit
   ```

macOS permissions (Accessibility, Screen Recording and so on) are tied to the machine; grant them again when Psyche asks.

### With Docker Compose

`restore.sh` stops the Gateway, verifies and restores into the volume (moving existing data to `.pre-restore-<time>/`), and starts the Gateway again. The age key goes into the container on stdin and is never copied next to the backup.

```bash
deploy/backup/restore.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
```

For a passphrase backup, leave out `key.txt` and set `PSYCHE_BACKUP_PASSPHRASE` in the environment. On a new server, set up Compose first ([install.md](install.md)), restore, then unlock the vault:

```bash
docker compose -f deploy/docker-compose.yml exec gateway psyche vault unlock --recovery
```

## Export instead of backup

`psyche export` writes a readable copy of your data (threads as Markdown and JSON, memory, receipts, grants, Library files, the audit log, `config.json`, and vault entry names without their secrets). It is for reading and taking your data elsewhere, not for restoring Psyche.

```bash
psyche export --out ~/psyche-export
```
