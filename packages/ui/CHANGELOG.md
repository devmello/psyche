# @psyche/ui

## Unreleased (pre-0.3.0)

### Minor Changes

- E12 "From your other chats": turn context providers in the loop; the Gateway keeps digests of the owner's chats and, with `threads.otherChats` on, brings matching ones into a turn as untrusted context with a `related_threads` block in the reply (audited); `thread_read` asks on its first read of each chat.
- Subscription CLIs as model providers: `claude-code/<model>` (Claude Code headless, the owner's Claude plan) and `codex/<model>` (Codex `exec --json`, the owner's ChatGPT plan), with Psyche's tools bridged over a stdio MCP relay so the agent loop and Permission Broker still run every tool, session resume per turn, and a probe for installed / signed in that reports no account details. Listed by default in Settings → Model & providers as subscription providers.
- Context usage in the chat: the header meter bound to `threads.contextUsage` and `thread.context.updated`, "Compact now" (`threads.compact`), per-chat limits (`threads.setContextLimits`) from the thread menus, compaction markers on `compaction` blocks with the turns they replaced, and Settings bounds that match the Gateway's.
- Voice mode (Q5), off by default: a Voice button in the composer runs a spoken conversation (hands-free or hold to talk) with a listening / thinking / speaking state bar, replies in the persona's voice or the app's built-in voice, and interrupt-by-talking; approvals stay cards and are never answered by voice. Settings → Voice & dictation → Voice mode.
- Agent-proposed skills (T3): routine detection over the loop's in-process hooks, redacted and rate-limited skill drafts that install only through the T2 trust card, and the "Suggested by" card in Settings → Skills.
- Settings → Browser: Web Bot Auth (I14) switch, key directory URL, key fingerprint, sites that asked, and Create / Rotate key.
- Localization groundwork (A12):
  - an ICU message catalogue with `t()`, `I18nProvider` and `describeError` for Gateway errors;
  - locale-aware formatting from the macOS region format, with Settings → Appearance → Language and region (`ui.locale`, `ui.direction`);
  - `pnpm i18n:check` against hard-coded UI text and missing ids, with a shrink-only baseline;
  - the chat's context UI extracted and right-to-left safe.
- Settings → MCP servers (#529): add a command or URL server through a sandboxed probe and a device-only trust card listing its tools; the connector catalog offers only implemented connectors, with MCP and Slack rows that open their Settings sections.
- Built-in `web.search` (Brave key, SearXNG URL or rate-limited DuckDuckGo) and `web.fetch` tools on every surface, with a Web search group in Settings → Model & providers (#557).
- Run trace T1 (#660): `RunStep`, the new `Run` fields, `runs.*`, the `run.step` event and the `psyche-trace+json` v1 export recipe; in the UI kit, the run store cases, `data/runs.ts` hooks, `fixtures/runs.ts` and MockGateway `runs.*`.
- Run trace T1, Gateway sink (#660): `run_steps` and `run_frames`, one sink for chat and helper runs, `runs.*` with `psyche-trace+json` v1 and Markdown export, retention of thinking text (`data.reasoningRetentionDays`) and frames (`data.replayRetentionDays`), and redaction at write. `@psyche/browser` exports `redactUrl`.
- Teaching loop, part 1 (#680). Agent messages get Helpful and Not like this, with reason chips, "What should I do instead?" and scope chips. The `taught` and `learned` blocks render with Undo and Change, and answers show a "Used n lessons" chip with Redo without lessons. Lessons get "Learned from you" marks in Soul & Memory, in Upcoming and in Settings → Skills, each opening its sources and the change with Keep, Edit and Forget.
- Teaching loop, part 2 (#680). The agent sheet gets a fifth tab, Growth (`/agent/growth`). It shows lessons and milestones by week with how each was learned, where it lives and Show change, and "What got better" with counts beside every rate. The weekly "What I learned" Feed post gets Keep / Edit / Forget and Yes, remember / No. Settings → Data controls gets a Learning group: feedback, implicit signals, pause, the weekly card, Open Growth, and Forget everything behind a typed confirmation.
- Teaching loop, part 3 (#680). `/teach <what to do instead>` corrects the last reply and says what Psyche will remember. Finished tool steps get "Not like this", offering the step's reasons (didn't do what I asked, wrong facts, should have asked first); the feedback targets the step's tool call.
- Teaching loop (#680): receipt lines get a ⋯ menu with "Not like this". It opens the Teach form with the step's reasons, records the feedback on the receipt's tool call (or its approval), and then shows what Psyche will remember.
- Teaching loop (#680): margin marks in the Markdown editor. `MarkdownEditor` takes `marks` (a line's text and a tooltip) and `onMarkActivate`, and draws a dot in a gutter beside each matching line; the gutter only exists while there are marks. The editor slot passes them through: Soul & Memory gives every lesson-owned line a mark, and activating one opens that lesson in the "Learned from you" list. The gutter is aria-hidden, so its dots are a pointer-only cue and the list stays the keyboard and VoiceOver path.
- Chat experience phase 1: a unified `Card` shell (`BlockCard`), one card status vocabulary with adapters, the block registry in place of the hard-coded block switch (unknown types get a fallback card) and a tool-result view registry.
- The output canvas (chat experience phase 3, kit side): `CanvasPane` with recents tabs, a version picker, Copy, Download, Edit (docs and code as one smallest replace op, table cells as `set` ops) and restore-as-new-version; artifact data hooks, the `artifact.updated` reducer, mock Gateway `artifacts.*` and a `renderArtifact` slot for viewers.
- Remove spoken output from the UI: the voice capsule, lantern, voice HUD window, the shell's voice mode, the Voice button and the voice, speed, narration, barge-in, approval and brief settings. Voice is speech-to-text: the voice key opens the ask panel in voice mode and the answer is text. Settings keeps "Talk with Psyche", the voice key and "Review before sending".
- Inline tool-result previews (chat experience phase 4): a "Show result" disclosure under tool rows for calendar events and free time, mail search, web search, browser snapshots, directory listings, file and code search and file reads, fed by the run trace and drawn as plain text.
- Specialist results land in the thread that spawned the job as a `specialist_result` card (the Feed and Inbox keep showing them too); a reported result posts the block once.
- Chart, diagram and diff artifacts (chat experience phase 5): a chart renderer drawn by the client from a small spec (no model JS), diffs through the diff block, Mermaid diagrams drawn in strict mode as images, and gateway support (merge-patch for charts, text ops for diagrams and diffs).
- HTML artifacts in the canvas (chat experience phase 5): previewed in the opaque-origin artifact sandbox, off by default for content from untrusted sources until the owner presses Run, and creatable through `artifact.create`.
- New read-only method `insights.summary` (operator.read) for the Overview screen: run, approval, artifact and specialist totals for 7 days, 30 days or all time with the previous period, one row per day in the caller's time zone, and the people and projects Psyche dealt with most. Incognito threads are left out. The UI gets `useInsights(window)` and mock fixtures for a new user, a typical month and a heavy year.
- `insights.summary` totals now carry `runsByKind` (done and failed runs per kind: task, chat, automation, subagent). The Overview's first Summary tile is "Tasks done" (finished task and chat runs, linking to Recent runs filtered to done), and the Automations tile's success rate counts automation runs only. The Recent runs link gains a `status=done` modifier.
- The agent sheet is slim: Approvals and Soul & Memory, a Now / next line, "Open overview", and a "Decided recently" disclosure (`/agent/approvals?view=decided`). Activity, Upcoming and Growth live on the Overview.
- Attach files in the chat composer. A + button shows when the thread's model can take files (from `models.list`; unknown shows it, a model without vision is offered documents only and says why an image was refused, an embeddings model hides it). Picked, dropped or pasted files become removable chips that upload through the new chunked `library.upload` (25 MiB, origin `upload`), and their Library ids go in `chat.send` `attachments`. The Gateway gives the agent images as image parts (4 per message, 5 MB each) and PDF, DOCX, XLSX and text files as capped extracted text (32k characters each, 96k per message) in the new `TurnInput.attachmentText`, kept out of what the owner said.
- "Ask about this" on each Feed item. It starts a new chat named for the article with the item as a removable chip in the composer (the input asks "Ask about this article…"). `chat.send` takes an optional `context: { kind: "feed_item", id }`; the Gateway reads the item itself and gives the agent its title, source URL, summary, sources and id ahead of the question, as untrusted content (a fenced `<feed_item_context>` preamble, and the turn starts tainted with a `feed` source), never in the system section. The user message records a new `context` block, shown as a compact quoted card in the transcript.
- A connected MCP server's detail now does something: list its tools and switch single tools off for the agent, turn the server off without removing it, see its secrets by name (set or not set) and replace them through the vault, and paste a `mcpServers` JSON config into the Add form (keys go to the vault). New methods `mcp.tools`, `mcp.tools.set`, `mcp.setEnabled`, `mcp.secrets`, `mcp.secrets.replace`; `McpServerStatus.enabled`.

### Patch Changes

- Bundled skills map their capability names to the Gateway's real tools and say why they are unavailable; gating follows the live tool set; the psyched build fails without its skills folder and the smoke lists the shipped skills (#506).
- Provider keys (#504): `models.setKey` normalizes a pasted key and refuses ones that cannot work (whitespace, Claude subscription tokens, Admin keys, wrong shape) with a reason; the probe reports the provider's own reason and tells a refused key from a malformed request; onboarding checks a key right after saving it; Settings → Model & providers can add or replace a key and checks it at once.
- Apple Notes, Reminders, Calendar and Mail connectors over the paired Mac helper's J6 app capabilities (#528); "needs the helper" when none is paired.
- Apple connectors are never "connected" without the macOS grant: needs permission with where to allow it, re-checked on status (#549). One-per-machine connectors refuse a second instance (`already_connected`) and duplicates are removed at start.
- Context windows for the subscription CLIs (#558): Claude Code models report 200k (1M for `[1m]` variants) and Codex 272k, so `models.list`, Settings and the chat's context meter agree; when a window is unknown, Settings shows the 128k the chat assumes.
- Apple connectors ask macOS for the grant when it has not decided (Check again asks again), send the owner to System Settings only after a denial, and show the helper's reason when no prompt appeared (#570).
- Onboarding lists every connector account with its status (needs permission, needs sign-in, failed) and resumes one that is not connected; the connect flow resumes an existing pending account instead of saying it is already connected (#620).
- People and projects graph (#650): graph schemas, memory.entities.* / memory.loops.* / memory.graph.status methods, memory.entity.updated / memory.loop.updated / memory.suggestion.created events, and person / project search kinds.
- Remove the OpenAI cloud voice (`gpt-4o-mini-tts`; OpenAI's TTS endpoints shut down on 2027-01-06). An owner who picked it moves to the default voice once, with a notice (#691).
- Task, plan, artifact and file cards move onto the unified Card shell (chat experience phase 1).
- Record meeting in the shell: the consent dialog ("I've told everyone"), a visible recording pill, microphone capture streamed to the Gateway as PCM chunks, a silence stop after five minutes, and `requestRecordMeeting()` plus a palette entry to start it.
- The wrap-up box moves onto the Card shell; a lint test keeps hand-rolled card chrome out of transcript surfaces.
- The output canvas in the app: artifact cards open one canvas pane beside the chat (its artifact swapped in place; recents are its tabs), code and images render through the viewers, and a new artifact from the owner's own live run opens the canvas automatically (others stay a card).
- Question, run-failure and workflow cards move onto the Card shell (`Card` gains `header`, `role`, `labelledBy`, `onKeyDown` and `animate`).
- One table of defaults for the mail and meeting settings (`MAIL_MEETING_SETTING_DEFAULTS`), read by Settings → Mail & meetings; and the batch card's strings in all ten locales.
- The ask panel is the voice pop-up (part of #693): hold the voice key, speak, and let go. The words are sent as a plain chat (or left in the input when Review before sending is on) and the answer appears as text. The panel window now exists when Ask about screen or Talk with Psyche is on; screen capture still follows Ask about screen. A `VoiceKeySource` seam in desktop main keeps the macOS key watch replaceable.
- MCP servers from an exact official source (`@modelcontextprotocol/server-*`, listed vendor packages and vendor endpoints) are `verified` instead of `unverified`. The Gateway derives the tier (`mcpTrustFor`) when a server is added and each time `mcp.servers` is read; owner-edited commands stay `unknown`.

## 0.3.0-alpha.0

### Minor Changes

- 3bfb9f9: Settings → Model & providers over `models.*` (B1, B4): the Gateway lists configured providers with their last endpoint probe, probes and runs the tool-calling check only on the owner's click, and binds primary / utility picks (a chat-only primary asks before `override`); the Settings UI shows probe state, model capabilities (vision, tools, context) and the picks; the web model picker suggests the listed models.
- e90b086: The web client's Settings → Devices & nodes lists, adds and removes this browser's passkeys, and approval cards that require authentication (purchases, credential fills, host commands, security settings) are approved with a passkey assertion over the card's presence challenge. The kit's `GatewayClient` gains an optional `presence` hook for that. Fixes the Gateway's WebAuthn challenge for `sha256:`-prefixed presence challenges, which made every real browser assertion fail.
- 174516f: The UI kit: theme generator and tokens, typed Gateway hooks with a protocol-validating mock Gateway, every message block, approval and question cards, the avatar system, the chat column, the agent header and sheet, the screens, and Storybook with axe checks.
- 534326e: Skills install and trust (T2): manifest validation and install policy (refused before any card), update detection, the Gateway's `skills.*` handlers and skill tools with third-party descriptions marked untrusted (part of #281), and Settings → Skills with the trust card.
- c1d8e4a: `DiffBlock` shows unified diffs in the kit's code block (Shiki `diff`): on `file_write` cards and under tool rows whose receipt carries a diff. `git_write` and `git_push` cards get their own rows; a push shows its full commit.

### Patch Changes

- 81cf744: Approval, question and wrap-up cards render per surface through one function (`@psyche/permissions/cards`, review design-12): chat transports send `renderForSurface(surface, approval)` and show a device-only approval as "Answer this on your Mac." with nothing answerable; the UI kit's cards consume the desktop rendering from the same function, so the surfaces cannot drift.
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [81cf744]
- Updated dependencies [1dc1561]
- Updated dependencies [4f8dff6]
- Updated dependencies [a43a514]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [e3ef188]
- Updated dependencies [2064c0c]
- Updated dependencies [2be1a8a]
- Updated dependencies [8e28cac]
- Updated dependencies [e87d482]
- Updated dependencies [42496a0]
- Updated dependencies [ecf0dd5]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [fa08fee]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [e83a19e]
- Updated dependencies [412aaa1]
- Updated dependencies [9a0cd76]
- Updated dependencies [4bc7113]
- Updated dependencies [1cf5421]
- Updated dependencies [1cc7f5a]
- Updated dependencies [0d9d34d]
- Updated dependencies [515b904]
- Updated dependencies [d74ccce]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [4d718e6]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [e4e6f97]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
  - @psyche/permissions@0.3.0-alpha.0
