---
"@psyche/protocol": minor
"@psyche/ui": minor
---

Touch ID presence key kind `enclave_keychain_acl`: for builds without a provisioning profile (a self-signed release), the Secure Enclave key's wrapped blob now lives in a login-keychain item that only the helper may read, sealed so a replaced item is never adopted. The Gateway accepts it in every build; the plain-file `enclave_file` key stays development-only. Settings › Devices names the kind. Existing development file keys are retired and registered again.
