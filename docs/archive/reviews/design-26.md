# design-26: backups bring back revoked authority, and channel session keys sit outside the vault

**Severity:** Medium. **Surface:** `psyche backup` / restore, Time Machine, Spotlight, "Download your data". **Docs:** 05 §14 (Backups, Export); 02 §12, §14. **Owners:** S22, S01, S10.

## Attack

1. **Restore resurrects revoked devices and grants.** A backup taken on Monday holds `state/psyche.sqlite`, with `devices.token_hash`, `grants` and channel allowlists. On Wednesday the owner's phone is stolen; they revoke it from the desktop (05 §10: "revoking a device revokes token and node authority permanently"). On Friday a disk problem makes them restore Monday's backup. The phone's token hash and its `operator.approvals` scope come back, along with a `site` credential grant the owner had revoked and a channel sender the owner had removed. Revocation is only as permanent as the newest backup the owner never restores.
2. **Channel session files are credentials outside the vault.** `state/channels/` holds WhatsApp (Baileys auth state: noise keys, signal identity) and signal-cli data. Those files *are* the account: copy them and you are the owner's WhatsApp on another machine. They are 0600 plaintext, protected only by FileVault, and included in every Time Machine backup of `~/.psyche`. Time Machine disks are often unencrypted, and these files also end up in any iCloud or Dropbox sync if `PSYCHE_HOME` is moved there.
3. **Spotlight and QuickLook index transcripts.** `state/psyche.sqlite` and `workspace/**/*.md` are plaintext under `~`. Spotlight indexes the Markdown, so private daily notes show up in system search and can feed other apps' system-wide indexing features.
4. **The age encryption key is unspecified.** "age-encrypted archive": encrypted to which recipient? If the archive key is a recipient whose identity file sits in `$PSYCHE_HOME` (needed for unattended scheduled backups), the backup is only as safe as the folder it backs up. If it is a passphrase, there is no strength policy. Restoring "needs the recovery key" only for the vault slot; everything else in the archive (transcripts, channel keys) depends on the age key alone.
5. **Export is a bulk-exfiltration button.** "Download your data" (threads, memory, grants, audit, `config.json`) is reachable from the web UI. Does it require `operator.admin` plus fresh presence like other security settings? Over public ingress, one stolen web session can download everything.

## Proposed control

- A **revocation epoch** stored outside the backup scope (the keychain, and a helper-signed counter). Restore compares epochs: if the backup is older, every device except the restoring one must re-pair, all standing grants drop to `revoked(restore)`, and channel allowlists are shown for review.
- Move channel session secrets into the vault (an item kind `channel_session`, encrypted blob); `state/channels/` keeps only non-secret state.
- `tmutil addexclusion` on `vault/`, `state/channels/` and `browser/profiles/`; a `.metadata_never_index` marker in `$PSYCHE_HOME`; `psyche security audit` checks both and warns when `$PSYCHE_HOME` is inside a cloud-synced folder.
- Backups are encrypted to an age recipient whose **identity is the recovery key** (or a passkey/YubiKey plugin), never to a key stored in `$PSYCHE_HOME`.
- Export requires `operator.admin` plus fresh presence, is audited, and is rate-limited.

## Test case

| # | Steps | Expected |
| --- | --- | --- |
| 1 | pair device D → backup → revoke D → restore | D's `connect` fails; it must re-pair |
| 2 | create `site` grant G → backup → revoke G → restore | G is `revoked`; `decide` does not match G |
| 3 | after setup | `tmutil isexcluded ~/.psyche/state/channels` → excluded; `~/.psyche/.metadata_never_index` exists |
| 4 | `psyche backup` | archive recipients do not include any key readable under `$PSYCHE_HOME` |
| 5 | `export.create` from a web device with `operator.read` + `operator.write` | `forbidden`; with admin but no presence → `presence_required` |
