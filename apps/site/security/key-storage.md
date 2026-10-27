---
title: Key storage
---

# Key storage

Psyche keeps every secret in one encrypted vault: website logins, API keys, connector tokens, SSH keys and your model provider's key. The model never sees a value, only a placeholder. This page explains how the vault is encrypted, where its key is kept, why unsigned builds keep that key in a file, and what the recovery key is for.

## The vault

- The vault is `$PSYCHE_HOME/vault/vault.db`, a SQLCipher 4 database (AES-256 per page, with an HMAC per page).
- It is opened with a random 256-bit key, the data-encryption key. That key is never stored in the clear next to the vault. It is wrapped by one or more key slots, kept in `vault/slots.json` and `vault/recovery.slot` (mode 0600).
- Secret values exist nowhere else on disk.
- When the vault is unlocked, the key stays in the Gateway's memory until it locks again: after 8 hours idle by default, or on lock.

The agent sees item names, kinds and the sites they are bound to, never values. It writes a placeholder such as `{{cred:github-login}}`, and the value is filled in only by an executor (the browser, a connector's HTTP client, one sandbox command), only on the bound site, and only after you approve. A placeholder anywhere else is refused and logged.

The vault refuses card numbers, CVVs, bank account numbers and government IDs when you try to add them. Payments go through Stripe Link instead; see [Credentials and payments](/using/credentials-and-payments).

## Key slots

| Slot | Where the key is kept | Used when |
| --- | --- | --- |
| Keychain | The macOS data-protection keychain, through Psyche Helper. Device-only, never synced, and reading it asks for Touch ID or your password. | The helper is signed with a Developer ID team and an embedded provisioning profile |
| Key file | `$PSYCHE_HOME/secrets/vault.key`: 32 random bytes, mode 0600, in a 0700 directory, passed to the Gateway as `PSYCHE_VAULT_KEY_FILE`. Unlocks without a prompt. | Unsigned or ad-hoc Mac builds, and servers |
| Recovery key | `vault/recovery.slot`: the vault key wrapped under a key derived (Argon2id) from your recovery key | Always, as the way back in |

The packaged Mac app picks the slot by itself. It gives the Gateway a key file only when the bundled helper cannot hold the Keychain slot. A vault that already exists with another slot is never switched.

## What an unsigned build means for your keys

The 0.3 alpha is built without a Developer ID unless the maintainer signs it. On such a build, macOS will not let the helper use a team keychain group, so the Keychain slot is unavailable and the vault key lives in the key file.

What that means in practice:

- **Any process running as you can read the key file and open the vault**, without Touch ID. That is the same reach a same-user process already has through the bundled CLI.
- **At rest, FileVault and your macOS account are the only protection.** Turn FileVault on.
- **The first admin device is claimed once.** On a fresh install the desktop app makes this Mac the admin device, in one atomic step that is logged as `device.bootstrap_admin` and then refuses forever. A process running as you could claim it first, before the app does. `psyche security audit` flags a Gateway with no admin device (`devices.no_admin`) or more than one bootstrap (`devices.bootstrap_repeated`).
- **macOS permissions can be lost on upgrade**, because an ad-hoc signature changes with every build. `psyche doctor` warns about this (`helper.signing`).
- **Approvals still apply.** Using a credential still needs your approval on a paired device, whatever slot holds the vault key.

A signed, provisioned helper removes the first point: the key then sits behind Touch ID.

## See which slot you have

- Settings → Credentials shows "Vault protected by", for example "a key file on this Mac".
- `psyche doctor` names the slot.
- `psyche security audit` reports `vault.key_file_only` (medium) for the key-file slot, `vault.recovery_unconfirmed` if you never confirmed the recovery key, and `vault.no_autolock` if auto-lock is off.

Settings → Credentials also shows "Move to Keychain", disabled. Re-wrapping the vault key for the Keychain slot is not built yet; it needs a signed helper.

::: info Screenshot placeholder
Settings → Credentials with "Vault protected by: a key file on this Mac", the disabled "Move to Keychain" button, and the item list below.
:::

## The recovery key

Onboarding creates the vault silently and shows the recovery key once, as groups of letters and digits, with a Copy button. You must click "I saved it" before you can continue. The key is never logged or written anywhere else.

You need it:

- to restore a backup on another machine, because the Keychain entry or key file does not travel with the backup;
- after re-enrolling your fingerprints, which invalidates the Keychain item;
- if the Keychain item or the key file is lost.

On a server, unlock with it after a restore:

```bash
psyche vault unlock --recovery
```

Store it in a password manager or on paper, away from the Mac and its backups. Without the recovery key and without the original slot, the vault cannot be opened.

## Model provider keys

A model provider key you enter in onboarding or Settings → Model & providers is a vault item named `model-<provider>`, bound to the provider's API origin. The model router reads it per request without asking. The agent can never list it, fill it or pass it to a command, and it is masked in logs. Backups carry it only inside the encrypted archive.

## Learn more

- [Backups](/security/backups)
- [What stays on your machine](/security/on-device)
- [Credentials and payments](/using/credentials-and-payments)
- [Install the Mac app](/get-started/mac-app)
- [docs/05 §4, Credential Broker](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#4-credential-broker-specification)
- [Release notes 0.3](/release-notes/0.3)
- [packages/vault](https://github.com/devmello/psyche/tree/main/packages/vault)
