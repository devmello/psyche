# Shared skills and connectors: one signed file, no store

Status: proposal v1 (2026-11-04). Phases 1 and 2 for skills are built (the PR "Shared skills: signed bundles"): the `.psyche-skill` file, export from Settings → Skills, import from a file or an https link, the author key, "trust this author", the key-changed warning, the diff and the "asks for more" warning on updates, and local revocation. Phase 3 (connectors) and phase 4 (lists) are designed here and not built. Applies to `packages/skills`, `packages/protocol` (`skills.*`), `packages/permissions` (the `skill_install` binding), `apps/gateway` and `packages/ui`. Roadmap entry: [future features §3](../roadmap/future-features.md#3-shared-skills-and-connectors).

**The ask:** export a skill (later a connector) as a file, send it to someone, and they import it, seeing what it asks for before anything is installed, and being told whether it is from someone they already trusted. No store, no account, no server run by Psyche.

**The short answer:**

- One UTF-8 JSON file, `name.psyche-skill`, holding a manifest, the payload tree and an Ed25519 signature over the manifest.
- Authors have a key made on their first export. Readers trust keys one at a time (TOFU), and are told when a key is new, when it is the same name with a different key, and when an update is signed by a different key than the installed version.
- Signing says who wrote it and that it was not changed on the way. It never says it is safe. Every import still goes through the scanner and the device-only `skill_install` card, and "trust this author" only changes a label.

## 1. What exists

`packages/skills` already installs a skill from a folder, a zip or a git URL at a pinned ref. The fetched tree is scanned, hashed as a whole (`treeHash`), shown in full on a trust card, approved with a device-only `once` `skill_install` card whose binding covers the name, source, tree hash and the declared tools, approval kinds and prompt files, then written and pinned in `skills.lock.json`. Every load re-hashes the folder, and a mismatch turns the skill off (`hash_mismatch`). Trust levels are `bundled`, `verified`, `local` and `unknown`; third-party text (`unknown` and `verified`) reaches the model marked as data, not instructions.

What was missing is a way to hand a skill to someone in one piece, and a way for the reader to know who made it.

## 2. Non-goals

- A central store, an account, or any server Psyche runs. A file, a link or a git repo is the whole distribution story.
- Making third-party skills safe by signing them. Signing is identity and integrity.
- Auto-update. Updates are proposals that need a new card, as today.
- Running connector code in this PR (§8).

## 3. The bundle format

One file, `.psyche-skill`, at most 8 MiB (the 5 MiB tree limit as base64, plus the manifest). JSON, so the signature does not depend on an archive format's quirks (central directory vs local headers, duplicate entries, symlink modes, extra fields).

```json
{
  "psyche-bundle": 1,
  "manifest": {
    "format": "psyche-skill",
    "kind": "skill",
    "name": "receipt-filer",
    "version": "1.2.0",
    "description": "...",
    "createdAt": "2026-11-04T12:00:00.000Z",
    "requests": { "tools": ["files.read"], "permissions": ["file_write"], "prompts": [] },
    "payload": {
      "treeHash": "sha256:...",
      "files": [{ "path": "SKILL.md", "size": 812, "sha256": "...", "executable": false }]
    },
    "author": { "name": "Ada", "keyId": "sha256:...", "publicKey": "<base64url Ed25519>" }
  },
  "signature": "<base64url, 64 bytes>",
  "files": [{ "path": "SKILL.md", "data": "<base64>" }]
}
```

**What the signature covers.** The bytes `"psyche-bundle-v1\n"` followed by the canonical manifest (keys sorted, no whitespace, integers only). The manifest names every file with its SHA-256 and the whole-tree hash, so the signature covers the payload through those hashes. The domain prefix keeps a signature from being replayed as anything else a key signs. `author` is inside the signed manifest, so swapping the key invalidates the signature.

**Verification, in this order, before anything is written or shown as installable** (`verifyBundle`):

1. Size at most 8 MiB; JSON; exactly the known fields and no others anywhere. There is no field for a link, a target or a mode, so a symlink cannot be expressed, and an unknown field is an error rather than ignored.
2. Caps: file count, per-file bytes and total bytes, the same limits as folder installs (200 files, 1 MiB, 5 MiB). The base64 length is checked before decoding.
3. Paths are taken as written and must already be normal: relative, `/`-separated, no `..`, no empty or `.` segments, no backslash, no NUL, not absolute, no `.git` or `__MACOSX` or `LESSONS.md`, no duplicates, no two paths that differ only by case or Unicode form. A path that would need normalizing is refused, not repaired.
4. Each file's size and SHA-256 equal the manifest's; the manifest lists exactly the files in the payload; the tree hash equals the one in the manifest.
5. The signature verifies over the manifest with the author's key, the key id is the fingerprint of that key, and a bundle with an author must carry a signature and the other way round. A signature that does not verify is an error. It is never downgraded to "unsigned".
6. **The declared requests equal what the payload requests.** `requests` must equal what `SKILL.md` (frontmatter `allowed-tools`, `requires.tools`, `permissions`, `prompts`) actually declares, and the manifest name and version must equal the skill's. A signed lie is still refused.

After verification the tree goes through exactly what a folder import goes through: policy check (a manifest that asks for `exec_host`, `skill_install` and so on is refused before any card), the static scanner over every file, the VirusTotal hash lookup if the owner turned it on, and the card.

**What a bundle can never carry:** a private key, a secret, a setting, a grant or an approval. The payload is a skill folder; `LESSONS.md` (the owner's own approved lessons) is never exported or imported.

## 4. Author keys

- **Algorithm and place.** Ed25519, made on the first export, in `$PSYCHE_HOME/identity/author.key`: the same JSON JWK format and modes as the Gateway identity key (directory 0700, file 0600, created with a link so two exports cannot make two keys, a file that exists but is not a key is an error and never replaced). It is outside the workspace, outside the vault and outside the backup scope, and the file tools treat `~/.psyche` as protected. It never leaves the Mac: only the public key and the signature go in a bundle.
- **Key id.** `sha256:<hex>` of the raw public key, the same format as a device fingerprint.
- **Name.** The author's display name, asked once on the first export, signed into every bundle. It is a claim. The key is the identity.
- **Who can sign.** Only the owner, through `skills.export` (admin scope, a Settings action). It signs only what the owner has approved: a workspace skill with a lock entry, a skill Psyche made that the owner approved, or one already signed with this key, and only while its files still match the approved hash and have no high scan findings. A skill someone else wrote is refused, so the owner's key never vouches for it, and the agent cannot get an unreviewed draft signed by writing it into the workspace.
- **Rotation and loss.** Not built. Deleting the file makes a new key on the next export; readers see "changed" (§5) and decide. A signed rotation statement ("this key is replaced by that key") is designed in §9.

## 5. Trust, with no central authority

Trust is a per-key record on the reader's Mac: `$PSYCHE_HOME/skills/authors.json` (0600, next to `skills.lock.json`, so the agent cannot write it). A key enters it when the owner approves an install signed by it (`seen`). It becomes `trusted` only by the owner's explicit act: the "Trust this author" box on the card (honored only together with the approved install), or Settings → Skills → ⋯ → Trust this author. It becomes `revoked` by the owner's act (§9).

What the card says, in the order it checks:

| Status | When | Install trust level |
| --- | --- | --- |
| `unsigned` | no signature | `unknown` |
| `own` | signed by this Mac's author key | `local` |
| `trusted` | key the owner trusted, and not a different key than the installed version's | `verified` |
| `changed` | the claimed name has signed with another key before, or this skill was installed with another key, or it was signed and the update is not | `unknown`, red warning, plus a `signer-changed` finding |
| `seen` | key met before, not trusted | `unknown` |
| `new` | key never met | `unknown` |
| `revoked` | key the owner revoked | refused (`policy_denied`) |

- **"Signed by X, new key"** is TOFU: the first sight of a key proves nothing about who holds it. The card says that, shows the fingerprint, and does not trust it. A name copied from someone the owner trusts, with a different key, shows as `changed`, which is the point of keying the name check on what has signed before.
- **"Key changed since last time"** also fires for a skill that was installed with key A and is now offered with key B, even if B is trusted. The warning shows, and the install is `unknown`; the owner can tick "Trust" again on that very card if they know why.
- **What `verified` means** is exactly: signed by a key this owner chose to trust, and nothing else. It does not mean safe, and the model still reads the text as third-party data (the prompt and `skills_read` mark `verified` the same as `unknown`).
- **Trust never skips a card.** Every install and every update of a bundle opens a device-only, `once` `skill_install` card. Trust changes a label and the warnings.
- **Un-trusting and revoking take effect at load**: a skill installed `verified` shows `unknown` once its key is no longer trusted, and a skill signed by a revoked key is `blocked`.

## 6. Import

Sources: a file the owner picks in Settings → Skills (`skills.proposeImport`, the client reads the file and sends its text), an https link (`skills.proposeInstall` with `bundleUrl`), or the existing git source at a pinned ref (a repo may also hold `.psyche-skill` files, which the owner points at by link). Reuse, not a parallel path: all of them end in the same `#propose` → card → `skills.install`.

**URL fetch.** https only, no credentials in the URL, no `localhost`, `.local`, `.internal`, single-label or IP-literal host, at most three redirects each re-checked against the same rules (so a redirect to http or to a local address fails), 8 MiB cap by header and by streamed bytes, 30 s timeout, no cookies or credentials sent, the body is only ever parsed as a bundle. Host names are not resolved first, so a hostile DNS answer is not caught; the damage is bounded because nothing fetched is executed and a response is verified like a file. The URL is the source in the lock, so "Check for updates" re-reads it. A file import has no address, so its update is importing the new file.

**The card** is the existing trust card, extended: who signed it (§5) with the key fingerprint, the requested tools, approval kinds and prompt files, every file with its text, the scan findings, the source, and for an update the file diff and what it asks for beyond the installed version. The approval details carry `signerStatus`, `signerKey` and `widened`, and the approval summary says "signed by X: new" or "unsigned bundle". The binding covers the author key and the source, besides what it covered before, so a card approved for one signer cannot install the same files under another.

**Third-party text is data.** Bundle text (description, SKILL.md, every file, the author name) is rendered through the same sanitizers as other skill text, never concatenated into a prompt; once installed the skill follows the existing path (`trust` attribute, `skills_read` marks it untrusted). An instruction aimed at the agent in a bundle is a high scanner finding, which keeps the skill off.

**The agent cannot export, import or trust.** There are no agent tools for any of it (`skills_search` and `skills_read` stay read-only). The methods are `operator.admin` and side-effecting (`skills.export`, `skills.proposeImport`, `skills.authors.set`), reached only by an authenticated owner client; installing needs the device-only approved card; and a skill cannot declare them as tools (`SKILL_FORBIDDEN_TOOLS`). Author-key creation, trust, un-trust and revoke are audited (`skill.author_key_created`, `skill.author_trusted`, `skill.author_untrusted`, `skill.author_revoked`).

## 7. Updates

- A bundle imported from a link is re-fetched by "Check for updates" and staged by "Review update", like git. A file import is updated by importing the new file; the loader finds the installed skill of that name and builds the update view.
- **The diff** is the existing per-file unified diff against the installed tree.
- **Widening.** The proposal lists `widened`: tools, approval kinds and prompt files the new version requests that the installed one did not. The card shows them first in red, adds a `permissions-widened` finding and puts "asks for more than before" in the approval summary. Narrowing is quiet.
- **Re-approval.** An update is a new proposal with a new binding over its own manifest, so a card approved for the narrower version cannot install the wider one (`binding_mismatch`). There is no silent update path to weaken: nothing installs without a new device-only card, and widening is what the card is built to put in front of the owner.
- **Signer changes** (different key, or a signed skill updated unsigned) show the §5 warning and the install is `unknown` unless the owner trusts the new key on that card.
- Every load re-hashes the installed tree against the lock. A bundle imports no loader code, so this is unchanged: edit an installed file and the skill turns off.

## 8. Connectors (phase 3, designed, not built)

An MCP connector runs code, and `mcp.probe` / `mcp.add` already hold the real review: the probe starts the server and lists its tools, the trust card shows the `tools/list` hash, and `mcp.add` refuses a server whose list changed. Wiring a second install path onto that flow is a larger change than this PR and touches the sandbox and secrets paths, so it is left as a follow-up rather than bent to fit.

The format reserves `kind: "connector"` and fixes what it may and may not carry:

- **May carry:** the command as an argv list (never a shell string), the working-folder-relative files of a local server (the same tree rules as a skill), the environment variable *names* it reads, plus literal values only for names that are not secret-shaped, and the network it says it will reach (host names, advisory: only the sandbox can enforce it).
- **Never carries:** a secret value, a token, an OAuth client secret or a vault entry. It carries the *names* of the secrets it needs (`GITHUB_TOKEN`) with a one-line purpose, and the importing owner supplies the values through the existing secret prompts after install. A name that looks like a secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`) may not have a value in the manifest; the scanner's `secret` rule runs over every payload file.
- **Shown before install:** the command, the network, the env and the secret names, the files, and, after a probe, the tool list, all on the existing MCP install card, with the signer block above.
- **First run in the sandbox when one exists.** The first start of an imported connector runs in the sandbox, with the declared network, so the probe that produces the tool list is the first thing that executes. Where the sandbox cannot run it (a native binary, a host-only app), the card says it will run on the Mac with the owner's permissions and asks for that explicitly. The command line is part of the binding, so a changed command is a new card.
- A connector bundle's declared network and env are claims to be compared with what the probe and the sandbox observe, not a permission grant. They are shown as "what it says it needs".

## 9. Revocation without a server

Built:

- **Local revocation.** Settings → Skills → ⋯ → Revoke this author. The key is refused on import (even a proposal staged earlier cannot install), and skills installed from it show `blocked`. A key can be revoked before it was ever met (`skills.authors.set` with the key id), for when a warning arrives by other means.

Designed, not built:

- **A signed revocation notice**: a small file, signed by the author key being revoked (or by its rotation successor), naming a key id or a tree hash and a reason. Importing it revokes locally after a card. A thief with the key can only revoke, which is the safe direction; the key's owner can pass it around by any channel.
- **Key rotation**: a statement signed by the old key naming the new one. Importing it moves the owner's trust from the old key to the new one after the owner confirms, so a rotation does not look like a "changed" key.
- **A pull-based list** (phase 4): a git repo or URL with a small index file (bundle names, links, hashes and a `revoked` list) that the owner chose to follow. "Check for updates" reads it; Psyche runs no server and never follows a list the owner did not add.
- Expiry is deliberately not added: a bundle that stops working on a date is a failure mode for no security gain here.

What revocation cannot do is un-install on other people's Macs or reach someone who never hears of it. That is the honest cost of having no server, and the reason the first line of defense is the card.

## 10. Answers to the roadmap's open questions

1. **What "verified" means with no central authority.** A key the owner has trusted, by their own act, and nothing more. A key vouched for by someone the owner trusts is a useful later addition but needs a signed endorsement and a decision about whom the owner trusts, so it is left out of v1; when added it would show as "vouched for by X", never turn into `verified` by itself.
2. **How much can be shown about a connector before it runs, and should the first run be in the sandbox?** The static part (§8: command, files, env names, secret names, declared network) is shown from the file; the dynamic part (the real tool list) needs a probe, so the probe is the first run and it goes in the sandbox when one can run it, and says so when it cannot.
3. **May bundles carry secrets or settings?** No. Secrets: only names. Settings and grants: nothing. The format has no field for them and the scanner refuses secret-shaped strings.
4. **Revocation without a server.** §9: local now; signed notices, rotation and followed lists later; no push to others.

## 11. Threat model

| Threat | Defense |
| --- | --- |
| File changed in transit or in a mirror | The signature covers the manifest, which carries every file's hash and the tree hash; unsigned files are `unknown` anyway |
| Attacker re-signs with their own key | A new key is `new`, never trusted; the same claimed name with another key is `changed`; an update with another key is flagged |
| Author is malicious (signed and bad) | Signing is not safety: scanner, full-file card, device-only `once` approval, policy limits on what a manifest may declare, third-party text marked as data |
| Manifest understates what the skill asks for | Declared requests must equal what `SKILL.md` declares, signed or not; the card shows the real ones |
| Path traversal, absolute paths, symlinks, special files, zip bombs, huge files | A format with no way to say a link or mode; paths must already be normal; caps checked before decoding; no archive extraction |
| Downgrade: strip the signature, keep the files | An unsigned update of a signed skill is flagged and is `unknown` |
| Update quietly asks for more | `widened` shown in red, a new binding over the new manifest, a new card |
| Agent installs, exports or trusts by itself | No agent tools, admin-scope owner methods, device-only approved card, tools forbidden to skills, audit trail |
| Agent gets an unreviewed skill signed with the owner's key | Export requires an owner-approved lock entry and an unchanged hash; third-party skills are refused |
| Author key stolen | 0600 file in a 0700 directory like the identity key, protected folder for the agent's file tools; revoke and rotate by §9 |
| SSRF through the import link | https only, no IP or local host names, redirects re-checked, nothing fetched is executed |
| Tampering with an installed skill later | Whole-tree hash re-verified on every load |

## 12. What is built and what is left

Built: the format and verifier (`packages/skills/src/bundle.ts`), the author key and keyring (`authors.ts`), the URL fetch (`bundle-url.ts`), the loader's import, export, signer status, widening, trust and revocation, the protocol additions (`bundleFile` and `bundleUrl` sources, `skills.proposeImport`, `skills.export`, `skills.authors.list`, `skills.authors.set`, `trustAuthor` on `skills.install`, `bundle`, `widened` and `signer` fields), and the Settings → Skills UI (import, export, signer and widening on the card, trust and revoke on a row).

Left: connector bundles (§8), signed revocation notices and key rotation (§9), the list format (phase 4), a CLI `psyche skills export` and `import`, and Swift (phone) surfaces for the new fields.
