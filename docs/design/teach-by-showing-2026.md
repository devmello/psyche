# Teach by showing: the built-in browser (2026)

**Status:** phase 1 built, 2026-11-04; weekly runs and encryption at rest added the same day (§5, §8). **Feature:** J8 in [03-feature-spec.md](../03-feature-spec.md), spelled out in [future-features.md §2](../roadmap/future-features.md#2-teach-by-showing). **Companion:** [the teaching loop](../agent/teaching-loop-2026.md), which learns from feedback ("not like this"). The two share lessons and marks. They do not share the recorder.

**The short version:**
- The owner presses **Record** on a tab of the built-in browser, does a task once, and presses **Stop**.
- Psyche shows the steps in plain words ("Open example.com", "Click ‘Export’", "Type the date into ‘From’"). The owner edits, reorders, deletes, and marks values as inputs.
- **Save** makes a skill draft through the existing owner-approved skill path, with the usual approval card. Nothing runs until the owner approves it.
- **Run it every week** (on the skill's page, once it is installed) puts the skill in Scheduled at a day and time the owner picks. It refuses a skill with a sensitive step or a value asked for each run, stops and tells the owner when a page changed, and waits for the owner at every approval (§8).
- **Run it once now** fills the message box with the skill. The agent runs it with the normal browser tools, so every action passes the permission broker, and it stops and asks when the page is not what was recorded.
- Passwords, card numbers, one-time codes and ID numbers are never recorded. Other typed values are hidden by default and kept only when the owner says so. Cookies and session contents are never read.

---

## 1. Scope

| In phase 1 | Not yet |
| --- | --- |
| The built-in browser's own tabs (the owner's, not the agent's) | Real Chrome (R-mode), Mac apps (phase 2, J1/J2; the Mac helper already has an accessibility recorder, `apps/mac-helper/.../Teach/`, with its own `TeachStep` in `schemas/teach.ts`) |
| Navigations, clicks, typing, choosing in a `<select>`, Enter | Drag, hover, file uploads, rich-text editors, keyboard shortcuts, cross-origin iframes |
| One skill draft per recording, run once now, run on a schedule (§8) | Scheduled runs that ask for values or hand a tab over (they are refused) |

## 2. Who can start a recording, and where it runs

Only the owner, from the browser pane's own button. That is a property of the wiring, not a rule the agent is asked to follow:

- The recorder lives in the desktop app's main process (`apps/desktop/src/main/browser/teach-session.ts`). The renderer reaches it over seven IPC channels (`psyche:teach:*`). The main process accepts them only from the app's own windows, and refuses them in a window that is a client of another computer's Gateway.
- There is no Gateway method, no `browser.*` tool and no bridge command that starts, stops, lists or reads a recording. `Runtime.addBinding` and `Page.addScriptToEvaluateOnNewDocument` are not on the bridge's CDP allowlist. Tests assert each of these (`packages/browser/test/teach-store.test.ts`).
- The one Gateway method involved, `skills.drafts.fromRecording`, takes the owner's **reviewed** steps (never a recording). It needs `operator.admin` and, on top of that, only the Psyche desktop shell on the Host may call it (the loopback connection that presents the per-launch handshake secret); a paired phone, a web client or a script with an admin scope gets `forbidden`. The draft remembers the device (`recordedOn`, set by the Gateway from the connection, never by the client) and the approval card names it.
- Record is disabled on a tab the agent is working in (a tab with a task). While a tab is recorded the owner holds it (sticky Take control) and the main process refuses every bridge CDP command for that tab, reads included, so the agent can neither act in it nor watch it.

```
owner clicks Record ─▶ renderer ─IPC─▶ TeachSession (main) ─▶ TeachRecorder ─CDP─▶ page
                                             │                    ▲
                    steps live in memory ◀───┘                    │ Runtime.bindingCalled
                                                                  │ (isolated world, trusted events only)
owner clicks Stop ─▶ steps ─▶ review screen (renderer) ─ Save ─▶ Gateway: skills.drafts.fromRecording
                                                                          └▶ skills.drafts.accept ─▶ approval card
```

## 3. What is recorded

A step names its target the way an assistive technology would, not by pixels:

| Step | Recorded | Plain words |
| --- | --- | --- |
| `navigate` | origin and path of the page; the first page, and a Back, Forward or Reload the owner pressed in the pane | Open billing.example.com/reports |
| `click` | accessibility **role** (from a fixed list) and **name**, plus a short CSS selector as a fallback | Click ‘Export’ |
| `type` | role, name, selector; the typed value is held for review only (§4) | Type the date into ‘From’ |
| `select` | the same, and the label of the option | Choose an option in ‘Range’ |
| `press` | Enter only, with the field it was pressed in | Press Enter in ‘Search’ |

How it records: `Runtime.addBinding` scoped by `executionContextName` to a named isolated world of the top frame, plus `Page.addScriptToEvaluateOnNewDocument` into that world, so the script survives navigations. The page's own scripts cannot see the world or call the binding. The binding and world names are random for each recording. The script listens in the capture phase and reports **only `isTrusted` events**, so a script on the page cannot make steps appear. The recorder accepts a report only from the top frame's context. It also listens for `Page.frameNavigated` on the top frame. A navigation is a step **only when the owner caused it with the pane's own controls** (Back, Forward, Reload: when the host really navigates, it tells the recorder where it is sending the tab) or it is the first page. The owner's window is one-shot: it accepts the first top-frame navigation within three seconds, only if it lands on the address the host sent the tab to, and it is used up by the first top-frame navigation of any address (a Reload, a redirect, a script) and by a same-document navigation, so a page that navigates on load cannot ride it. A navigation within four seconds of a click or Enter is that click's effect and gets no step. Anything else (a script, a meta refresh, a redirect, an ad) is page-caused: it gets no step, and the review screen says how many such changes were left out. A page therefore cannot write steps into a recording by navigating. The listeners are registered on `window` in the capture phase. On every page loaded after Record they come from the document-start script and run before the page's own listeners. On the page Record was pressed on, the script is injected after the page's own scripts, so a listener the page registered earlier runs first, and the ever-password and text-security checks cover only what happens after injection.

Limits: 200 steps (the recording ends and keeps what it has), 4 KB per report, 120 characters per name.

### Never recorded

| What | How it is kept out |
| --- | --- |
| The value typed into a **password, payment, one-time-code, ID-number or secret** field | The page script decides from the field alone (type, `autocomplete`, name, id, label, placeholder, in English and the shipped languages: `pass`, `pw`, `cvv2`, recovery or backup codes, seed phrases) and **does not read `value`**. A field that was ever `type=password` (seen at focus or key) stays sensitive when the page flips it to `text`, and so does a field drawn as dots (`-webkit-text-security`). The recorder decides again with the same rules (`classifyTeachField`, shared from `@psyche/protocol`), and a third time from the value itself (`classifyTeachValue`: Luhn-valid card numbers, `ddd-dd-dddd`, token-shaped strings). The review screen, the Gateway handler and the kept-recording store each clean the steps again (`sanitizeTeachSteps`). A sensitive step has no value, cannot be kept and cannot be an input. In the skill it reads "the owner does this themselves", and the agent hands the tab over with `browser.request_control`. |
| **Cookies, local storage, headers, response bodies** | The recorder issues no `Network`, `Storage`, `DOMStorage` or `Fetch` command and has no field for them. A test records a session and checks every CDP method it sent. |
| Query strings, fragments, opaque path segments | `teachUrl` keeps origin and path; a 24+ character token-like segment becomes `*`, and digits, emails and tokens in a path segment are redacted. |
| Card numbers, ID numbers, emails, tokens and long numbers in **element names and selectors** | The recorder and `sanitizeTeachSteps` run `redactTeachText` over every name, selector and path segment (`<number>`, `<email>`, `<token>`). |
| File inputs and rich-text editors | Skipped: a file path is private, and an editor cannot be read reliably. |
| Anything in another tab, another window or a cross-origin iframe | The recorder is attached to one tab and accepts only the top frame's world. |
| Screenshots and frames | None are taken. |
| What the recorder's channel carried, toward the Gateway | The main process drops the recorder's `Runtime.bindingCalled` and its world announcement before they can be forwarded to the Gateway's CDP driver, whatever domains the driver enabled. |

## 4. Typed values: masked by default

Every typed value in an ordinary field starts **hidden**: the review row says "Ask me each time" and the value is not on screen. The owner can change that per field:

| Choice | What is saved | What the skill does |
| --- | --- | --- |
| **Ask me each time** (default) | nothing | asks the owner for a value before it types |
| **Keep this value** | the value, as typed | types it as recorded |
| **Make it an input** | a name (`from_date`) and an optional description | asks the owner for `from_date` at the start of each run |

The example the owner typed exists in the recorder's memory (the main process) from Record until Stop, then in the review screen's memory until Save or Discard. It is sent to the Gateway only on a step the owner set to **Keep this value**. Choosing an input drops the example, so "example values become inputs" without storing them. A value that looks like a card number or an ID number cannot be kept, even in an ordinary field.

## 5. Where recordings live

- **By default, nowhere on disk.** The steps are in the main process's memory until Stop, and in the review screen until Save or Discard. After Save the review screen empties, and the main process already forgot the recording at Stop. Closing the app loses an unsaved recording.
- **Kept on request.** "Keep this recording on this Mac so I can make another version" writes the reviewed steps to `$PSYCHE_HOME/state/teach/<id>.json`: folder `0700` (re-applied on every write), file `0600`, written atomically, at most 20 files, expiring after 90 days, ids validated so a path cannot come through. What is written is the output of `sanitizeTeachSteps`: no example the owner did not keep, no sensitive value (there never was one), no query strings. The pane's "Kept recordings" list opens one for review again, or deletes it.
- **Encrypted.** With the OS keychain available, each file is AES-256-GCM (node `crypto`): a fresh 12-byte nonce for every write, the file's id as additional authenticated data, and a 32-byte per-install key kept in the user-data folder (`teach.enc.key`) wrapped by Electron `safeStorage`. The folder therefore shows no step names, addresses or kept values, and GCM itself rejects an edited, truncated or renamed file, so the format has no separate MAC. A file made with another key, or damaged, is ignored and logged (the log names the file and the reason, never its content); nothing throws. Files written by the first version (signed, plain) are verified against the old key and re-written encrypted the first time the store is used; one that does not verify is left alone, not listed, and logged.
- **No keychain, no keeping.** If `safeStorage` is not available, Psyche does not keep recordings at all: "Keep this recording" is off on the review screen with the reason, the main process refuses the write, and Settings, Browser, "Recordings you keep" says so. This was chosen over keeping a plain copy with a notice because the steps (page names, addresses, any value the owner kept) are the owner's private browsing, a recording is cheap to make again, and the skill (which the owner approved) is unaffected. Files from before that are still readable and deletable (their signature is checked).
- **Signed (older files).** Each plain file carries an HMAC-SHA256 over its id and contents, made by the desktop main process with a 32-byte key kept in the app's user-data folder (`teach.key`), outside `$PSYCHE_HOME`. The key file holds the key wrapped by the OS keychain (Electron `safeStorage`) when it is available (the first version wrote it unwrapped by mistake; an unwrapped signing key is now wrapped in place on first use, and only that key is ever adopted that way), so reading the file is not enough. It is opened with `O_NOFOLLOW`, created with `O_EXCL` at `0600`, and a file of the wrong size or one that cannot be opened is an error, never a silently new key. The user-data folder (`~/Library/Application Support/Psyche`, which also holds the device key) is denied to the agent's file tools, to host commands (read and write) and to MCP servers. A file that is unsigned, edited, signed with another key, or renamed to another id is not listed and not opened. Reads refuse links (`lstat`, `O_NOFOLLOW`), cap the size at 512 KB and pick the fields one by one.
- **Not in the Library.** `state/` is Psyche's own: no agent file tool reaches it (the prohibitions deny `state/teach` by name, `teach_recordings`), `files.read` serves only the Library, and the backup leaves `state/teach` out.
- **Encryption.** See "Encrypted" above. The file holds no secrets by construction, only the owner's own steps and any value they chose to keep; it is now also unreadable without the keychain.
- **Reach.** Only the desktop's main process opens the folder. No tool or method reads it.
- **The skill draft** is stored with the other skill drafts (`$PSYCHE_HOME/skills/.drafts/`, `0600`) and holds only the reviewed steps.

## 6. From recording to skill, and replay

### Skill, not automation, by default

The recording becomes a **skill** (instructions the agent follows, with the recorded steps as a reference), not an automation (fixed steps). Reasons:
- A page changes; an agent can recover from a small change and ask when it cannot. A fixed click sequence cannot.
- A skill never widens what the agent may do. Its `allowed-tools` declares the browser tools it uses; every call still goes through the broker, with the same side-effect classes, origin policy and approval cards.
- The owner decides, at two points: when they press Save (a recording becomes a *draft*, never an installed skill), and at the `skill_install` approval card, which shows the full `SKILL.md`, the tools it declares and the findings of the skill scanner, is device-only, and offers `once` only. Turning the skill into an automation is a separate, later choice (§8).

### The draft

`skills.drafts.fromRecording` validates the steps (`teachStepIssues`), cleans them again, and writes a `SKILL.md`:
1. **How to run it**: open the first address; before each step call `browser.check_target` with the step's role, name and origin; stop and ask when it does not answer `found`; never type into sensitive fields; ask for every input first.
2. **Inputs**: each named input, with the owner's description (the owner's own words, flattened to one line).
3. **Recorded steps (reference, untrusted page text)**: one line per step, in one fenced block.

Page text is **data, never instructions**. Names and addresses from pages appear only in the third section, each as a JSON string on one line with backticks and line breaks removed, so a name cannot close the block or open a heading. The instructions above never contain page text and say so. The roles are mapped onto a fixed list of accessibility roles (anything else is `generic`) in the recorder, in `sanitizeTeachSteps` and again when the skill is written, so a page cannot put text in a role. The Inputs section refers to inputs **by step number** and never repeats page text; input names default to `input1`, `input2` (not derived from page text), and the owner can rename them. The title is scrubbed like any owner text (emails, links, long numbers).

**Taint carries through.** The draft is `tainted` and its origin is `recording`. `skills.drafts.accept` decides from the **draft record**, not from the skill's text (which the owner can edit and a third-party skill can imitate): for a draft with origin `recording` it marks the staged install proposal `author: "recording"` through the loader, and the lock entry keeps it. A card is raised `taint: true` for any tainted draft, routine drafts included, with neutral wording for those that are not recordings. A teaching-loop update of a recording skill is drafted tainted and as a recording, so it stays that way. A recording skill is therefore listed as made from a recording (`madeBy: "recording"`), keeps trust `unknown`, and `skills_read` returns its text as **untrusted**, so the turn that reads it is tainted like one that read a web page. The `skill_install` card is raised with `taint: true`, a taint source "recorded web pages" and a plain sentence ("made from pages you visited ... treated as untrusted instructions"), and names the device it was recorded on. A third-party skill that only claims the marker in its text gets nothing from it. A test feeds a prompt-injection string through names and selectors and checks that nothing escapes the block.

The draft then goes through what every draft goes through: `skills.drafts.accept` replays it against today's tools (it may not declare a tool that is not registered), stages it from quarantine, scans it, checks the install policy, and opens a device-only `skill_install` card worded "Install skill from your recording". Nothing is installed before the owner approves.

### Replay: through the broker, and it stops when the page changed

"Run it once now" appears after the owner approves the card. It **fills the message box** with `/<skill-name>`. It sends nothing, calls no tool and talks to no page. The owner presses Send, and the agent loop runs the skill with the normal browser tools, so:
- every call goes through the loop's gate and the Permission Broker: origin policy (`new_origin`), side-effect class per element (`browser_submit`, purchase, consent), taint, grants, approval cards, receipts;
- the owner watches the pane, can Take control at any time, and can cancel the run.

A replay that fails is a stop, never a guess. `browser.check_target` is a read-only tool that looks a recorded target up in the live page by **exact role and name** (ignoring case and spacing) and answers `found` (one match, with its `ref`), `missing`, `ambiguous` (several matches, none picked) or `wrong_page`. The `origin` is **required**: the skill passes the origin of the most recent `open` step, and a tab on another origin, or one whose origin is unknown, answers `wrong_page`. Anything but `found` carries `stop: true`, and the skill tells the agent to stop and ask the owner. A similar-looking element is not the same element. The check is deterministic and tested against a live page (found; the button gone after the page changed; another site; two matches).

## 7. Example values become inputs

In the review screen each typed or chosen value is one of three things (§4). A neutral name is suggested (`input1`, `input2`; the field's name is page text and is not used); the owner can change it and add a one-line description. In the skill:
- "Inputs" lists each one with where it goes;
- the step reads "type the value of input from_date";
- the agent asks for it at the start of a run, using the owner's current request.

A masked value that is not kept and not named becomes an unnamed input (`input2`): the skill never silently reuses an old example.

## 8. Run it every week

A skill made from a recording can be put in Scheduled. Phase 1 left this out because an unattended run needs decisions the owner should make: what to do when a step is sensitive, when a value is asked for each time, when a page changed, and when something needs approval. These are the answers.

**Where.** On the page of the skill (Settings, Skills), for an installed, enabled skill made from a recording: "Run it every week". The owner picks every day, every week on a day, or every month on a day, and a time. It becomes an ordinary automation in Scheduled with its history ("From a recording" in the row), pause and resume, Run now and Delete, one click each. It can only be installed first: a draft that has not passed the approval card cannot be scheduled.

**Owner only, by construction.** `skills.recording.schedule` accepts the Psyche desktop shell on the Host and nothing else (the same check as `skills.drafts.fromRecording`); a phone, a web client or a script with an admin scope gets `forbidden`. The agent has no tool for it, its `schedule` tool has no field for the marker, and the `automations.create` and `automations.update` methods ignore it, so it cannot be set or changed by any other path. As a second layer, the scheduler handed to the agent refuses a job whose title or text names a recording-made skill ("Only you can schedule it"). That is a name match, not a guarantee: an agent that describes the task in other words schedules an ordinary automation, which is no different from today (it needs its own approval card, the same broker applies) and does not get the recording rules below.

**What it refuses.**
- A skill with a **sensitive** step (the owner does it themselves) or a step that types a value **asked for each run** (a named input, or a masked value left as "ask me each time") is refused with the step numbers in plain words, and the form is not shown. A scheduled run has nobody to ask, so the safe answer is no, not a guess. The check reads the steps back from the skill's text in the exact shape the skill writes them and accepts only lines it recognises; an unrecognised line, a missing step list or an out-of-order number makes the skill ineligible. Page text cannot make a step look kept (names are quoted JSON strings and the markers sit after them). Only navigations, clicks, Enter, and values the owner chose to keep run unattended.
- The check runs again at every run. If the skill was removed, turned off, changed on disk, or edited into something an unattended run cannot do, the run does not start; it is recorded as failed, with the reason, and the owner is notified.
- A schedule that is not a fixed minute and hour (so at most one run a day).
- A second schedule for the same skill.

**Every run uses the normal broker.** The run is an unattended task like any automation's: origin policy (`new_origin`), side-effect classes (`browser_submit`, purchase, consent), taint (reading the skill taints the turn), grants and approval cards all apply. An action that needs approval parks the task on the approval, which sits in the approvals queue with a notification; the run is shown as **waiting** in Scheduled and carries on after the owner answers. It never skips the step or does later ones first (the run's rules say so, and the guard below blocks an action that has no fresh check).

**A changed page stops the run.** The Gateway watches the run's tool calls (not just the model's instructions):
- The model may act (`click`, `type`, `select`, `press`) only on the element that `browser.check_target` last answered `found` for, once. An action with no such check, or on another element, is blocked with the reason.
- Any other answer (`missing`, `ambiguous`, `wrong_page`, or an error) ends the task at once. The run is recorded as **failed** with "The page changed at step 3: ..." (the step is found by matching the checked name against the recorded steps), and the scheduler sends the owner a "... failed" notification that opens Scheduled. Nothing more is done in that run. The schedule stays on, and the next run tries from the start; the owner can pause it from the same row.
- A scheduled recording cannot hand the tab over (`browser.request_control`), fill a saved login, upload a file or drag. Those need the owner, and nobody is there.

**What stays the same.** The skill is still instructions the agent follows, not a script. The agent still reads page text as untrusted. The owner approved the skill's full text first.

**Residual risks.** The guard sees tool calls inside the Gateway's loop; a step that the model performs with a tool other than the four acting browser tools (for example by scripting a page) is not covered by the check-first rule, though the broker still decides every call and the skill's declared tools bound what it may call. A step that was found but whose click opens a different page is only caught by the next check. Notifications on a failed run are de-duplicated per schedule, so a second failure while the first notice is unread updates it rather than adding another.

**Mac apps (phase 2)** reuse the review screen and the draft path. Only the recorder differs (the Mac helper's).

## 9. Threat model

| Threat | Mitigation |
| --- | --- |
| The agent starts a recording to watch the owner | No tool, method or bridge command exists for it (tested). The CDP calls a recorder needs are off the bridge allowlist. While a tab is recorded, the host refuses all bridge commands for it. |
| A prompt-injected agent reads a kept recording | No method or tool reads the folder; the file holds only reviewed, cleaned steps. |
| A web page forges recorded steps (to plant text in a skill) | The script runs in an isolated world with a per-recording random name; the binding exists only there; reports need `isTrusted`; a report from any other context is dropped. Navigations the page causes (script, refresh, redirect) get no step; only the owner's Back, Forward and Reload do. A page can still show *misleading element names* that the owner clicks; they are quoted as data, and the owner reviews every step. |
| Names of clicked elements hold private page text (an email subject, a balance) | The review screen shows every name in plain words; the owner can delete or reword the step before Save, and nothing is saved or sent before that. Names are cut to 120 characters. They are page text, so they are quoted as data in the skill. |
| A page makes the owner type a secret into a plain field | The field's words, `autocomplete` and type decide; the value is checked again for card, ID and token shapes; a hit is dropped and the step marked sensitive. A secret in an unmarked field with an unrecognizable shape is held in memory only and is sent only if the owner picks **Keep this value** on it, which is a visible, per-field choice with the value shown beside it. |
| Page text in the skill steers a later run | Quoted as untrusted data in one place (roles come from a fixed list, inputs are named by step); the instructions say so; the draft, the install proposal, the card and the lock entry carry the taint, and the skill's text is read as untrusted, so the loop's taint rules and approvals apply to every action; the owner approves the skill's full text first. |
| A phone, a web client or a script with an admin scope saves a made-up recording | `skills.drafts.fromRecording` accepts only the Psyche desktop shell on the Host; the card names the device. |
| A kept recording is read or planted by a tool | It is in `state/teach`, denied to every file tool, outside the Library and the backup; each file is HMAC-signed with a key outside `$PSYCHE_HOME`; unsigned or edited files are ignored; links are refused. |
| The step cap frees the tab while the binding is still there | At the cap the tab is released (`onEnded`) only after the teardown has resolved; Stop waits for it too. |
| The bridge is attached when Record starts, or reaches the tab while it stops | Record is refused on a tab the bridge has enabled domains on. A stopping recording stays current (bridge refused, binding events hidden) until `Runtime.removeBinding` has resolved; then `Runtime.disable` and `Page.disable` put the domains back. |
| The recorder leaks typed values to the Gateway | The recorder's channel is dropped in the main process before the Gateway's CDP forwarding; only reviewed steps travel, and only the owner-kept values among them. |
| The recording is left on disk | Not written by default. Kept recordings are explicit, clean, signed, `0700`/`0600`, expire after 90 days, deletable in the pane. |
| A scheduled run guesses, or does something nobody approved | Refused at schedule time and again at each run for sensitive and ask-each-time steps; the normal broker for every call; acts only on a just-found element; any check miss ends the run and notifies (§8). |
| The agent schedules a recording | Owner-only method (desktop shell), no tool, marker settable nowhere else; the agent's scheduler refuses a job naming a recording skill (§8). |
| A kept recording is read from disk or swapped | AES-256-GCM with a keychain-sealed key, id bound in; edited, truncated, renamed or wrong-key files are ignored and logged; no keychain, no keeping (§5). |
| A replay does more than recorded | A skill declares tools, never grants them. Every call is decided by the broker as for any tool call. Origins outside the first address need `new_origin` approval. |

## 10. Answers to the roadmap's open questions

1. **What gets recorded?** Semantic steps (§3). Never the sensitive values, cookies, storage or pixels. Typed values hidden unless kept (§4). On the Mac, in memory until Stop, then in the review screen, then gone unless kept (§5).
2. **What happens when the page changes later?** Replay stops and asks: `browser.check_target` answers `missing`, `ambiguous` or `wrong_page` with `stop: true`, and the skill's instructions say not to guess (§6).
3. **Skill or automation, and who decides?** Skill by default. The owner decides at Save and at the approval card. Making it an automation is a later, separate choice (§6, §8).
4. **Relation to the teaching loop.** Separate recorders, shared outputs. The teaching loop learns from feedback; this learns from a demonstration. Both end in a skill the owner approves. When a skill made from a recording is later corrected ("not like this"), the teaching loop's lessons fold into it as for any installed skill (its §6), and marks and lessons stay on the skill. They do not share the recorder: the recording is gone, and what remains is the skill.

## 11. Open points for the owner

- **Kept recordings** are now encrypted (§5), and not kept at all without a keychain. Is 90 days the right length? Is "not kept" the right answer when the keychain is missing, or would you rather have a plain copy with a notice?
- **"Run it once now" sends nothing itself.** It fills the message box so the owner presses Send. A one-click run is possible; it would put a message in the thread on the owner's behalf, so it is left as an owner choice.
- **Weekly runs** (§8), decided as: sensitive and ask-each-time steps are refused, not asked for; a changed page stops the run and notifies; approvals wait. Still open: should a changed page also pause the schedule so it does not try again next week? (Today it stays on.) Should a run be able to ask for a value by notification and wait (a longer wait, a harder case)? Should the schedule offer more than one run a day?

## 12. Where it lives

| Piece | Path |
| --- | --- |
| Rules shared by every layer (sensitive fields and values, URLs, step cleaning) | `packages/protocol/src/browser-teach.ts` |
| Wire types and `skills.drafts.fromRecording` | `packages/protocol/src/methods/skills.ts` |
| Page script, recorder, kept-recording store, target matcher | `packages/browser/src/teach/` |
| `browser.check_target` | `packages/browser/src/tools/register.ts` |
| Recorder host, IPC, indicator state | `apps/desktop/src/main/browser/teach-session.ts`, `browser-host.ts`, `apps/desktop/src/lib/ipc.ts` |
| Record, indicator, review screen | `apps/web/src/shell/components/BrowserPane.tsx`, `TeachReview.tsx`, `teach-review.ts` |
| Skill text and draft | `packages/skills/src/recording.ts`, `drafts.ts` (`proposeFromRecording`), `handlers.ts` |
| Kept recordings (encrypted, `state/teach`) | `packages/browser/src/teach/store.ts`; keys in `apps/desktop/src/main/browser/browser-host.ts`; denied in `packages/permissions/src/prohibitions.ts`; left out of `packages/backup/src/archive.ts` |
| Weekly runs: unattended check, schedule method, run guard | `packages/skills/src/recording.ts` (`recordingUnattended`), `apps/gateway/src/compose/recording-schedule.ts`, `skills.recording.*` in `packages/protocol/src/methods/skills.ts`, `Automation.recordedSkill` |
| Weekly runs: screen | `packages/ui/src/screens/settings/RecordingSchedule.tsx`, the row note in `scheduled/ScheduledRow.tsx` |
| Words | `packages/ui/src/i18n/messages/teach.ts` |
