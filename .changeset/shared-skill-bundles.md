---
"@psyche/protocol": minor
"@psyche/skills": minor
"@psyche/permissions": patch
"@psyche/ui": minor
"@psyche/gateway": patch
---

Shared skills: export a skill from Settings → Skills as one signed `.psyche-skill` file and import one from a file or an https link. A bundle carries a manifest (name, requested tools, approval kinds and prompt files), the payload tree and an Ed25519 signature over the canonical manifest, which names every file by hash. The author key is made on the first export (`identity/author.key`, 0600, never leaves the Mac). Imports go through the same scanner and device-only approval card, extended with who signed it (new key, known key, trusted author, "key changed"), a "Trust this author" step that only changes a label, the file diff on updates and a warning when an update asks for more. Unsigned bundles install as unknown. Authors can be un-trusted or revoked locally. Exporting needs the Host, a device-only card naming the skill, its tree hash and files (fresh presence once a verifier exists) and is audited; a bundle never installs as local and records whether Psyche wrote the skill; trusting an author is part of the card's binding and needs presence to loosen later; a skill's background role is part of what it asks for; links are resolved and pinned to public addresses. Design: docs/design/shared-bundles-2026.md. Connector bundles are not built.
