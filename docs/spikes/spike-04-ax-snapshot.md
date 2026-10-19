# Spike 04: Accessibility-tree snapshots as the primary computer-use representation

- **Status:** done, 2026-10-19 (one-day time box)
- **Code:** [`spikes/ax-snapshot/`](../../spikes/ax-snapshot/README.md) (`./build.sh`, then `.build/axrun …`)
- **Machine:** MacBook Pro 14-inch (M5), macOS 27.0.1, Swift 6.4, Electron 44.9.0
- **Informs:** architecture §6 (`computer.*`), security §12 (TCC, hygiene), S14 (`apps/mac-helper`)

## Question

How good are Accessibility (AX) tree snapshots as the primary, screenshot-free way to drive Notes, Mail, Finder, System Settings, Safari (read-only) and an Electron app? What should the snapshot format look like?

## Answer: **AX-first works, with conditions**

All five tasks were done from the tree alone, with no screenshots and no Screen Recording grant. Two of them also needed a synthetic Return key.

A pruned snapshot of a real window costs 340–1,900 tokens. It takes 4–160 ms warm and up to ~450 ms on the first walk.

The tree is reliable for *finding* things. It is **not** reliable for *confirming* that an action took effect. Three problems drive most of the recommendations below:

1. **AX writes can report success and do nothing.**
   - `AXUIElementSetAttributeValue(AXValue)` returned `.success` on an element that has no `AXValue` at all (a Notes table attachment).
   - On a Finder list-view name field, the write changed the cell's displayed text without renaming the file. The UI then showed a name that did not exist on disk.
   - Every write must check settability first, read back, and where possible check an independent truth signal.
2. **Refs must be identity-keyed handles held by a long-lived helper.** The first version re-walked the tree on every CLI call and matched refs by DFS order plus role and label. After an intervening snapshot, `e34` silently pointed at a different element in a different note. Even identity-keyed refs need an `expect` check, because apps reuse views (see the ref stability rules).
3. **Chromium AX trees lag and go stale.**
   - Electron needs `AXManualAccessibility`. After the first set, the tree takes up to ~3 s to appear.
   - A backgrounded Electron window does not update its tree. A write lands in the DOM, but the AX value stays stale until some later event.
   - This is the main screenshot-fallback trigger.

Mail was not tested because no account is configured on this machine. Its list and message panes are `AXTable` and `AXWebArea`, which Reminders and Safari already cover. Mail is a follow-up for S14's manual test plan.

## Setup and permission prompts (in order)

1. **First run from a shell: silently untrusted.**
   - `AXIsProcessTrusted()` was `false` with no prompt.
   - The shell's process chain is `zsh → Claude Code CLI (claude.app) → Claude.app/Contents/Helpers/disclaimer → Claude`. TCC attributes the call to the *responsible* process, which here is the Claude Code CLI bundle. That bundle has no grant.
   - Fix: build a real bundle, `AXSnap.app` (`com.psyche.spike.axsnap`), and launch it through a 20-line launcher (`axrun`) that sets `responsibility_spawnattrs_setdisclaim`. This is the same SPI as Claude's `disclaimer`. TCC then checks `AXSnap.app` itself.
2. **Accessibility prompt.**
   - `AXIsProcessTrustedWithOptions(prompt: true)` showed the system prompt. The user enabled AXSnap in System Settings › Privacy & Security › Accessibility.
   - That single grant flipped `CGPreflightPostEventAccess` and `CGPreflightListenEventAccess` to `true` as well. No separate Input Monitoring prompt appeared.
3. **Rebuilds kept the grant.** The bundle was signed with an Apple Development certificate at a fixed path, and the grant survived about 20 rebuilds. The ad-hoc case was not re-tested, to avoid burning the user's grant. The research notes say ad-hoc identities change on every build.
4. **Screen & System Audio Recording: never needed.** `CGPreflightScreenCaptureAccess` stayed `false` for the whole spike.
5. **Automation: never prompted.** No Apple Events were sent; everything went through AX.
6. **In-app onboarding (Reminders).**
   - Reminders showed a "What's New" sheet first, then a "Never Miss a Reminder" sheet that pre-prompts for notifications. Both sheets are in the AX tree and have only a "Continue" button.
   - After them the sidebar showed a "Go to System Settings" banner. The second sheet was dismissed outside the tool, probably by the user.
   - Any system consent dialog lives in another process (UserNotificationCenter/SecurityAgent), outside the target app's tree. The agent must surface it, never click it.

The spike's first design for keeping refs alive was a local Unix-socket daemon. The session's safety classifier blocked it, and that was right: any local process could drive the UI through the TCC-granted binary (a confused deputy). The spike instead keeps refs alive for the life of one process (`axrun script`). The real helper must expose AX only over the authenticated node protocol, with a peer-credential check (S00 wire spec, spike 01 note).

## Recommended snapshot schema

### Text form (what the model sees)

```
# app=Notes pid=812 window="Notes" @247,137 1000x660 focus=e33 snap=3 nodes=57/332
[e1] window:standardWindow "Notes" {raise} @247,137 1000x660
  [e21] table "Notes list" @474,188 202x1034
    [e23] row "Groceries · 9:41 AM · milk, eggs" {custom:pin,custom:Share,custom:trash} selected @475,239 200x68
  [e33] textarea ="Groceries⏎milk, eggs" {set} focused @676,189 571x602
  [e62] toolbar @247,137 1000x52
    [e67] button "New Note" {press} @692,137 40x52
  [e80] button:closeButton {press} @265,155 16x16
[e84] textfield ="draft.txt" #ShrinkToFit Text Field {set} focused detached @321,277 104x16
```

The JSON form (`--json`) carries the same fields per node plus `depth` and `parent`. Use it for tooling, not for the model.

| Field | Source and rule |
| --- | --- |
| `ref` | `e<N>`. Monotonic per helper session and keyed by `AXUIElement` identity (`CFEqual`/`CFHash`). Never reassigned (see the stability rules below). |
| `role` | `AXRole` without `AX`, lowercased. Keep a short allowlist of subroles: `button:closeButton`, `textfield:searchField`, `textfield:secureTextField`, `row:outlineRow`, `radiobutton:tabButton`, `checkbox:switch`. Never use `AXRoleDescription`; it is localized. |
| `label` | In order: `AXTitle`, then `AXDescription`, then the `AXTitleUIElement` value. For buttons, links, rows, cells, menu items, tabs and pop-ups without a label, join up to 6 descendant texts with ` · ` and suppress those text children. At most 80 chars, truncated as `…(+N)`. |
| `value` | `AXValue` as a string, shown only when it differs from the label. Checkboxes and radios show `on`/`off`. Secure fields show `•••`. At most 160 chars; the full value comes from `computer.ax_value(ref)`. |
| `ph` | `AXPlaceholderValue`, only when the value is empty. |
| `#id` | `AXIdentifier`, only when developer-assigned (no `_NS`/`NS` prefix, no commas or brackets, ≤ 40 chars). Examples: System Settings `com.apple.settings.wifi`, Finder `#name`, Safari `WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD`. These are the most stable anchors there are. |
| `<url>` | `AXURL` on `webarea` and `link`. |
| `{actions}` | Short names: `press`, `confirm`, `cancel`, `menu`, `raise`, `inc`, `dec`, `pick`, `open`. Add `set` only if `AXUIElementIsAttributeSettable(AXValue)`. Show up to 3 custom actions as `custom:<Name>` (parsed from `"Name:pin\nTarget:0x0\nSelector:(null)"`), plus `+Ncustom`. Drop `AXScrollToVisible`, `AXShowDefaultUI`, `AXShowAlternateUI`, VoiceOver's `Move next`/`Move previous` and `Remove from toolbar`, and custom actions already listed on the parent. |
| flags | `disabled`, `focused`, `selected`, `secure`, `detached`. `focused` comes only from the app's `AXFocusedUIElement`; per-element `AXFocused` is `true` on every cell of a focused table. `selected` is inherited through hoisted wrappers. `detached` marks the focused element when the window walk cannot reach it (Finder's rename field editor). |
| `@x,y wxh` | Screen points, origin at the top-left of the primary display, as integers. Non-finite frames are dropped (one System Settings element reported inf/NaN, and `Int()` on it crashed the walk). |
| header | App, pid, window title and frame, the focused ref, the snapshot generation, `emitted/visited`, and `TRUNCATED(maxVisit\|maxEmit\|maxDepth)`. The model must see truncation. |

### Pruning rules (in order)

1. Drop the `AXScrollBar`, `AXColumn` and `AXGrowArea` subtrees. Columns repeat every cell already reachable through rows, and scrolling is an action, not an element.
2. Keep a visited set keyed by element identity. Tables expose cells through rows *and* columns.
3. Clip: drop subtrees whose frame does not intersect the window ∩ the nearest `AXScrollArea`/`AXWebArea`. Menus are exempt, since they report off-window frames.
4. In `AXTable`/`AXOutline`, walk `AXHeader` and `AXVisibleRows` only. `AXChildren` holds every row; Mail and Finder lists can have thousands.
5. Always keep landmarks (window, sheet, toolbar, table/outline/list, tabgroup, webarea, menu, popover) and interactive roles.
6. Keep any element with a meaningful action. Web "div buttons" carry `AXPress`.
7. Keep labelled text. Hoist (skip but walk into) unlabelled containers, unlabelled row/cell wrappers around a single control, zero-area unlabelled elements, children that echo their parent's label and add no new action, and text that repeats its parent's value.
8. Never descend into secure fields.
9. Always append the app's focused element if the window walk did not reach it.

Pruning and clipping cut 27–63% of tokens on native windows and about 50–95% on web content (see the table below).

### Limits (defaults)

| Limit | Value | Why |
| --- | --- | --- |
| Visit budget | 6,000 AX elements | The IPC cost bound. The largest window seen was 332. |
| Emit budget | 400 lines | About 8k tokens worst case; a real window was 57–159 lines. |
| Raw depth | **40**, as a safety cap only | **Depth ≤ 8 (S14 prompt, research default) is too shallow.** The Electron form lost all of its web content (7 of 19 nodes left) and Reminders lost its list rows (78 of 88). Use the visit and emit budgets, not depth. |
| Messaging timeout | 1 s per app (`AXUIElementSetMessagingTimeout`) | A hung app must not hang the helper. |
| Label / value | 80 / 160 chars | Use `ax_value(ref)` for the full text; a Notes body was 6.8k chars. |
| Menu bar | Off by default; `menubar: true` on request | 1.5–3k lines for big apps. Menu-by-path (`File>Rename`) is the better tool. |

### Ref stability rules

1. **Refs are server-side handles.** The helper keeps `ref → AXUIElement` and `identity → ref` tables for the session. The same element gets the same ref in every snapshot.
   - Measured reuse after one action: Notes 38 of 57 nodes (after creating a note), Reminders 76 of 92 (after adding an item), Finder 65 of 83 (after switching to list view).
   - Unchanged windows reused 100%.
2. **Never reassign a ref, and never derive refs from tree position.** Stateless DFS refs (`e34` = the 34th kept node) are unsafe. One intervening snapshot moved `e34` from the new note's body to a table attachment inside an existing note.
3. **Stale means error, not a guess.** On `kAXErrorInvalidUIElement`, return `stale_ref`; on `kAXErrorCannotComplete`, return `app_not_responding`. The model re-snapshots.
4. **Identity is not meaning.** Apps reuse views:
   - Notes keeps one `AXTextArea` element for whichever note is selected.
   - Reminders relabels the same toolbar button between "Add Reminder" and "Add Item" depending on the list.

   Therefore every mutating `computer.*` call carries `expect: {role, label?, valuePrefix?}`, copied from the snapshot the model acted on. The helper re-reads the element and refuses with `expectation_failed` on mismatch.
5. **Selectors are a convenience and must be unique.** `?role=substring` resolution must fail on zero *or multiple* matches. Picking the first match turned "Add" into "Add List: Groceries" and created a list (incident 2).
6. Evict refs that are not seen for N snapshots or M minutes, to bound memory. Eviction then behaves like rule 3.

## Per-app findings

The token columns use bytes/4. "Raw" is `--no-prune --no-clip`, still in the compact line format.

| App (window) | Warm median, n=10 | First walk | Visited | Emitted | ~Tokens | Raw ~tokens |
| --- | --- | --- | --- | --- | --- | --- |
| Notes (list + note) | 112 ms | 247–456 ms | 334 | 57 | 986 | 2,663 |
| Reminders (list) | 111 ms | 88 ms | 221 | 88 | 1,864 | 2,569 |
| Finder (list view) | 26 ms | 53 ms | 191 | 83 | 1,297 | 2,511 |
| Safari (social feed tab) | 10–50 ms | 396 ms | 49–308 | 31–159 | 621–3,140 | 6,000–11,100 |
| System Settings (Appearance) | 77 ms | 109 ms | 186 | 59 | 947 | 2,554 |
| Electron form (frontmost) | 4 ms | 13 ms | 36 | 19 | 342 | 555 |
| Claude desktop (Electron, background) | 3 ms | n/a | 14 | 5 | 81 | 151 |

Cost is almost all AX IPC: about 2.6–3.2 calls per visited element, at 0.03–0.2 ms per call warm and up to ~0.5 ms on a first walk. `AXUIElementCopyMultipleAttributeValues` fetches the 15 node attributes in one call, instead of one call each; the per-attribute variant was not measured. Safari varies with the page: the live feed changed underneath, so the same tab gave 49 to 308 visited elements a few minutes apart.

**Notes: create a note with title and body. Done, tree-only.**

- Steps: `press` "New Note", then `set` the focused `textarea` to `"Title\nBody"`. The first line becomes the title, and the read-back verified.
- Note rows expose `custom:pin`, `custom:Share` and `custom:trash`. `trash` is destructive and must be classified as such.
- Table attachments inside a note body appear as `link "table"` > `table` > rows, each cell with 7 custom actions.
- An empty new note is discarded when selection moves. The first attempt lost its note that way before the write, which led to incident 1.
- Edit › Undo's title ("Undo Add Note") is readable through the menu bar. It is a useful cheap check of what the app thinks the last edit was.

**Reminders: create a reminder. Done, tree-only.**

- Steps: `select` the list row (`AXSelected = true`), `press` "Add Reminder", `set ?focused`, then `confirm`.
- A clean tree. Each row gives the title, date and status in one collapsed label, plus custom Details, Flag, Delete, Indent, Move Up/Down and Move To Top.
- First launch blocks on two onboarding sheets (see permission prompts).
- The "Add List: Groceries" suggestion button sits in the same tree as normal controls and creates data when pressed (incident 2).

**Finder: open a folder and rename a file. Done. Each step needed one synthetic Return.**

- Opening the folder:
  - `menu File>New Finder Window` and `menu Go>Go to Folder` work through AX without opening the menus.
  - The path field accepts `set`, but neither `AXConfirm` on the field nor `AXOpen` on the suggestion's path components navigates. Both report success.
  - A pid-targeted CGEvent Return (`CGEventPostToPid`) was ignored. Return through the HID tap, after focusing the field, worked.
- Column view clips the target folder's contents off-window. Pressing the "list view" radio button makes them visible.
- Renaming:
  - **Setting `AXValue` on the row's name `textfield` is cosmetic.** The cell, the row label and the read-back all said `renamed.txt`, but the file on disk kept its old name.
  - The path bar at the bottom of the window kept the real name. It is a usable independent truth signal.
  - The real flow is `select` the row, then `menu File>Rename`. That opens a field editor that is *not* reachable from the window's children (hence `detached`). Then `set` the editor, and commit with a HID Return; `AXConfirm` and moving focus did not commit.
- Sidebar rows have AXDescription-based labels ("Applications · App Store letter A icon"), which are noisy but harmless.

**Safari (read-only): read the current tab's URL and title. Done, tree-only.**

- The URL comes from `AXWebArea.AXURL`. The title comes from the window title and the selected `radiobutton:tabButton`.
- The address field is `#WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD`.
- Web content is the expensive part. Clipping to the web area's frame is the single biggest token saver (11k → 0.6–3k tokens).
- Consistent with the fixed cap, the helper should expose Safari at the read tier only and drive the web through the agent browser (architecture §8).

**System Settings: navigation only (no settings changed).**

- The sidebar buttons carry stable `com.apple.settings.*` identifiers.
- Panes render as plain buttons, texts and sliders, with `AXTitleUIElement` label/value pairs ("Memory" = "16 GB").
- Appearance exposes `selected` on the active theme and a settable `slider`. The tree is good enough to change settings, which is exactly why settings changes stay behind a high-risk classification.
- The About pane exposes the serial number and the device name. Treat snapshot text as sensitive.

**Electron (local form, Electron 44.9): fill and submit a form. Done.**

- Waking the tree:
  - Without `AXManualAccessibility` the window is an empty group.
  - Setting it returns `.success`, yet reading it back always returns `false`. Do not use the getter to decide whether to set it; set it on every attach.
  - The web area appeared within ~3 s while the window was frontmost. A backgrounded launch stayed empty for over 10 s until the window was activated.
  - `AXEnhancedUserInterface` (Chrome's switch) returns `-25208` on Electron.
- What works:
  - Labels come from `<label>`. Placeholders map to `ph`, `role="button"` divs to `button {press}`, the checkbox to `checkbox {press}`, and the status div to `text`.
  - `AXSetValue` on text inputs fires DOM `input` events, so React-style controlled inputs should see it. That is worth one React check in S14's manual plan.
- What doesn't:
  - `<select>` exposes only its selected option, and `AXPress` does not open the native menu. Selection worked only with the app frontmost and a **keycode** event (`key o`). A unicode-string CGEvent (virtual key 0) was ignored by Chromium's typeahead.
  - `AXSelectedText` insertion does nothing in Chromium textareas.
- Read-back:
  - Chromium applies writes to its AX tree asynchronously. A read-back immediately after `set` showed the old value; 50–300 ms later it was correct while the window was frontmost.
  - With the window in the background, the DOM had the new value (the submit payload proved it), but the AX value stayed empty until the next event. It returned `UNVERIFIED` after 750 ms.
- The real Claude desktop app, backgrounded, exposed only window chrome (14 elements).

## Screenshot-fallback triggers

Fall back to `computer.screenshot` (and ask for Screen Recording at that point, not earlier) only when one of these holds:

1. **Sparse tree.** An Electron/Chromium window has no `webarea` after setting `AXManualAccessibility` and polling for ~3 s, or the window shows only chrome (fewer than ~10 emitted nodes for a non-trivial window).
2. **Unverifiable write.** A read-back does not match within 750 ms, especially in a Chromium window that is not frontmost. Prefer bringing the window forward and re-snapshotting before taking a screenshot.
3. **Truncation hides the target.** The header says `TRUNCATED(...)` and the element the model wants is not found after one narrower snapshot (sub-tree or `--app` root).
4. **Visual questions.** Layout, colors, images, charts and canvas content are not in the tree, nor are unlabelled image-only controls in third-party apps.
5. **Off-tree UI.** A focused element or popup appears only in the app-root walk (menus, popovers) or not at all.

Not a trigger: system consent dialogs (TCC, notifications, SecurityAgent). Those are surfaced to the user, never screenshotted and clicked.

## Guidance for S14 (`computer.*`)

1. **TCC identity and launch.**
   - Only `com.psyche.helper` holds Accessibility, and it must be its own responsible process: launched by launchd or LaunchServices, or spawned with responsibility disclaimed. It must never be a shell child.
   - Its own tool subprocesses are spawned disclaimed, so they do not inherit the grant.
   - Ship `scripts/tcc-reset.sh` and say "rebuilds with ad-hoc signing lose the grant" in contributor notes.
2. **No unauthenticated IPC.** `computer.*` is reachable only over the node protocol with a peer-credential check. No debug socket, FIFO or XPC listener without the same check.
3. **`computer.ax_tree` parameters.**
   - Parameters: `app` (or `pid`), `window?` (index or `CGWindowID`), `root?` (`window` | `app` | `ref`), `menubar?`, `maxVisit` (6000), `maxEmit` (400), `textMax` (80), `valueMax` (160), `clip` (true), `format` (`text` | `json`).
   - Return the header fields above plus `snapGen`.
   - Include the detached focused element.
   - `root: app` is how the model reaches popovers and app-level menus.
4. **Action ladder.** Each mutating call returns `ok | unverified | ineffective | refused | stale_ref | expectation_failed`.
   1. Semantic AX first: `AXPress`, `AXConfirm`, `AXPick`, `AXIncrement`, custom actions by name, `AXSelected = true` for rows and tabs, menu-by-path for app commands, and `AXValue` set *only* after `IsAttributeSettable` returns true.
   2. Verify. Read back with backoff (50/100/200/400 ms). For known-cosmetic fields (Finder name cells), require the app's real edit flow and an independent signal (path bar text, file system, list row).
   3. CGEvent fallback. Activate the app, focus the element through AX, then post through the HID tap. Use keycode events for named keys and typeahead, and unicode-string events only for free text. Do not rely on `CGEventPostToPid`, which Finder ignored. Mouse clicks go at the frame centre only after a fresh snapshot.
5. **Secure fields.** Refuse writes, redact values and do not walk inside them. This happens at the dispatch layer, below the model (`textfield:secureTextField`).
6. **Risk classification inputs.** Pass `role`, `label`, `custom:<name>` and the app to the PermissionBroker.
   - Labels and custom actions such as `trash`, `Delete`, `Remove`, `Clear`, `Send` and `Add List…`, and any System Settings mutation, map to high-risk classes.
   - Suggestion buttons that create data look exactly like ordinary buttons.
7. **Snapshots are untrusted, sensitive data.** They contain note bodies, reminders, account names and serial numbers. Mark them as provenance `untrusted` (web, mail and notes text can carry injected instructions), keep them out of logs except as hashes and counts, and apply the same redaction as screenshots.
8. **Electron.** Set `AXManualAccessibility` on every attach and poll for `webarea`. Prefer acting while the window is frontmost. Treat background read-backs as `unverified`. Handle `<select>` by keycode typeahead or a screenshot fallback.
9. **Tests.** Add the three incidents below as regression cases in S14's manual AX test plan (stale ref, ambiguous selector, cosmetic Finder rename). Add Mail and a React-based Electron form to the app matrix.

## Incidents during the spike (all on the user's real apps)

1. **Stale-ref write (Notes).**
   - The stateless CLI resolved `e34` to a table attachment inside an existing note instead of the new note's body. `AXSetValue` returned success.
   - Afterwards the note did not contain the written text. Edit › Undo still read "Undo Add Note", and the attachment has no `AXValue` attribute, so the write was a no-op.
   - The note's reported body length did differ by 47 characters between snapshots taken minutes apart. The spike could not attribute that to its own write, and it is flagged to the user to check.
   - Result: identity-keyed refs, the settable check and read-back verification.
2. **Ambiguous selector (Reminders).**
   - An unquoted `?button=Add Reminder` split into `?button=Add`, which matched "Add List: Groceries" first. That created an empty "Groceries" list.
   - There was no undo entry, and the list was left in place for the user to delete.
   - Result: selectors must match exactly one node, and commands reject extra arguments.
3. **Cosmetic rename (Finder).** The display/disk desync is described under Finder. It was resolved with the real rename flow.

Test artefacts left in place:

- A note titled "Psyche spike-04 test note".
- A reminder "Psyche spike-04 test reminder" in the Reminders list.
- The empty "Groceries" list.
- A scratch folder under the session's temp directory.
- A Finder window and System Settings, left open.
