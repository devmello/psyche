# Smoothness 2026: making Psyche feel like an agent browser

Status: research + proposal (2026-10-26). Docs only. Builds on [motion.md](motion.md) (tokens, springs, reduced-motion table) and does not repeat it. Streaming smoothness is being built by the smooth-streaming session; §4 only points at it.

Owner's brief: Psyche should replicate the feel of the Zephium browser's agent. This document says what that feel is made of, where Psyche falls short, and what to change.

## 1. Research, and how far to trust it

**Zephium is real but thinly documented.** It is an open-source desktop browser (Rust, system WebView, Mac and Windows) from a single maintainer, with an AI layer: *Ask Zephium* (a sidebar assistant) and *Work* (a canvas where parallel helpers browse live pages). Its latest release at time of writing is 1.0.3 (2026-10-24). Sources: https://zephium.app/ , /docs/work , /docs/ask-zephium , /changelog , https://github.com/zephium-browser/Zephium.

What we could and could not establish:
- **Confirmed by reading the docs pages directly** (Work and Ask pages fetched and checked): the behaviours in §2 rows marked "Zephium".
- **Not documented anywhere we could reach:** easing, durations, skeletons, optimistic UI, token-level streaming internals. We found no independent reviews, threads or demo-video descriptions. We did not run the app. So "Zephium's smoothness" is inferred from its *structure* (what it shows and when), not from measured motion. Nothing below claims Zephium's timings.
- One changelog item, an "island" with one-line run status, is not mentioned on the Work page; treated as unverified and not used.

**Comparables** (labelled by source in §2): Opera Neon (official FAQ), Claude for Chrome (official support pages), Raycast AI (official manual), Perplexity Comet and ChatGPT Atlas (mostly secondary sources; Atlas help pages returned 403). Dia has no documented browsing agent. None of these publish motion specifics either.

Honest conclusion: the transferable value is **interaction structure** (visible plan, live step list, steer/stop at any time, approval cards, human-help hand-off). The **motion craft** has to come from Psyche's own motion.md applied consistently; no source gives numbers to copy.

## 2. Patterns worth copying

| # | Pattern | Source | Psyche today |
| --- | --- | --- | --- |
| P1 | **Live step list while the agent works**, each action a row that appears as it happens. | Zephium Ask ("the panel lists each step"); Neon (plan and next steps in side panel) | Exists (RunStepLog / RunTrace) but swaps abruptly at run end and remounts when the reply starts |
| P2 | **Ambient "agent is active" cue on the surface being acted on**: a glow along the tab edge during a step; Neon has "a subtle glow around active tasks". | Zephium Ask; Opera Neon FAQ | Pulse/spinner only on the step row; nothing on the canvas or screen being acted on |
| P3 | **Stop and Steer always present**; steer lands "at the agent's next move"; follow-up via "Message the agent…". | Zephium Work; Neon ("pause, stop, or take over") | Verify a mid-run steer input exists and says when it will apply (product question, not motion) |
| P4 | **Human-help hand-off pane**: the agent stops at a login/human check, shows that page in a "Help the agent" pane, and offers *I'm done, continue* / *Skip* / *Keep waiting*. | Zephium Work | Not present in the chat column; closest is the approval dock |
| P5 | **Approval as a card that stops the step**, explaining the action, with a named button and *Not now*. Drafts for send/post/delete/save; reading is cheap, changing waits. | Zephium Ask and Work; Claude for Chrome (Allow / Allow all for site / Deny); Raycast (card, Allow / Always / Deny, Allow All when several pend) | ApprovalDock exists; its edge spans and padding pop in without transition |
| P6 | **Source marks that scroll to and briefly highlight the passage**; admits when the page changed. | Zephium Ask | Not applicable to chat today; relevant to screen-ask and canvas citations |
| P7 | **Proposals are previewed, then Apply/Discard**; nothing persists first. | Zephium Ask (style changes), Work (file changes) | Match canvas edits and file proposals to this pattern |
| P8 | **Cost shown per reply.** | Zephium Ask | Out of scope for motion; note for product |
| P9 | **Parallel helpers each with a small live window, labelled by activity** (searching, reading, checking…), results gathering at the side as they finish; "Agents in this run" list; "Waiting for your answer" state. | Zephium Work | Timeline/waterfall covers this; the canvas could host helper thumbnails |
| P10 | **Visual separation of the agent's own surfaces**: Claude for Chrome puts agent tabs in a separate coloured group. | Claude for Chrome | A distinct agent-owned tint on canvas/pane chrome |
| P11 | **Plan first, then run**, with Approve / Make changes. | Claude for Chrome (classic panel); Neon (single-source) | Plan blocks exist; keep their enter calm and in place |

Stay away from: anything the comparables do that is only a secondary-source claim (Comet's blue highlight, Neon's plan-approval workflow) until verified.

## 3. Motion system

The system is already specified in [motion.md](motion.md): durations (`micro 100`, `short 150`, `medium 220`, `long 320`), easings (`standard`, `enter`, `exit`), six springs (`micro`, `snappy`, `smooth`, `gentle`, `emphasis`, `interactive`), enter/exit, `layoutId` shared elements (approval card → receipt, selection pill), the reduced-motion table, and the "only the running step moves" rule. Do not fork it.

What this research adds, as amendments:

1. **Ambient glow (P2)**, new token use: an opacity-only 1.2 s pulse on a 1–2 px edge of the acted-on surface, linear, same period as the working pulse, ended with a 150 ms fade, static (solid thin edge) under reduced motion. Opacity only, so it is compositor-safe.
2. **Highlight flash (P6)**: background fill on the cited range, hold ~1.2 s, fade 220 ms (`medium`). Reduced motion: the highlight stays, no fade.
3. **Delayed skeleton, everywhere**: `duration.skeletonDelay` (150 ms) exists in `tokens.ts` but is used nowhere. One shared `DelayedSkeleton` replaces the private `animate-pulse bg-gray-3` blocks; skeleton → content is a 150 ms crossfade into reserved space.
4. **Reserve, don't reflow**: every async slot (thumbnail, chip, version notice, specialist roles) reserves its final box. This is the cheapest fix for most jank found.
5. **Presence for every conditional render**: any `cond && <X/>` that appears mid-flow gets a 150 ms opacity enter and a 105 ms exit, or a reserved slot.
6. **Reduced motion must keep opacity fades**: the global kill switch zeroes every transition, turning motion.md §7's "fade 150 ms" rows into instant swaps. Under reduce, keep opacity at `--duration-short`, kill only transform/size.
7. **One reduced-motion source**: `useBottomAnchor.ts` has its own resolver next to `ThemeProvider`'s; collapse to one.
8. **Doc/code drift to fix in motion.md**: it names `--cds-dur-*`; the real properties are `--duration-*`, `--ease-*`, `--spring-*`. `ease.linear` is documented but missing from `tokens.ts`. The thread-switch crossfade (§4.3) is documented but the shell skips it.

## 4. Streaming and latency hiding

- **Token streaming:** owned by the smooth-streaming session (delta batching, incremental markdown, scroll-follow, chunk fade-in). Not planned here. One interaction to check when it lands: the Ask panel and chat share the "pin to bottom while streaming" behaviour (see C-ask below).
- **Optimistic send:** the user bubble and "working" state should appear in the same frame as Return. Today `sendNow`'s result is discarded and nothing renders until the round trip. Use the existing `store.mutate({optimistic})`, set `sentAt` before the await, reconcile on echo, show an inline retry on failure. Same for the Ask panel (the `sending` status is declared but never produced).
- **Skeleton policy:** nothing for 150 ms; then content-shaped skeleton; then 150 ms crossfade. Applies to transcript load, canvas load, Overview sections, step thumbnails.
- **Step-by-step reveal for agent actions:** new step rows use `fadeRise`; a status change morphs the glyph; the finished run collapses to its summary on `spring.smooth` (height + opacity) instead of vanishing. Rows keep `layout` so inserts do not jump. Coalesced progress (4/s per step) already matches this.
- **Keep the previous view while loading:** on thread/artifact switch keep the old content visible (dimmed) until the new one is ready rather than swapping to a blank "Loading" line.

## 5. Prioritised changes

Effort: S ≤ ½ day, M ≈ 1–2 days, L > 2 days. Paths relative to repo root. Findings are from a read-only code audit, not a running app; items marked (verify) need confirming in the app.

### P0: visible on every use

| ID | Change | Files | Effort |
| --- | --- | --- | --- |
| C1 | **Optimistic send**: pending message + working state in the same frame | `packages/ui/src/chat/Thread.tsx:267`, `packages/ui/src/data/hooks.ts:390-428`, `store.ts:129` | M |
| C2 | **Transcript load skeleton** (message-shaped, 150 ms delay, reserved height); stop crossfading an empty column on thread switch | `chat/Thread.tsx:549,587`, `apps/web/src/shell/ShellApp.tsx:1009`, `packages/ui/src/shell/AppShell.tsx:141` | S |
| C3 | **Run trace continuity**: one keyed run-trace element that does not remount when the reply starts; live → done collapse on `spring.smooth`; rows keep `layout` | `chat/Thread.tsx:511-515,617-624,657-673`, `chat/steps/RunTrace.tsx:52,59-171`, `components/steps/StepRow.tsx:104` | M |
| C4 | **Overview skeletons + error state**: treat `undefined` as loading, content-shaped skeletons gated by `useDelayedFlag(…,150)`, honour `loading` flags, "Couldn't load · Retry" | `packages/ui/src/overview/OverviewSection.tsx:55`, `OverviewScreen.tsx:59-86`, `BuiltSpecialists.tsx:94-182`, `overview/data.ts:10-31` | M |
| C5 | **Canvas load**: keep previous artifact visible, body skeleton; reset state with `key={artifactId}`; reserve the version-notice slot; 150 ms body crossfade | `packages/ui/src/canvas/CanvasPane.tsx:114-137,221,340-394`, `apps/web/src/compose/canvas.tsx:41` | M |

### P1: polish that makes it feel agentic

| ID | Change | Files | Effort |
| --- | --- | --- | --- |
| C6 | **Ask panel open + resize**: show after first measured height; rAF-throttle `onHeight` and send on change only; fade/`fadeRise` in; this also removes an IPC call per streamed token | `apps/desktop/src/main/screen-ask/panel.ts:127,199`, `packages/ui/src/screen-ask/ScreenAskView.tsx:93-99`, `apps/web/src/compose/ScreenAsk.tsx:342` | M |
| C7 | **Ask panel details**: optimistic echo + `sending`; reserve chip thumbnail slot with shimmer; 150 ms form→answer swap; pin answer scroll to bottom while streaming; announce on done only | `ScreenAskView.tsx:42,84,127-138,206,233-274`, `ScreenAsk.tsx:286-296` | S |
| C8 | **Ambient agent glow (P2)** on the pane/canvas being acted on, opacity pulse, reduced-motion static | new in `packages/ui/src/motion/`, applied in `canvas/CanvasPane.tsx`, `shell/` pane chrome | M |
| C9 | **Approval deck**: fade/`layout` for edge spans and padding; align with approval → receipt `layoutId` morph | `chat/ApprovalDock.tsx:72-127` | S |
| C10 | **Step detail + glyph**: animate expanded detail with presence (height/opacity, `spring.smooth`); one shared pulse keyed to a token, ending at 100%; delete dead `WorkingIndicator.tsx`; reserve the 32×20 `FrameThumb` slot | `chat/RunStepLog.tsx:294-306,370`, `components/steps/StepRow.tsx:136`, `components/status.tsx:38`, `chat/steps/StepList.tsx:32,56` | S |
| C11 | **Shared `DelayedSkeleton`** replacing private pulses; adopt in ThreadList, ActivityPanel, SpecialistResultBlock, MessageBlocks, Timeline, SoulMemory, Upcoming, MissionControl, StepInspector | `skeletons` in `components/page.tsx`; callers listed in the audit (`agent/timeline/TimelineView.tsx:442-468`, `shell/ThreadList.tsx:436`, `blocks/MessageBlocks.tsx:47`, …) | M |
| C12 | **Overview entrance + motion**: sections `fadeRise` once with `staggerStep`; jump bar opacity transition; smooth scroll honours reduced motion (copy `ApprovalsPanel.tsx:96`); period change via `layout` | `overview/OverviewScreen.tsx:111,147-166,76`, `OverviewSection.tsx:51` | S |
| C13 | **Voice**: reserve one line (or fade) for the listening bar so the composer does not shift; fade HUD shell in on mount; dictation field shows typed + partial; announce phase changes only | `voice/controls.tsx:82-106`, `voice/composer-voice.tsx:31`, `apps/desktop/src/renderer/dictation-hud.tsx:193-214` | S |

### P2: engineering hygiene that protects the feel

| ID | Change | Files | Effort |
| --- | --- | --- | --- |
| C14 | **Replay playhead** on a ref/motion value, not `setReplay` every rAF re-rendering a 692-line view | `agent/timeline/TimelineView.tsx:290-303` | M |
| C15 | **Timeline swaps** (failure banner, range bar, inspector, list/waterfall) get 150 ms presence; `layout` on inspector column | `TimelineView.tsx:529-600` | S |
| C16 | **Composer**: `layout` FLIP only on height steps (not each wrap while typing, per motion.md rule 4); conditional `layoutId` | `chat/Composer.tsx:110-115` | S |
| C17 | **Scroll anchor** observes the composer stack too; re-stick when pinned (verify first) | `chat/useBottomAnchor.ts:55-61`, `chat/Thread.tsx:546-572` | S |
| C18 | **Pane reflow**: `ReflowColumn` uses `layout="position"` so widths do not animate (text rewraps at frame 0 while the pane slides ~546 ms). Choose: crossfade the column during the transition, or amend motion.md §4.3 | `shell/motion.tsx:68-82`, `shell/AppShell.tsx:256,260` | M |
| C19 | **Replace literals with tokens** (180/120/4 px route keyframes, `duration-450`, drawer `transition-[…height…]`, progress `transition-[width]` → `scaleX`, startup splash 300 ms/2.8 s, dead `psy-voice-*` CSS) | `apps/web/src/shell/layout/shell-layout.css:91-123`, `components/ui/drawer.tsx:109`, `components/ui/progress.tsx:38`, `chat/steps/StepList/Waterfall.tsx:286`, `chat/context/CompactionMarker.tsx:61`, `styles/design.css:504,526,588-605` | S |
| C20 | **Reduced motion**: keep opacity fades at `--duration-short`; one resolver | `apps/web/src/shell/shell.css:517-531`, `styles/index.css:404-418`, `styles/design.css:416-435`, `chat/useBottomAnchor.ts:6-14`, `theme/ThemeProvider.tsx:178` | S |
| C21 | **Widen the literal-ban test** (`ease-[`, `duration-[`, `transition-[width]`, `ease:"linear"`, CSS ms literals; drop the drawer exemption) | `packages/ui/test/motion-tokens.test.ts` | S |
| C22 | **Web pane divider**: pointer capture + cleanup on unmount | `apps/web/src/shell/components/Panes.tsx:266,283-295` | S |

### P3: new interaction patterns (product + design first)

| ID | Change | Notes | Effort |
| --- | --- | --- | --- |
| C23 | **Human-help hand-off pane (P4)** | Needs agent-side "page needs a person" signal and a pane; design with the browser workstream | L |
| C24 | **Steer-at-next-move input (P3)** with explicit "applies at next step" state | Needs agent-loop support | M |
| C25 | **Citation scroll-and-highlight (P6)** for screen-ask / canvas | After C5/C6 | M |
| C26 | **Proposal → Apply/Discard** shape for canvas edits (P7) | Check against existing approvals | M |

Suggested order: C1, C2, C4, C3, C5, C6/C7 as the first wave (each is independent and touches a different area); then C9–C13; C19–C21 can ride along with any PR touching the same file.

## 6. Decisions needed (max 6)

1. **Scope of "feel like Zephium".** Since Zephium's motion is undocumented, copy its *structure* (P1–P11) and take the motion craft from motion.md, rather than trying to reverse-engineer timings. **Recommended: yes.**
2. **Ambient agent glow (C8)** on acted-on surfaces. It is the most recognisable "agent browser" cue (Zephium, Neon). **Recommended: yes, opacity-only, off by default under reduced motion and when idle >5 s.**
3. **Pane reflow (C18).** Keep position-only layout and crossfade the column during pane transitions (cheap, compositor-only), or animate width via FLIP as motion.md promises. **Recommended: crossfade, and amend motion.md §4.3.**
4. **Thread switch crossfade.** Code skips it, doc requires it. **Recommended: add the 150 ms opacity-only crossfade after C2 lands (otherwise it fades in an empty column).**
5. **Skeleton and optimistic-send policy** as in §4 (150 ms delay, reserved space, optimistic send with inline retry). **Recommended: adopt as a repo-wide rule and enforce via C21.**
6. **Human-help hand-off and steer (C23, C24).** These are product features more than motion. **Recommended: spec separately with the browser-agent workstream; do not block the P0/P1 work on them.**

## Sources

Zephium (fetched 2026-10-26): https://zephium.app/ · https://zephium.app/docs/work · https://zephium.app/docs/ask-zephium · https://zephium.app/changelog · https://github.com/zephium-browser/Zephium

Comparables:
- Opera Neon FAQ: https://www.operaneon.com/faq
- Claude in Chrome permissions: https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide
- Claude in Chrome getting started: https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
- Raycast AI extensions: https://manual.raycast.com/ai/ai-extensions.md
- Perplexity Comet (official): https://www.perplexity.ai/comet. Secondary: https://www.createwith.com/tool/perplexity/updates/perplexity-updates-comet-with-more-transparent-assistant-controls
- ChatGPT Atlas agent mode (secondary; official help returned 403): https://allthings.how/chatgpt-atlas-agent-mode-macos-setup-controls-workflows/
- Dia: https://www.diabrowser.com/download/thanks (no browsing agent documented)

Psyche: [motion.md](motion.md), [run-trace-2026.md](run-trace-2026.md), [chat-experience-2026.md](chat-experience-2026.md), [screen-ask-2026.md](screen-ask-2026.md), [agent-overview-2026.md](agent-overview-2026.md).
