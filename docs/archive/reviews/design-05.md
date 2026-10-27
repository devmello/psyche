# design-05: VM mode puts the compromisable guest above the host

**Severity:** Critical. **Surface:** VM mode, host vault as a node capability, desktop as a client of the guest Gateway. **Docs:** 05 §1.4, §13; 02 §10. **Owners:** S14, S19, S11, S06.

## Attack

VM mode exists because the guest runs untrusted computer use, browsing and skills, so the guest is the likely place for a compromise. Two design choices still give the guest authority over the host:

1. **The host desktop is a client of the guest Gateway** (02 §10.3). §1.4 calls the Gateway the TCB and says the desktop "never decides anything", yet in VM mode the desktop renders whatever the guest Gateway sends: approval cards, `view.*` RPCs ("the agent opens, closes and focuses panes"), Markdown, artifacts, notifications with deep-link `route`s, and file previews. A guest with root fakes approval cards ("Approve: save draft") that are really host-side capability calls. It drives `view.*` to open panes on host paths (`files.reveal`, `files.quicklook` are host helper capabilities), sends crafted HTML to the Electron renderer, and spams host notifications. A renderer bug becomes a host compromise: the CVE-2026-25253 pattern in reverse.
2. **The host vault releases plaintext to the guest** (§13 Credentials). The guest node asks for "one fill on `https://github.com`". The host shows the approval and Touch ID, then "releases one credential over vsock". The host cannot check the guest's claimed origin, tab or field: a compromised guest lies, receives the password, and keeps it. A `site` grant (§3.4) would make this silent for 30 days.

## Assumption broken

"The Gateway is trusted." In VM mode there are two Gateways, and the guest one runs next to the content §1.3 calls the primary adversary.

## Proposed control

- In VM mode the host desktop treats the guest Gateway as an **untrusted remote**: no `view.*` path that touches host files, no host helper capabilities, no host notifications with actions, artifacts and Markdown sandboxed exactly as for untrusted content, and a persistent "guest" badge on every card.
- Host-side approvals for guest requests are rendered by the **host** Gateway or helper from structured fields it validates (item, claimed origin), and labelled "the guest will receive this value in plaintext; if the guest is compromised it keeps it".
- Host-vault release to a guest: items need an explicit `vmAllowed` flag; release is `once` only (never `site`); Touch ID every time; rate-limited (for example 5 per hour); and audited as `credential.released_to_guest`, not as `filled`.
- Prefer a fill the guest never sees: the host types the value into the guest through the VM display's input path (the host helper sends keystrokes to the `VZVirtualMachineView` after the user confirms what is on screen), so the guest kernel sees keystrokes only for that field.

## Test case

| # | Setup | Action | Expected |
| --- | --- | --- | --- |
| 1 | guest node with a live `site` grant for `github-login` | guest `node.invoke vault.release {slug, origin:"https://github.com"}` | `ask` with Touch ID; the grant is ignored for guest requests |
| 2 | item without `vmAllowed` | guest release request | `denied` (`not_vm_allowed`) |
| 3 | 6 approved releases within an hour | 6th request | `denied` (`rate_limited`) |
| 4 | guest Gateway sends `view.open {pane:"files", path:"/Users/owner/.ssh"}` to the host desktop | — | refused; audit `guest_view_denied` |
| 5 | guest sends `approval.created` with `kind:"exec_host"` to the host desktop | — | not rendered as a host approval; host broker has no such request |
