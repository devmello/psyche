---
"@psyche/protocol": minor
"@psyche/ui": minor
---

Touch ID presence key kind `enclave_keychain_acl`: for builds without a provisioning profile (a self-signed release), the Secure Enclave key's wrapped blob now lives in a login-keychain item with a helper-only access list, sealed and audited so the helper refuses anything it cannot vouch for (`presence_key_untrusted`, shown in Settings › Devices) and never repairs it silently; `psyche-helper --reset-presence-key` is the owner's reset. The Gateway accepts only the `keychain` and `enclave_keychain_acl` kinds in every build (anything else needs `devices.presence.allowDevFileKey`) and flags a registration that replaces a different key. `--print-identity` is now read only. Existing development file keys are kept until the owner runs `psyche-helper --retire-legacy-presence-key`; register again.
