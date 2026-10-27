# design-25: read-write VM shares let the guest plant code the host will run, and path checks miss aliases

**Severity:** High. **Surface:** VM shared folders, "copy to host", mount validation (also sandbox mounts and folder grants). **Docs:** 05 §13 (Shared folders), §5.1 (mount validation); 02 §10.3. **Owners:** S14, S19, S21.

## Attack

1. **Planting host-executed config.** The owner shares `~/Projects/app` rw with the guest so the agent can code there. A compromised guest writes files that **host** tools execute without asking:
   - `.git/hooks/post-checkout`, `.git/config` (`core.fsmonitor`, `core.sshCommand`; see design-14), which run at the owner's next `git` command on the host;
   - `.envrc` (direnv runs it on `cd`), `.vscode/tasks.json` with `"runOn": "folderOpen"`, `.vscode/settings.json` pointing `python.defaultInterpreterPath` at a planted binary, `.idea/` run configs;
   - `package.json` `postinstall` / `prepare` scripts and `node_modules/.bin/*` shims, which run at the next `pnpm install` / `npm test`;
   - `Makefile`, `.npmrc` (`script-shell`), `.pre-commit-config.yaml`, a Python `sitecustomize.py` in a venv.

   No guest kernel bug is needed: this is SharedRoot's second half (a rw host mount) without the first. The default "read-only" helps only until the first rw grant, and the whole coding use case needs rw.
2. **Path-alias bypass of "never the home root".** The check "never `~`, `~/Library`, `/`, `$PSYCHE_HOME`" fails against aliases:
   - `/System/Volumes/Data/Users/owner` is the same directory as `/Users/owner` (firmlink), and Node's `realpathSync` returns it **unchanged** (verified, same inode);
   - `~/Projects/..`, `/Users/owner/`, `/Users/OWNER` (case-insensitive APFS), `/private/var/…` vs `/var/…`;
   - `~/link-to-home` where the link points to `~`; checking the string before `realpath` misses it, and `realpath` misses firmlinks;
   - a share of `~/Projects` that *contains* a symlink to `~/.ssh` (guest-side symlinks are resolved in the guest, but host tools following them inside the share are not).
3. **"Copy to host" traversal.** The guest proposes copying `report.pdf` to the host Downloads folder, with a guest-controlled file name `../../.zshrc` or a symlink. If the host-side copy resolves names or follows links, the guest writes anywhere the owner can.

## Assumption broken

"rw shares are a bridge only for kernel exploits." A rw share into a project directory is a code-execution bridge by design.

## Proposed control

- rw shares default to a dedicated **outbox** (`~/Psyche Shares/<vm>/<name>`), not the project. Sharing an existing project rw needs a second confirmation that names the risk, and the host applies a write filter: writes to `.git/**` (except objects and refs through an explicit "sync" action), `.vscode/`, `.idea/`, `.envrc`, `.npmrc`, `package.json` scripts and `**/node_modules/.bin/**` are blocked or flagged on the next host-side open.
- Validate paths by **identity, not string**: `stat()` → `(st_dev, st_ino)` of the candidate and each forbidden root (`/`, `~`, `~/Library`, `$PSYCHE_HOME`). Refuse when the candidate *is* or *contains* a forbidden root, comparing inode chains while walking up the parents. Also refuse any share containing a symlink whose target resolves outside it (scan at mount time and watch with FSEvents).
- "Copy to host": the host opens the destination with `O_NOFOLLOW | O_EXCL`, file name = basename only, NFC, no leading dot, no path separators.

## Test case

| # | Input | Expected |
| --- | --- | --- |
| 1 | share request `/System/Volumes/Data/Users/<me>` | refused (`forbidden_root`) |
| 2 | `/Users/<ME>` (case variant), `~/Projects/..`, `/Users/<me>/`, `~/homelink` (symlink to `~`) | all refused |
| 3 | rw share `~/Projects/app`; the guest writes `.git/hooks/post-checkout` | write denied or quarantined; host notification |
| 4 | the guest writes `.vscode/tasks.json` with `runOn: folderOpen` | denied / flagged |
| 5 | copy-to-host with name `../../.zshrc` | written as `.._.._.zshrc` in the outbox, or refused |
| 6 | share contains `docs -> /Users/<me>/.ssh` | mount refused (`escaping_symlink`) |
