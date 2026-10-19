# design-13: binding-hash canonicalization has collisions, and the two specs disagree on the fields

**Severity:** High. **Surface:** `bindingHash` / `canonicalJSON`, `verifyBinding`, origin matching. **Docs:** 05 §3.5; 04 §4.2; `packages/testing/src/canonical.ts` and `FakeCredentialBroker.bindingMatches` (S00 branch). **Owners:** S05 (real implementation), S00 / S18 (reference and fakes).

## Attack

The reference `canonicalJSON` that S00 shipped (and that S05 will copy) maps distinct values to the same bytes. Verified with Node 24 against `origin/ws/s00-bootstrap`:

| Input A | Input B | Same hash? |
| --- | --- | --- |
| `{a: NaN}`, `{a: Infinity}` | `{a: null}` | yes |
| `{m: new Map([["x","rm -rf /"]])}` | `{m: new Map()}` | yes (any Map, Set, Date or class instance → `{}`) |
| `{d: new Date(0)}` | `{d: new Date()}` | yes |
| `argv: ["cat","café.txt"]` (NFD) | `argv: ["cat","café.txt"]` (NFC) | yes |
| `[undefined]` | `[null]` | yes |
| `-0` | `0` | yes |

How this turns into an attack:

- **NFC folding of executed values.** The hash NFC-normalizes strings, but the executor runs the raw ones. On ext4 (the Linux sandbox) `café` in NFC and in NFD are **different files**. The owner approves `rm "café"` (shown NFC); the agent dispatches the NFD form and deletes a different file, or the reverse. Recipients, URLs and SQL in MCP args behave the same way. Normalization belongs in *display* and *comparison policy*, not in the hash of what runs.
- **Non-JSON values.** A connector that passes a `Map` of headers, a `Buffer` body or a `Date` into the fields hashes every such value identically, so the approval does not bind them.
- **Floats.** "Integer amounts" is a convention, not enforced: `19.99` and `19.990000000000002` serialize differently, and `1e21` becomes `"1e+21"`.
- **Origin "null".** `FakeCredentialBroker.bindingMatches` compares `new URL(x).origin`. Every non-special scheme yields `"null"`, so a binding `android://com.bank.app` (common in 1Password/Bitwarden imports) matches a target `foo://anything`. The fake's `catch` also falls back to comparing raw strings.
- **Spec drift.** 05 §3.5 and 04 §4.2 list different fields: exec (04 adds `sandbox id`); file write (05 "real path", 04 "absolute path"; see design-14 for the symlink consequence); credential fill (05 includes the field kind `username|password|totp`, 04 has `tab id` instead); purchase (05 "canonical host or Link merchant name", 04 "merchant origin"); form submit (04 adds `submit element ref`). Two implementers following different tables produce hashes that never match, and the obvious "fix" is to loosen verification.

## Proposed control

- Use RFC 8785 (JCS) over a **strict JSON value domain**: throw on `NaN`, `±Infinity`, `-0`, `undefined` inside arrays, non-plain objects (`Object.getPrototypeOf(v) !== Object.prototype`), `BigInt`, lone surrogates, and non-integer numbers in fields typed as amounts. Bytes are hex or base64 strings with an explicit type tag.
- Hash the **exact** strings that will be executed. Do not NFC them. If display normalization is wanted, add a separate `displayNormalized` field.
- Origin matching: refuse targets and bindings whose origin is opaque (`"null"`). Non-web bindings (`android://`) are not fillable in the browser.
- Make one table normative (05 §3.5), make 04 §4.2 a link to it, and add golden vectors (`tests/corpus/binding-vectors.json`) that S05 and the fakes must both pass (05 §15.4 item 2).

## Test case

```ts
import { bindingHash } from "@psyche/permissions";            // real implementation
for (const bad of [{a: NaN}, {a: Infinity}, {a: -0}, {m: new Map()}, {d: new Date()}, {a: [undefined]},
                   {b: Buffer.from("x")}, {amountMinor: 19.99}, {s: "\uD800"}]) {
  expect(() => bindingHash("exec", bad)).toThrow(/canonical/);
}
expect(bindingHash("exec", { argv: ["rm", "café"] }))
  .not.toBe(bindingHash("exec", { argv: ["rm", "café"] }));
expect(await creds.resolve("{{cred:app}}", { kind: "origin", value: "foo://x" }, apr))
  .rejects.toMatchObject({ code: "policy_denied" });          // binding android://com.bank.app
```
