# Security state integrity against same-user programs (2026-11)

Status: design and first implementation (PR `claude/security-state-integrity`). Companion to [05-security-and-permissions.md](../05-security-and-permissions.md) (asset A6, §2, §10) and [08-roadmap.md](../08-roadmap.md).

## 1. The problem

The threat model said Psyche protects its control plane (A6: devices, grants, policy, channel allowlists) against **local malware running as the owner**. An independent review showed that this did not hold:

- `state/psyche.sqlite` is a plain SQLite file. Any process running as the owner can open it and write a device row with `operator.admin`, add a presence key to `_presence.helperKeys`, insert an `always` grant, mark an approval approved, or widen a channel allowlist. The Gateway read those rows as the truth.
- The `psyched` CLI changed security state directly, with no Touch ID and no approval: `psyched devices approve`, `psyched devices grant` and `psyched presence reset` opened the database and wrote it.

None of this touched the keychain. The agent's own tools could not do it (the sandbox denies tool reads of `state/` and writes under `$PSYCHE_HOME`, see `compose/exec-host.ts`). Any other unsandboxed program running as the owner could.

Releases are self-signed: the owner declined the paid Apple program, so there is no provisioning profile, no keychain access group, no notarization. The design has to work on that build.

## 2. Security state that matters

| State | Where | What it authorizes | An attacker who edits it can |
| --- | --- | --- | --- |
| Devices (`devices`): key, scopes, role, family, paired/revoked | `state/psyche.sqlite` | every connection and its scopes; `operator.admin` reaches every admin method | pair their own key with `operator.admin`; un-revoke a device; widen a device's scopes |
| Presence keys (`_presence.helperKeys`) and enrollment (`_presence.enrolled`) | `settings` | Touch ID answers for security changes, purchases, credential fills, `exec_host` | register their own signing key; turn the presence gate off (`enrolled = false`) |
| Passkeys (`passkeys`) | `state/psyche.sqlite` | web presence assertions | add an authenticator they hold |
| Setup tokens (`setup_tokens`) | `state/psyche.sqlite` | a computer pairs itself without a second approval | mint a pairing link with any scopes |
| Grants (`grants`) | `state/psyche.sqlite` | standing permission for agent actions | add `always` grants; reset a grant's use counter; un-revoke |
| Approvals (`approvals`) | `state/psyche.sqlite` | a pending card's answer, `once` approvals checked at dispatch | mark a card approved |
| Policy (`policy_rules`, `permissions.*`, `exec.*`, `computerUse.*`, `vault.*`, `devices.*`, `gateway.*`, `identityLinks.*` settings) | `state/psyche.sqlite` | the Permission Broker's rules and floors | remove deny rules, lift floors, share folders, turn on `exec_host` |
| Channels (`channels`, `identities`, `commands.ownerAllowFrom`, `channels.*.dmPolicy/allowFrom/groupAllowFrom`) | `state/psyche.sqlite` | who may talk to the agent and who counts as the owner | make their own chat account the owner |
| LAN networks (`_lan.networks`) | `settings` | which interfaces the Gateway listens on | expose the Gateway on another network |
| Every other non-cosmetic setting (model, memory, sandbox, browser, connectors…) | `settings` | what the agent may reach and how | loosen a control nobody listed as security state |
| Trusted memory senders (`memory_trusted_senders`) | `state/psyche.sqlite` | whose mail becomes memory without review | make their own sender trusted |
| `config.json` | `$PSYCHE_HOME` | bind, proxies, deny rules | anything; the owner edits this file by hand on purpose |
| Key files: vault key file (unsigned builds), audit anchor key, Gateway identity key, handshake secret | `secrets/`, `security/`, `identity/`, `run/` | opening the vault; signing audit anchors; the Gateway's identity; desktop auto-pairing | everything the key allows (§3) |

## 3. What a same-user program can do today

The attacker is a program running as the owner, outside Psyche's sandbox, without root, without the owner's finger, and without the owner's login password. It cannot click a macOS prompt unless the owner does.

| Capability | Today |
| --- | --- |
| Read and write any file under `$PSYCHE_HOME` | yes (0600 files are the owner's) |
| Write security rows in `psyche.sqlite` | yes, silently; the Gateway trusts them |
| Run `psyched devices approve / grant`, `presence reset` | yes, silently |
| Read the vault key file on an unsigned build, the audit anchor key, the identity key, the handshake secret | yes (documented in §4.3.1 and §15.1) |
| Stop `psyched` and run its own Gateway on the same socket, or edit the LaunchAgent plist | yes (`launchctl` and `~/Library/LaunchAgents` are the owner's); macOS shows "Background item added" only for a new item |
| Run Psyche's own Node with its own script | yes: `psyched` is a script on a Node binary, so nothing on the Mac can tell "Psyche's JavaScript" from "any JavaScript" on that binary |
| Get code running inside the live `psyched` | yes: Node starts an inspector on `SIGUSR1` unless `--disable-sigusr1` is set, and it is not |
| Read a login-keychain item whose access list names only the helper | no: macOS prompts and names the reader (PR #1265 measured this); it can overwrite the item's data, which #1265 seals |
| Make the helper's Secure Enclave key sign | only behind a Touch ID prompt the owner must answer (the file key lets it choose the wording; #1265's keychain ACL key does not) |

## 4. What cannot be achieved on this build

Be clear about the ceiling. On a self-signed, profile-less macOS build, against a program that runs as the owner and **targets Psyche on purpose**:

1. **Prevention is impossible.** The attacker can stop `psyched` and run Psyche's own code with its own inputs. Any secret `psyched` can read at boot without the owner (it must start unattended at login), this program can read too, by running the same Node binary with a different script, or by attaching to the live process. A keychain item "ACL'd to psyched" names the Node binary, which runs any script.
2. **Rollback of the whole database** to an earlier copy (a backup, a copy taken earlier) cannot be detected from the Mac alone. Every monotonic counter that could catch it would live on the same disk.
3. **Hiding alerts** is possible for a program that patches or replaces `psyched`: it controls what the clients are told.

What *can* be achieved:

- The **cheap, silent paths** stop working: a row edited with `sqlite3`, a generic database tool, an old CLI, or the bundled CLI. Each is now refused or undone, and seen.
- The **remaining paths are Psyche-specific and loud**: read a particular key file and re-implement Psyche's seal format, or replace or attach to `psyched`. Psyche cannot stop them; it no longer helps them.
- **A phone or another computer is outside the attacker's reach.** It is the only witness that can catch a Mac whose `psyched` itself is lying (decision D4).

## 5. Options

| Option | What it does | Works on a self-signed, profile-less build? | Cost |
| --- | --- | --- | --- |
| **(a) Tamper evidence**: a MAC over the security tables, keyed by a secret the attacker cannot silently read | Out-of-band edits fail verification and are undone | **Partly.** The key can only be: (1) a file in `security/` (readable by the attacker, so evidence against untargeted tampering only); (2) a login-keychain item ACL'd to `psyched` (meaningless: the ACL names the Node binary); (3) a key the helper holds behind its own ACL (#1265's pattern), but the helper cannot tell the real Gateway from a fake one on its socket (the identity key and handshake secret are files), so it would MAC whatever it is asked; (4) the vault's key slot, which on a signed build asks for Touch ID at every Gateway start | One trigger per write, a full check after a foreign commit (milliseconds for hundreds of rows) |
| **(b) Out-of-band alerts and an append-only journal** | Every change not made through an authenticated Gateway call shows a persistent alert on every device and is written to the hash-chained audit log | **Yes**, for every change (a) detects. A patched `psyched` can suppress them (§4.3) | UI, i18n, one notification per incident |
| **(c) CLI hardening** | `psyched devices approve / grant`, `presence reset` no longer write the database; the Gateway applies them, at once only for the first admin, otherwise after the owner's Touch ID on a device or a visible 24-hour delay | **Yes** | Server-mode owners approve later devices from an admin device (they already had to, for every device but the first); lockout recovery takes 24 hours |
| **(d) Encrypt `state/` at rest** (SQLCipher) | Rows are unreadable without the key | Does not help here: the key must be available at unattended boot, so the attacker reads it the same way. It helps against a lost laptop or a leaked backup only | Every `state/` reader moves to SQLCipher; FTS and vector extensions need the cipher build |
| **(e) A witness off the Mac**: the phone keeps the last security-state digest and every change record, signed by the Gateway, and alerts on a rollback or an unexplained change | Catches what nothing on the Mac can (§4.2, §4.3) | **Yes** (no Apple program needed) | iOS work, protocol, a digest chain |
| **(f) A code identity for `psyched`**: a signed single-executable Node (SEA) with the hardened runtime and `--disable-sigusr1` | Lets a keychain ACL name `psyched` itself; stops `SIGUSR1` attach | **Partly**: a self-signed certificate is enough for an ACL (#1265 measured that legacy ACLs bind by designated requirement); library validation without a Team ID is weaker | Build pipeline, app size (owner prefers RAM over disk, so this is acceptable); the separate-Node layout changes |

## 6. Recommendation: the realistic bar

Build **(a) with a file key, (b) and (c)** now: they need no owner decision and remove every silent path. Say plainly that against a program that reads Psyche's key files or replaces `psyched`, they are evidence that a careful attacker can avoid, not protection. Then, as owner decisions: **(f)** before a public release, which makes (a)'s key unreachable without code execution in `psyched`, and **(e)** as the only answer to a lying `psyched`. Skip (d) for this threat.

The guarantee after this PR, in one sentence: *a security change made outside an authenticated Gateway call is refused or undone and shown to the owner on every device, unless the program making it reads Psyche's key files or runs code as the Gateway itself.*

## 7. What this PR builds

### 7.1 The seal

- **Key**: 32 random bytes in `$PSYCHE_HOME/security/state-seal-key.json` (0600 in a 0700 folder, outside the backup scope like the revocation ledger and the anchor key). Its id (a hash) is stored with the seal, so a replaced key is noticed.
- **What is sealed**: the tables in §2 and every setting except the cosmetic ones a non-admin device may change (`isUserSettingKey`) and the event counter. Only the Gateway writes settings, so sealing more costs nothing.
- **Ledger**: `security_ledger(tbl, pk, row, mac)` holds, for every sealed row, its canonical JSON (fixed columns per table, `apps/gateway/src/security/seal-spec.ts`) and `HMAC(K, tbl ‖ pk ‖ row)`. `security_seal.agg` is the XOR of `HMAC(K, "agg" ‖ mac)` over all entries: deleting, replaying or forging any entry changes it, and nobody without `K` can compute the new value (the macs themselves are visible, so the aggregate folds a second keyed value, not the macs).
- **Who writes it**: SQLite `TEMP` triggers on the Gateway's own connection, calling functions registered on that connection. Every write `psyched` makes to a sealed table, from any package, foreign-key cascades and bulk deletes included, updates the ledger in the same statement and transaction. A write from any other connection (another process, `sqlite3`, an older CLI) fires no trigger and has no key, so it leaves the ledger behind. TEMP objects die when `temp_store` changes, so the seal sets it first (the search index sets the same value, a no-op) and checks before every use that its triggers are still there; if they were not, it reinstalls them and the next full check undoes, and lists, what was written meanwhile.
- **When it is checked**: at every Gateway start, before revocations are replayed or policy is read; and before every read that authorizes something: the signed connect, every dispatched method (the device row is re-read there), the Permission Broker's store, presence verification, the broker's device approver and the channel store. The check is one `PRAGMA data_version`, which changes only when *another* connection committed; only then does the full comparison run. A 1-second timer does the same, so a change is seen within a second even with no traffic.
- **What a mismatch does** (fail closed): the Gateway restores the sealed state in one transaction. A row added outside Psyche is revoked (devices, with their connections closed and a revocation-ledger entry; grants; setup tokens), invalidated (approvals) or deleted (settings, passkeys, policy rules, channel identities, trusted senders). A changed row gets its sealed values back. A removed row is put back. Then an alert names what was undone. Inside an open transaction it cannot repair; it refuses the call (`unavailable`) and repairs at the next check.
- **When the ledger itself fails** (a missing seal with a key on disk, a replaced key, a broken aggregate, a seal reset that the audit log contradicts, a failed repair): the state is **untrusted**. Presence fails closed (`presence_required` with `details.reason: "state_untrusted"`), so nothing that widens access works: no device approvals, setup tokens, presence keys, passkeys, security settings, first-admin bootstrap, or Touch ID approvals. Revoking and denying still work. The alert stays until the owner re-seals, which takes the 24-hour recovery (§7.2).
- **First seal**: on the first start of this version (no key, no seal, no `security.state.sealed` entry in the audit log), the current state is sealed as it is, and the owner gets one notice listing how many devices and admin devices were sealed. If the audit log shows an earlier seal, the missing key and seal mean a reset: untrusted.
- **A restored backup** (the restore marker): the restored state is re-sealed with this machine's key and the owner is told. Revocations are then replayed as before, and are sealed like any other write.
- **Format changes**: the seal records its format. A migration that adds a column needs no change; a migration that rewrites a sealed column, or a new sealed column, bumps the format and verifies with the old specification before re-sealing. A test fails when a sealed table gains a column the specification does not list.

### 7.2 The CLI and the recovery route

`psyched devices approve`, `psyched devices grant` and `psyched presence reset` no longer write the database. They put a request in `security_requests`, an inbox anyone on the Mac can write and nothing trusts, and wait for the running Gateway:

- **First admin of a fresh install** (no admin device exists, presence was never enrolled, the state is trusted): applied at once, as before. Same reach as `devices.bootstrapAdmin`. It is audited and shown as an alert ("A command on this Mac made X the first admin device"). Once the owner had a Touch ID key or a passkey, an install with no admin left is a recovery like any other.
- **Narrowing waits too**: taking `operator.admin` from the owner's last admin device at once would make "no admin exists" true for an immediate first-admin approval right after it.
- **Otherwise**: the Gateway records a **recovery** (at most 10 waiting, so a flood stays a few visible requests) in the sealed `security_recoveries` table, with the time it first saw it on its own clock, and applies it **24 hours later** unless it is cancelled. During the wait every device shows a persistent warning with **Cancel** and, when presence can verify, **Approve now** (Touch ID or a passkey, bound to that recovery). `psyched recovery cancel <id>` cancels from the Mac.
- `psyched security reseal` asks for a re-seal of an untrusted state the same way (24 hours, cancellable, never "approve now", since no verifier is trusted then).
- The CLI prints what happened and when it will apply; exit 0 applied, 3 waiting, 4 the Gateway did not pick it up.

A program on the Mac can still ask, like the owner can. It cannot make it happen quietly or quickly.

### 7.3 Alerts

`security_alerts` (sealed) keeps every incident: an undone change, an untrusted state, a first seal, a re-seal after a restore, a first admin made from the CLI, a recovery requested, applied or cancelled. Each one is written to the audit log, sent once as a `system` notification (the desktop inbox, the Mac's notification, the phone), and shown in a banner at the top of the desktop and web app until an admin acknowledges it. Acknowledging needs fresh presence when presence is enrolled. `security.state.get` (operator.read) lists them; `security.state.changed` tells clients to refresh.

## 8. Residual risk after this PR

| Same-user program | Before | After |
| --- | --- | --- |
| Edits a device, presence key, grant, approval, policy or channel row with `sqlite3` | works silently | undone within a second or before the next authorizing read, and shown on every device |
| Runs `psyched devices approve <code>` while an admin exists | approves at once | 24-hour wait with a warning on every device; cancellable |
| Runs `psyched presence reset` | presence gate off at once | 24-hour wait with a warning on every device |
| Takes the first admin before the owner (fresh install) | works | still works, now with an alert (documented residual); `devices.bootstrapAdmin` (the desktop's path, any process with the handshake secret) is unchanged and also needs no presence |
| Takes the first admin after the owner revoked every admin device | works | waits 24 hours once presence was ever enrolled; `devices.bootstrapAdmin` still allows it at once (D8) |
| Floods the inbox with requests | — | at most 10 wait; the rest are refused |
| Deletes the seal or the ledger | — | untrusted: presence and every widening call fail closed until a 24-hour re-seal |
| Restores the whole database to an older copy (a backup, a pre-update snapshot in `backups/pre-update/`) | works | still undetected on the Mac (needs D4); revoked devices and grants are still revoked by the ledger replay |
| Plants a restore marker | — | the state is re-sealed as it is, with a "restored from a backup" alert the owner did not cause |
| Reads `security/state-seal-key.json` and writes sealed rows itself | — | **undetected**: needs D1/D3 |
| Stops `psyched` and runs its own, or attaches through `SIGUSR1` | works | **still works**; macOS reports a new background item; needs D3, and D4 to be seen |
| Races between the check and the read (microseconds) | — | the read can use the changed row once; the next check undoes it and alerts |

## 9. Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Where the seal key lives. Built: a file in `security/`. Alternatives: the vault's key slot (Touch ID at every Gateway start on a signed build), or a helper-held login-keychain item (#1265's pattern) | Keep the file until D3 lands. A helper-held key is only worth it once the helper can tell the real `psyched` from a script on the same Node, which needs D3. |
| D2 | Recovery delay: 24 hours built | Keep 24 hours. Longer (72 hours) is safer but a locked-out owner waits three days. |
| D3 | Ship `psyched` as a signed single executable with the hardened runtime and `--disable-sigusr1` (self-signed works for keychain ACLs) | Yes, before a public release. It is the change that turns the seal from evidence into protection. Costs disk, not RAM. |
| D4 | The phone (and other paired computers) as a witness: keep the signed chain of security changes and alert on a rollback or a change the Mac does not explain | Yes, after D3. It is the only thing that catches a lying `psyched` or a whole-database rollback. |
| D5 | Encrypt `state/` with SQLCipher | Not for this threat (the boot key is reachable). Keep it on the privacy list for lost laptops and backups. |
| D6 | Untrusted state strictness. Built: presence and every widening call fail closed; devices keep their scopes. Alternative: cap every device to `operator.read` | Keep what is built: capping locks the owner out of revoking a stranger, and an attacker who can reach this state could not add a device anyway. |
| D7 | `config.json` is edited by hand on purpose. Fingerprint its security fields and show an informational alert when they change outside Settings? | Yes, as a small follow-up; never undo hand edits. |
| D8 | `devices.bootstrapAdmin` (the desktop takes admin when none exists) needs only the handshake secret, which any same-user program can read. Apply the CLI's rule (only while presence was never enrolled), so that revoking every admin device does not hand admin to the first local program that asks? | Yes. It changes one flow: an owner who revoked all admin devices recovers with `psyched devices grant` (24 hours) instead of reopening the app. |

## 10. Verification

Automated (`apps/gateway/test/state-seal.test.ts`, `security-recovery.test.ts`, the updated pairing and presence tests, the CLI integration test, `deploy/scripts/upgrade-roundtrip.mjs`):

- the Gateway's own writes, from every package, keep the seal valid; nothing changes for the owner;
- a write from a second connection to each sealed table is undone, with the right alert, at the next check and at the next start;
- a deleted seal, a replaced key and a forged ledger entry make the state untrusted, and presence fails closed;
- `psyched devices approve` makes the first admin at once and waits 24 hours after that; approve-now needs presence; cancel works; a recovery applies on time with a fake clock;
- a restored backup boots, is re-sealed, and keeps its data.

Manual (needs a person, see the PR): the banner on the desktop and on a phone, the notification on the Mac, and "Approve now" with real Touch ID.
