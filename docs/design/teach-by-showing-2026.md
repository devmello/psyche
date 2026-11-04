# Teach by showing: the built-in browser (2026)

**Status:** phase 1 built, 2026-11-04. **Feature:** J8 in [03-feature-spec.md](../03-feature-spec.md), spelled out in [future-features.md §2](../roadmap/future-features.md#2-teach-by-showing). **Companion:** [the teaching loop](../agent/teaching-loop-2026.md), which learns from feedback ("not like this"). The two share lessons and marks. They do not share the recorder.

**The short version:**
- The owner presses **Record** on a tab of the built-in browser, does a task once, and presses **Stop**.
- Psyche shows the steps in plain words ("Open example.com", "Click ‘Export’", "Type the date into ‘From’"). The owner edits, reorders, deletes, and marks values as inputs.
- **Save** makes a skill draft through the existing owner-approved skill path, with the usual approval card. Nothing runs until the owner approves it.
- **Run it once now** fills the message box with the skill. The agent runs it with the normal browser tools, so every action passes the permission broker, and it stops and asks when the page is not what was recorded.
- Passwords, card numbers, one-time codes and ID numbers are never recorded. Other typed values are hidden by default and kept only when the owner says so. Cookies and session contents are never read.

---

## 1. Scope

| In phase 1 | Not yet |
| --- | --- |
| The built-in browser's own tabs (the owner's, not the agent's) | Real Chrome (R-mode), Mac apps (phase 2, J1/J2; the Mac helper already has an accessibility recorder, `apps/mac-helper/.../Teach/`, with its own `TeachStep` in `schemas/teach.ts`) |
| Navigations, clicks, typing, choosing in a `<select>`, Enter | Drag, hover, file uploads, rich-text editors, keyboard shortcuts, cross-origin iframes |
| One skill draft per recording, run once now | "Run it every week" through Scheduled (phase 3, §8) |

## 2. Who can start a recording, and where it runs

Only the owner, from the browser pane's own button. That is a property of the wiring, not a rule the agent is asked to follow:

- The recorder lives in the desktop app's main process (`apps/desktop/src/main/browser/teach-session.ts`). The renderer reaches it over seven IPC channels (`psyche:teach:*`). The main process accepts them only from the app's own windows, and refuses them in a window that is a client of another computer's Gateway.
- There is no Gateway method, no `browser.*` tool and no bridge command that starts, stops, lists or reads a recording. `Runtime.addBinding` and `Page.addScriptToEvaluateOnNewDocument` are not on the bridge's CDP allowlist. Tests assert each of these (`packages/browser/test/teach-store.test.ts`).
- The one Gateway method involved, `skills.drafts.fromRecording`, takes the owner's **reviewed** steps (never a recording) and needs `operator.admin`, like every skill mutation.
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
| `navigate` | origin and path of the page | Open billing.example.com/reports |
| `click` | accessibility **role** and **name**, plus a short CSS selector as a fallback | Click ‘Export’ |
| `type` | role, name, selector; the typed value is held for review only (§4) | Type the date into ‘From’ |
| `select` | the same, and the label of the option | Choose an option in ‘Range’ |
| `press` | Enter only, with the field it was pressed in | Press Enter in ‘Search’ |

How it records: `Runtime.addBinding` scoped by `executionContextName` to a named isolated world of the top frame, plus `Page.addScriptToEvaluateOnNewDocument` into that world, so the script survives navigations. The page's own scripts cannot see the world or call the binding. The binding and world names are random for each recording. The script listens in the capture phase and reports **only `isTrusted` events**, so a script on the page cannot make steps appear. The recorder accepts a report only from the top frame's context. It also listens for `Page.frameNavigated` on the top frame; a navigation within four seconds of a click or Enter is that click's effect and gets no step of its own.

Limits: 200 steps (the recording ends and keeps what it has), 4 KB per report, 120 characters per name.

### Never recorded

| What | How it is kept out |
| --- | --- |
| The value typed into a **password, payment, one-time-code, ID-number or secret** field | The page script decides from the field alone (type, `autocomplete`, name, id, label, placeholder) and **does not read `value`**. The recorder decides again with the same rules (`classifyTeachField`, shared from `@psyche/protocol`), and a third time from the value itself (`classifyTeachValue`: Luhn-valid card numbers, `ddd-dd-dddd`, token-shaped strings). The review screen, the Gateway handler and the kept-recording store each clean the steps again (`sanitizeTeachSteps`). A sensitive step has no value, cannot be kept and cannot be an input. In the skill it reads "the owner does this themselves", and the agent hands the tab over with `browser.request_control`. |
| **Cookies, local storage, headers, response bodies** | The recorder issues no `Network`, `Storage`, `DOMStorage` or `Fetch` command and has no field for them. A test records a session and checks every CDP method it sent. |
| Query strings, fragments, opaque path segments | `teachUrl` keeps origin and path; a 24+ character token-like segment becomes `*`. |
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
- **Kept on request.** "Keep this recording on this Mac so I can make another version" writes the reviewed steps to `$PSYCHE_HOME/library/teach/<id>.json`: folder `0700`, file `0600`, written atomically, at most 20 files, ids validated so a path cannot come through. What is written is the output of `sanitizeTeachSteps`: no example the owner did not keep, no sensitive value (there never was one), no query strings. The pane's "Kept recordings" list opens one for review again, or deletes it.
- **Encryption.** Not encrypted at rest in phase 1. The desktop has no encrypted file store yet (the encrypted memory store, EM9, is for memory), and the kept file holds the same kind of data as the browser recordings beside it (`library/recordings`, also `0700`/`0600` plain files). The file holds no secrets by construction, only the owner's own steps and any value they chose to keep. If an encrypted library store lands, kept recordings move into it. Listed in §9.
- **Reach.** Only the desktop's main process opens the folder. No tool or method reads it. The agent's file tools do not reach Psyche's home (the protected-paths rule).
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

Page text is **data, never instructions**. Names and addresses from pages appear only in the third section, each as a JSON string on one line with backticks and line breaks removed, so a name cannot close the block or open a heading. The instructions above never contain page text and say so. The draft is marked `tainted`, its origin is `recording`, and the title is scrubbed like any owner text (emails, links, long numbers). A test feeds a prompt-injection string through names and selectors and checks that nothing escapes the block.

The draft then goes through what every draft goes through: `skills.drafts.accept` replays it against today's tools (it may not declare a tool that is not registered), stages it from quarantine, scans it, checks the install policy, and opens a device-only `skill_install` card worded "Install skill from your recording". Nothing is installed before the owner approves.

### Replay: through the broker, and it stops when the page changed

"Run it once now" appears after the owner approves the card. It **fills the message box** with `/<skill-name>`. It sends nothing, calls no tool and talks to no page. The owner presses Send, and the agent loop runs the skill with the normal browser tools, so:
- every call goes through the loop's gate and the Permission Broker: origin policy (`new_origin`), side-effect class per element (`browser_submit`, purchase, consent), taint, grants, approval cards, receipts;
- the owner watches the pane, can Take control at any time, and can cancel the run.

A replay that fails is a stop, never a guess. `browser.check_target` is a read-only tool that looks a recorded target up in the live page by **exact role and name** (ignoring case and spacing) and answers `found` (one match, with its `ref`), `missing`, `ambiguous` (several matches, none picked) or `wrong_page` (the tab is on another origin than the step). Anything but `found` carries `stop: true`, and the skill tells the agent to stop and ask the owner. A similar-looking element is not the same element. The check is deterministic and tested against a live page (found; the button gone after the page changed; another site; two matches).

## 7. Example values become inputs

In the review screen each typed or chosen value is one of three things (§4). A name is suggested from the field (`From date` becomes `from_date`, `from_date_2` if taken); the owner can change it and add a one-line description. In the skill:
- "Inputs" lists each one with where it goes;
- the step reads "type the value of input from_date";
- the agent asks for it at the start of a run, using the owner's current request.

A masked value that is not kept and not named becomes an unnamed input (`value_2`): the skill never silently reuses an old example.

## 8. Phase 3 is left alone, on purpose

- **Offering "run it every week".** The automation path (`automations.create` and Scheduled, #1030, #1002) runs a prompt on a schedule, unattended. A skill from a recording needs the skill to be installed first, inputs filled each run, and sensitive steps handed to the owner, so an unattended weekly run needs decisions this phase should not make for the owner (what to do when a sensitive step or a changed page stops it). That is phase 3 with the input questions in the roadmap. It is not a cheap button, so it is not built here.
- **Mac apps (phase 2)** reuse the review screen and the draft path. Only the recorder differs (the Mac helper's).

## 9. Threat model

| Threat | Mitigation |
| --- | --- |
| The agent starts a recording to watch the owner | No tool, method or bridge command exists for it (tested). The CDP calls a recorder needs are off the bridge allowlist. While a tab is recorded, the host refuses all bridge commands for it. |
| A prompt-injected agent reads a kept recording | No method or tool reads the folder; the file holds only reviewed, cleaned steps. |
| A web page forges recorded steps (to plant text in a skill) | The script runs in an isolated world with a per-recording random name; the binding exists only there; reports need `isTrusted`; a report from any other context is dropped. A page can still show *misleading element names* that the owner clicks; they are quoted as data, and the owner reviews every step. |
| Names of clicked elements hold private page text (an email subject, a balance) | The review screen shows every name in plain words; the owner can delete or reword the step before Save, and nothing is saved or sent before that. Names are cut to 120 characters. They are page text, so they are quoted as data in the skill. |
| A page makes the owner type a secret into a plain field | The field's words, `autocomplete` and type decide; the value is checked again for card, ID and token shapes; a hit is dropped and the step marked sensitive. A secret in an unmarked field with an unrecognizable shape is held in memory only and is sent only if the owner picks **Keep this value** on it, which is a visible, per-field choice with the value shown beside it. |
| Page text in the skill steers a later run | Quoted as untrusted data in one place; the instructions say so; the draft is tainted; the loop's taint rules and approvals apply to every action; the owner approves the skill's full text first. |
| The recorder leaks typed values to the Gateway | The recorder's channel is dropped in the main process before the Gateway's CDP forwarding; only reviewed steps travel, and only the owner-kept values among them. |
| The recording is left on disk | Not written by default. Kept recordings are explicit, clean, `0700`/`0600`, deletable in the pane. |
| A replay does more than recorded | A skill declares tools, never grants them. Every call is decided by the broker as for any tool call. Origins outside the first address need `new_origin` approval. |

## 10. Answers to the roadmap's open questions

1. **What gets recorded?** Semantic steps (§3). Never the sensitive values, cookies, storage or pixels. Typed values hidden unless kept (§4). On the Mac, in memory until Stop, then in the review screen, then gone unless kept (§5).
2. **What happens when the page changes later?** Replay stops and asks: `browser.check_target` answers `missing`, `ambiguous` or `wrong_page` with `stop: true`, and the skill's instructions say not to guess (§6).
3. **Skill or automation, and who decides?** Skill by default. The owner decides at Save and at the approval card. Making it an automation is a later, separate choice (§6, §8).
4. **Relation to the teaching loop.** Separate recorders, shared outputs. The teaching loop learns from feedback; this learns from a demonstration. Both end in a skill the owner approves. When a skill made from a recording is later corrected ("not like this"), the teaching loop's lessons fold into it as for any installed skill (its §6), and marks and lessons stay on the skill. They do not share the recorder: the recording is gone, and what remains is the skill.

## 11. Open points for the owner

- **Encryption at rest for kept recordings** waits for an encrypted library store (§5).
- **A time limit for kept recordings.** Today they stay until deleted, at most 20. Should they expire (for example 30 days) like the agent's browser recordings (7 days)?
- **"Run it once now" sends nothing itself.** It fills the message box so the owner presses Send. A one-click run is possible; it would put a message in the thread on the owner's behalf, so it is left as an owner choice.
- **Phase 3** questions: unattended runs and sensitive steps; what a scheduled run does when the page changed (stop and notify is the obvious answer).

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
| Words | `packages/ui/src/i18n/messages/teach.ts` |
