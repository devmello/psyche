# Upgrade Psyche

An upgrade replaces the program, not your data. When the new Gateway starts, it updates its database in place. That step only goes forward, so you make a backup first and check the new version against your data before you start it.

Read the release notes before you begin. They list breaking changes and, for Docker, the new image digest.

## What an upgrade changes

- **Database** (`state/psyche.sqlite`): the Gateway applies new database migrations automatically when it starts. Migrations only go forward; an older version cannot read data a newer version has migrated.
- **Workspace** (`workspace/*.md`): plain Markdown files. The Gateway never rewrites them on upgrade.
- **`config.json`**: checked when the Gateway starts. A key this version rejects stops the Gateway from starting; `psyche migrate --check` reports it before you get there.
- **Vault and library**: not changed by an upgrade.

## 1. Make a backup

On a Mac or a Linux host with systemd, back up while Psyche is running. The Gateway takes the snapshot itself, with no downtime:

```bash
psyche backup create --recipient age1…
```

Leave out `--recipient` to use a passphrase. With Docker Compose:

```bash
deploy/backup/backup.sh /srv/psyche-backups age1…
```

Then check the backup opens. This is the file you restore if you need to go back:

```bash
psyche backup verify ~/.psyche/backups/psyche-<time>.tar.gz.age -i key.txt
```

With Compose, use `deploy/backup/verify.sh` instead. Details are in [backup-restore.md](backup-restore.md).

## 2. Install the new version

Pick the line that matches how you installed Psyche. The running Gateway keeps running for now.

**Desktop app with Homebrew:**

```bash
brew upgrade --cask psyche
```

**Desktop app from a DMG:** download the new `Psyche-<version>-arm64.dmg` (or `-x64` for Intel) and `SHA256SUMS`, check the hash as in [install.md](install.md#1-install-the-desktop-app), and drag the new Psyche into Applications, replacing the old one.

**CLI with Homebrew:**

```bash
brew upgrade psyche-cli
```

**CLI from a release binary:** download the new binary and `SHA256SUMS`, check it, and install it over the old one as in [install.md](install.md#install-the-cli-from-a-release).

Confirm the CLI is the new version:

```bash
psyche version
```

**Docker Compose:** in `deploy/.env`, set `PSYCHE_IMAGE` to the new image and digest from the release notes. Verify the signature as in [install.md](install.md#2-pin-and-verify-the-image). If the release notes say files in `deploy/` changed, update your clone of the repository too. Then download the image without starting it:

```bash
docker compose -f deploy/docker-compose.yml pull
```

**Unsigned app builds:** until the first signed release, each new build of the app has a new signature, so macOS forgets its permissions (Accessibility, Screen Recording, Microphone, Automation). Grant them again in System Settings when Psyche asks. You may also need to approve the app again under System Settings › Privacy & Security.

## 3. Check the new version against your data

Run the check with the **new** CLI, before the new Gateway starts. It is read-only: it never writes the database.

```bash
psyche migrate --check
```

With Docker Compose, run it from the new image:

```bash
docker compose -f deploy/docker-compose.yml run --rm --no-deps --entrypoint psyche gateway migrate --check
```

The last line says either `Safe to start Psyche <version> on this data.` (exit code 0) or `Do not start this version on this data yet.` (exit code 1). The lines above it explain why:

| Line | What it means | What to do |
| --- | --- | --- |
| `database: up to date` | Nothing to migrate. | Continue. |
| `database: … will apply at the next Gateway start: …` | Pending migrations. The new Gateway applies them automatically when it starts. | Continue. This is the step you cannot undo without your backup. |
| `database: no database at … yet` | A new install. | Continue. |
| `database: this build cannot list its migrations` | This CLI build cannot check the database. It is a warning, not a blocker. | Make sure your backup from step 1 verified, then continue. |
| `database: the data is from a newer Psyche` | You installed an older version than the one that last ran on this data. That is a downgrade, and the Gateway refuses to start. | Install the newer version again, or follow [Go back to an older version](#go-back-to-an-older-version). |
| `database: applied migration(s) differ from this build` | A migration that already ran is different in this build. | Stop. Do not start this build on this data. Report it as a bug with the output of `psyche migrate --check --json`. |
| `database: cannot read …` | The CLI could not open the database. | Stop the Gateway with `psyche stop` and run the check again. |
| `config: config.json: …` | `config.json` has keys or values this version rejects. The Gateway would not start. | Fix each one with `psyche config set <key> <value>`, then check again. |
| `backup: … day(s) old` or `no backup in $PSYCHE_HOME/backups` | Your newest backup in `$PSYCHE_HOME/backups/` is more than a day old, or there is none. | Make a backup (step 1). Backups written with `--out` or by the Compose scripts are elsewhere and are not counted; if you made one, you can continue. |
| `gateway: a Gateway <old> is running; this CLI is <new>` | The old Gateway is still running. Expected during an upgrade. | Continue to step 4. |

## 4. Start the new version

On a Mac or a Linux host with systemd, restart the Gateway service. It starts from the new program:

```bash
psyche restart
```

With Docker Compose, recreate the container from the new image:

```bash
docker compose -f deploy/docker-compose.yml up -d --wait
```

The Gateway applies any pending migrations as it starts. If it does not come up, read its logs:

```bash
psyche logs -n 200
```

With Compose, read the container's logs:

```bash
docker compose -f deploy/docker-compose.yml logs gateway
```

## 5. Check the result

Confirm the CLI and the Gateway report the new version:

```bash
psyche version
```

```bash
psyche doctor
```

```bash
psyche security audit
```

With Compose, run them inside the container (`docker compose -f deploy/docker-compose.yml exec gateway psyche doctor`) or from your laptop through your tunnel.

## Go back to an older version

Database migrations only go forward, so an older version cannot run on data a newer version has already started on. To go back, you restore the backup you made before the upgrade. Anything you did in Psyche after that backup is not carried back; it is kept in `$PSYCHE_HOME/.pre-restore-<time>/`.

### Mac, or Linux with systemd

1. Stop the Gateway:

   ```bash
   psyche stop
   ```

2. Install the older app and CLI from its GitHub release (DMG and binary), checking `SHA256SUMS` as when you installed.
3. With the **older** CLI, restore the backup from before the upgrade. Leave out `-i key.txt` for a passphrase backup:

   ```bash
   psyche backup restore psyche-<time>.tar.gz.age --force -i key.txt
   ```

4. Check that the older version accepts the restored data:

   ```bash
   psyche migrate --check
   ```

5. Start the Gateway. On a Mac:

   ```bash
   psyche start --psyched /Applications/Psyche.app/Contents/Resources/psyched/psyched
   ```

   On Linux, run `psyche start` with the same `--psyched` path you used when you installed.

### Docker Compose

1. In `deploy/.env`, set `PSYCHE_IMAGE` back to the older digest.
2. Download it and recreate the container without starting it, so the older Gateway does not try to start on newer data:

   ```bash
   docker compose -f deploy/docker-compose.yml pull
   ```

   ```bash
   docker compose -f deploy/docker-compose.yml up -d --no-start
   ```

3. Restore the backup from before the upgrade. The script restores with the older image and starts the Gateway when it is done:

   ```bash
   deploy/backup/restore.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
   ```

4. Check it:

   ```bash
   docker compose -f deploy/docker-compose.yml exec gateway psyche doctor
   ```

## For maintainers: the scripted round trip

`node deploy/scripts/upgrade-roundtrip.mjs` runs this whole path on throwaway homes with real processes: `migrate --check` on a fresh home, an online backup through a running Gateway, `migrate --check` on the live data, verify and restore into a second fresh home, `migrate --check` there, and a Gateway booting from the restored data. Point `PSYCHE` (and `PSYCHED`) at a release build to check it before tagging.
