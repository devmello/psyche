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

The guarantee after this PR, as precisely as it holds: *a program that writes Psyche's database or runs `psyched`'s commands, without reading Psyche's key files and without running code as the Gateway, cannot add a device, a presence key, a grant or an approval that Psyche will act on, cannot switch Touch ID off at once, and cannot do any of it unseen. Whatever it changed is put back (while the seal verifies) or simply not trusted (once it does not), and every device shows it.* Three narrow exceptions remain, listed in §8: the first admin of a fresh install, a rollback of the whole database to an older copy taken while the Gateway was stopped, and a write that lands in the microseconds between a check and the read it guards.

## 7. What this PR builds

### 7.1 The seal

- **Key**: 32 random bytes in `$PSYCHE_HOME/security/state-seal-key.json` (0600 in a 0700 folder, outside the backup scope like the revocation ledger and the anchor key). Its id (a hash) is stored with the seal, so a replaced key is noticed. A key file that does not parse is moved aside (`…corrupt-<time>`, never deleted), a new key is made and the state is untrusted (`key_corrupt`); the Gateway still starts. The file also records, outside the database, that presence was ever enrolled (D8) and the seal's generation at the last clean stop.
- **What is sealed**: the tables in §2 and every setting except the cosmetic ones a non-admin device may change (`isUserSettingKey`) and the event counter. Only the Gateway writes settings, so sealing more costs nothing.
- **On disk**: `security_ledger(tbl, pk, row, mac)` holds every sealed row's canonical JSON (fixed columns per table, `apps/gateway/src/security/seal-spec.ts`) and `HMAC(K, tbl ‖ pk ‖ row)`. `security_seal` holds `agg` (it starts from `HMAC(K, "agg-init" ‖ key id)` and XORs in `HMAC(K, "agg" ‖ mac)` per entry), `gen` (bumped by every ledger change), `state` and its own `mac` over format, key id, `agg`, `gen` and `state`. An empty ledger with a zero aggregate, a copied or edited seal row, a deleted, replayed or forged entry: none verifies without `K`.
- **In memory, the shadow**: the canonical JSON of every sealed row as the Gateway itself last committed it. It is built at a trusted check and kept current from the Gateway's own writes (a TEMP trigger notes each key; the next check with no foreign commit in between reads it back). Nothing outside the process can change it, so during a run it is the authority: repairs come from it, never from a ledger that fails.
- **Who writes the ledger**: SQLite `TEMP` triggers on the Gateway's own connection, calling functions registered there as *direct-only*, with `trusted_schema = OFF`: a trigger or view planted in the main schema cannot call them (`unsafe use of psyche_seal_mac()`). Every Gateway write to a sealed table, from any package, foreign-key cascades and bulk deletes included, updates the ledger in the same statement and transaction. `BEFORE` triggers refuse (`ABORT`) a Gateway update or delete whose old row is not the one in the shadow, and an insert of a key the shadow has but the file lost: the Gateway never seals a change somebody else made, even in a read-modify-write.
- **Planted schema objects**: at every start, whenever `main.schema_version` changes and at every full check, every trigger and view in the main schema that names security state (a sealed table, `nodes`, `security_*`, `_migrations`) is dropped and the state becomes untrusted (`schema_tampered`); a sealed table whose columns, types, defaults or keys differ from this build's migrations (checked against an in-memory database migrated at start, about 90 ms once) is untrusted too. TEMP objects die when `temp_store` changes, so the seal sets it first and re-counts its triggers whenever `temp.schema_version` changes.
- **When it is checked**: at every start, before revocations are replayed or policy is read; and before every read that authorizes something: the signed connect, every dispatched method, every setting and device read (a read guard in `@psyche/db`), the Permission Broker's store, presence verification, the broker's device approver and the channel store. A check is three cached pragmas (`data_version`, the two `schema_version`s); the full comparison runs after another connection committed, after a schema change, and at least every 30 seconds. A 1-second timer checks too. `security/revocations.jsonl` is applied at every full check, not only at boot.
- **While the seal verifies** (fail closed, destructive): rows that differ from the shadow are put back in one transaction. A row added outside Psyche is revoked (devices, with their connections closed and a revocation-ledger entry; grants; setup tokens), invalidated (approvals) or deleted (settings, passkeys, policy rules, channel identities, trusted senders). Inside an open transaction the check cannot repair; it refuses the call (`unavailable`) and repairs at the next check.
- **When the seal fails** (a seal row or entry that does not verify, a broken aggregate, a generation lower than this run saw or than the last clean stop recorded, a replaced or corrupt key, a missing seal with a key on disk, a reset the audit log contradicts, a planted schema object, a failed repair, an unverified restore): the state is **untrusted**, recorded under the row MAC so it survives restarts. Nothing is destroyed: changed and removed rows are put back from the shadow (that only restores what the Gateway knew), added rows are left in the file but trusted for nothing. Then:
  - presence fails closed (`presence_required`, `details.reason: "state_untrusted"`): no device approvals, setup tokens, presence keys, passkeys, security settings, first-admin bootstrap, Touch ID approvals or alert acknowledgements;
  - a device has only what the shadow says: one added or widened since the last trusted check is refused or narrowed. Untrusted since boot (nothing known to be genuine), every device is read-only at most, which gives a same-user program nothing it could not read from the files;
  - grants, approvals, channels and identities the shadow cannot vouch for are not returned to the broker or the channel service, and sealed settings read the shadow's value (untrusted since boot: the file's, see §8);
  - revoking, denying, removing a presence key and cancelling a recovery still work on a device's stored scopes, so the owner can lock things down;
  - only `psyched security reseal`, 24 hours later, clears it.
- **First seal**: on the first start of this version (no key, no seal, no `security.state.sealed` entry in the audit log), the current state is sealed as it is, and the owner gets one notice listing how many devices were sealed. If the key or the audit log shows an earlier seal, a missing seal is a reset: untrusted.
- **A restored backup** (the restore marker): the restored seal must verify with the key already on this Mac (a restore on the same Mac does); the owner is told it was restored. If it does not verify (another Mac, or a planted marker over tampered rows), the state is untrusted (`restore_unverified`) and needs the 24-hour re-seal (D9). A marker never clears an untrusted state.
- **Format changes**: the seal records its format. A migration that adds a column needs no change; a migration that rewrites a sealed column, or a new sealed column, bumps the format and verifies with the old specification before re-sealing. A test fails when a sealed table gains a column the specification does not list.

### 7.2 The CLI and the recovery route

`psyched devices approve`, `psyched devices grant` and `psyched presence reset` no longer write the database. They put a request in `security_requests`, an inbox anyone on the Mac can write and nothing trusts, and wait for the running Gateway (a request nobody answers is taken back; the Gateway counts the delay from when it first saw a request, never from the time the row claims):

- **First admin of a fresh install** (no admin device exists, presence was never enrolled, neither in the database nor in the key file, the state is trusted): applied at once, as before. It is audited and shown as an alert ("A command on this Mac made X (key …) the first admin device"). `devices.bootstrapAdmin` (the desktop's path) follows the same rule and raises the same alert (D8, built).
- **Narrowing waits too**: taking `operator.admin` from the owner's last admin device at once would make "no admin exists" true for an immediate first-admin approval right after it.
- **Otherwise**: the Gateway records a **recovery** in the sealed `security_recoveries` table and applies it **24 hours later** unless it is cancelled. A pairing approval must name the key the device showed (its fingerprint), and applies only if the device still has that key. The same request again joins the one that waits; at most 5 of one kind wait, and a presence reset or a re-seal has its own place, so a flood of one kind can neither bury nor block another. While untrusted, only a recovery the shadow knows is applied. During the wait every device shows a warning with **Cancel** and, when presence can verify, **Approve now** (Touch ID or a passkey; the card names the device, its key fingerprint and the scopes).
- `psyched recovery cancel <id>` cancels from the Mac: at most 5 an hour, each one an alert ("cancelled on this Mac"). A **re-seal** cannot be cancelled from the Mac, where any program could cancel it as fast as the owner asks; only an admin device the seal still trusts can.
- `psyched security reseal` asks for a re-seal of an untrusted state the same way (24 hours, never "approve now", since no verifier is trusted then).
- The CLI prints what happened and when it will apply; exit 0 applied, 1 refused, 3 waiting, 4 the Gateway did not answer.

A program on the Mac can still ask, like the owner can. It cannot make it happen quietly or quickly.

### 7.3 Alerts

`security_alerts` (sealed) keeps every incident: an undone change, an untrusted state, a first seal, a restore, a first admin made from the CLI or the app, a recovery requested, applied, cancelled or failed. Each is written to the audit log, sent as a `system` notification (the desktop inbox, the Mac's notification, the phone) and shown in a banner at the top of the desktop and web app until an admin acknowledges it (fresh presence once enrolled; never while untrusted). Repeated tampering keeps one open "changed outside" alert with a counter (`occurrences`) instead of a wall of them; its notification is updated at most every 10 minutes and only the first delivery breaks through quiet hours. Device names another program chose are shown without control or bidirectional characters and at most 64 characters, next to the start of the device key's fingerprint. An alert that disappears as it is written (a planted trigger) is still delivered and forces a full check. `security.state.get` (operator.read) lists them; `security.state.changed` tells clients to refresh.

## 8. Residual risk after this PR

| Same-user program | Before | After |
| --- | --- | --- |
| Edits a device, presence key, grant, approval, policy or channel row with `sqlite3` | works silently | put back before the next authorizing read (and within a second), shown on every device |
| Plants a trigger or view that writes security state on the Gateway's own writes (H1) | — | dropped at the next check (any schema change triggers one) and the state is untrusted; it cannot call the seal's functions; a Gateway write between the plant and that check could still run it once, and what it changed is then trusted for nothing |
| Empties the ledger and zeroes the aggregate, or edits the seal row (H2) | — | does not verify; nothing is revoked or deleted; untrusted, the owner's devices keep what this run knew; after a restart they are read-only until the re-seal; no first-admin shortcut (presence is remembered in the key file) |
| Deletes one ledger entry to get a real row revoked (H3) | — | nothing is destroyed; untrusted |
| Replaces the key file, then inserts an admin device (H4) | — | untrusted; the device is read-only at most |
| Replays an old genuine entry, or rolls back the sealed tables, ledger and seal row together while the Gateway runs (H5) | — | caught (the aggregate, or a generation lower than this run saw); the revoked device stays revoked from memory; untrusted |
| Rolls back the whole database to an older copy while the Gateway is stopped (a backup, a pre-update snapshot in `backups/pre-update/`) | works | caught when the Gateway last stopped cleanly (the key file records the generation); after a crash it is not; `revocations.jsonl` still revokes revoked devices and grants |
| Plants a restore marker (H6) | — | the restored seal must verify with this Mac's key; otherwise untrusted (a 24-hour re-seal); never clears an untrusted state |
| Runs `psyched devices approve <code>` while an admin exists | approves at once | 24-hour wait with a warning on every device; cancellable |
| Runs `psyched presence reset` | presence gate off at once | 24-hour wait with a warning on every device |
| Takes the first admin before the owner (fresh install) | works | still works, now with an alert (documented residual) |
| Takes the first admin after the owner revoked every admin device | works | refused once presence was ever enrolled (CLI and `devices.bootstrapAdmin`) |
| Floods the inbox | — | duplicates join one request; at most 5 of a kind wait |
| While untrusted since boot, edits a security setting or a channel row | — | **not judged**: nothing is known to be genuine then, so settings and channels read as stored; presence, admin and grants are still closed |
| Reads `security/state-seal-key.json` and writes sealed rows itself | — | **undetected**: needs D1/D3 |
| Stops `psyched` and runs its own, or attaches through `SIGUSR1` | works | **still works**; macOS reports a new background item; needs D3, and D4 to be seen |
| Writes in the microseconds between a check and the read it guards | — | that one read can use the changed row; the next check (at the latest within a second) puts it back and alerts |

## 9. Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Where the seal key lives. Built: a file in `security/`. Alternatives: the vault's key slot (Touch ID at every Gateway start on a signed build), or a helper-held login-keychain item (#1265's pattern) | Keep the file until D3 lands. A helper-held key is only worth it once the helper can tell the real `psyched` from a script on the same Node, which needs D3. |
| D2 | Recovery delay: 24 hours built | Keep 24 hours. Longer (72 hours) is safer but a locked-out owner waits three days. |
| D3 | Ship `psyched` as a signed single executable with the hardened runtime and `--disable-sigusr1` (self-signed works for keychain ACLs) | Yes, before a public release. It is the change that turns the seal from evidence into protection. Costs disk, not RAM. |
| D4 | The phone (and other paired computers) as a witness: keep the signed chain of security changes and alert on a rollback or a change the Mac does not explain | Yes, after D3. It is the only thing that catches a lying `psyched` or a whole-database rollback after a crash. |
| D5 | Encrypt `state/` with SQLCipher | Not for this threat (the boot key is reachable). Keep it on the privacy list for lost laptops and backups. |
| D6 | Untrusted state strictness. **Changed after the review**: devices are narrowed to what this run knew, or read-only when untrusted since boot; grants, approvals and channel rows nobody can vouch for are ignored; narrowing calls keep stored scopes | Keep what is built. The cost: after a restart into an untrusted state the owner works read-only for up to 24 hours (but can still revoke). |
| D7 | `config.json` is edited by hand on purpose. Fingerprint its security fields and show an informational alert when they change outside Settings? | Yes, as a small follow-up; never undo hand edits. |
| D8 | **Built**: `devices.bootstrapAdmin` follows the CLI's rule (only while presence was never enrolled, recorded in the key file too) and raises an alert | Keep. One flow changed: an owner who revoked every admin device after setting up Touch ID recovers with `psyched devices grant` (24 hours). |
| D9 | A restore on another Mac is untrusted until a 24-hour re-seal (the seal key does not travel). Alternative: put the seal key inside the age-encrypted backup, so a restore verifies anywhere the passphrase is known | Put the key in the encrypted backup. A program that knows the backup passphrase can already restore anything. |
| D10 | Approvals and alerts stay sealed forever, so a full check grows with them | Prune decided approvals older than the retention window (1 year) and acknowledged alerts older than 90 days, as a follow-up. |

## 10. Verification

Automated: `apps/gateway/test/state-seal.test.ts`, `seal-attacks.test.ts` (the review's H1–H6, M1 and M3 proofs of concept, each as a regression test), `security-recovery.test.ts`, the updated pairing, presence and bootstrap tests, the CLI integration test, and `deploy/scripts/upgrade-roundtrip.mjs`:

- the Gateway's own writes, from every package, keep the seal valid, upserts and cascades included; nothing changes for the owner;
- a write from a second connection to each sealed table is put back, with the right alert, at the next check and at the next start;
- a planted trigger is dropped and cannot call the seal's functions; an emptied ledger, a deleted entry, a forged seal row, a replayed entry, a rolled-back database, a replaced or corrupt key and a planted restore marker all make the state untrusted without destroying anything, and an inserted device gets nothing beyond read-only;
- `psyched devices approve` makes the first admin of a fresh install at once and waits 24 hours otherwise; duplicates join; a re-seal cannot be cancelled from the Mac; approve-now needs presence; a recovery applies on time with a fake clock;
- a restored backup boots and keeps its data.

Manual (needs a person, see the PR): the banner on the desktop and on a phone, the notification on the Mac, and "Approve now" with real Touch ID.
