# Chat experience 2026: one block system and an output canvas

Status: proposal (docs only). Companion to `redesign-2026.md`, `run-trace-2026.md`, `motion.md`.

## 1. Goal

One cohesive chat for every wave (run trace, specialists, mail and meetings, voice, teaching, people graph, Ask about my screen), plus a way to **see what any agent is producing**, like Claude Artifacts, **without spending tokens on presentation**.

Principle: the model emits small, typed data; the client owns all rendering, versioning and storage. The model never writes HTML for chrome, and never re-sends content it already produced.

## 2. Research summary

External findings (web research was shallow; items marked kb come from background knowledge and need verification before we cite them):

| Product | Trigger | Edit and version | Token technique |
|---|---|---|---|
| Claude Artifacts | model opens a side pane for substantial standalone content | every edit is a new version with a picker; `update` = exact-once `old_str`/`new_str` replace, or full rewrite (secondhand sources) | tiny replace instead of re-emitting the file; sandboxed iframe, separate origin (kb) |
| ChatGPT Canvas | model or user | highlight a selection to rewrite just that; suggested edits as comments; version history with change tracking | selection-scoped edits (inferred) |
| Gemini Canvas | user toggle | highlight a section plus an instruction | none found |
| v0, Cursor, Windsurf (kb) | the agent | versioned generations; diff cards with a cheap "apply" model | patch-then-apply |
| Perplexity Pages, Raycast AI (kb) | on request | publish step / copy-insert | not an incremental pane |
| Meta Muse | n/a | no reliable information | n/a |
| assistant-ui | n/a | register one renderer per tool name; it receives partial args, result and status, so streaming UI is free | structured result rendered client-side |
| LibreChat | model | artifacts in Sandpack (external bundler by default) | none found |
| Open WebUI | model | sandboxed `srcdoc` iframe, suggested CSP `connect-src 'none'` | none found |
| MCP Apps (SEP-1865) | tool declares `_meta.ui.resourceUri` | host renders it in a sandboxed iframe and pushes the tool result over postMessage | UI is separate from model context; the app must opt in to update context |

Cross-cutting patterns we adopt:
1. Typed tool output rendered by the client (no model-written presentation).
2. Patch edits (exact-match replace, row/cell ops) with full rewrite as the fallback.
3. Stream partial args into the renderer: better latency, no extra tokens.
4. IDs and versions: the model addresses an artifact by `id@version`; content stays in the store.
5. Sandbox every untrusted render in an opaque-origin iframe with a locked CSP.

## 3. Internal audit (packages/ui, packages/protocol, packages/viewers)

### What exists
- Protocol `Block` union: text, tool_call, plan, checklist, approval, question, **artifact**, file, receipt, task, wrap_up, related_threads, compaction, learned, taught. Dispatch is a hard-coded `switch` in `blocks/MessageBlocks.tsx`.
- Cards: ToolRun, DiffBlock, Checklist/PlanCard, ApprovalPointer + dock, QuestionCard, ArtifactCard/FileCard, ReceiptLine, TaskCard, WrapUpBox, RelatedThreads, CompactionMarker, Taught/Learned lines.
- Run trace: RunStepLog, StepList, RunFailure, FollowUpQueue; Timeline (Waterfall, ListView, FrameViewer, StepInspector) in the agent sheet.
- Specialists: SpawnLine, ResultCard (findings | draft | changes | plan | items), InboxRow, FeedResults.
- People and teaching: Entity/Person/Project/Suggestion cards, GrowthCard. Voice capsule and HUD.
- Viewers (`packages/viewers`, lazy): pdf, sheet (Univer editor), document, slides, image/media, code/markdown (CodeMirror), json, email, **artifact (ArtifactFrame, sandboxed; ReactArtifactFrame via Sandpack)**, `ViewerRegistry` by MIME.

### Inconsistencies
1. **Two card generations.** Old: `rounded-lg border border-gray-6 bg-gray-2 p-3` (TaskCard, Checklist, ArtifactCard, FileCard). New: `bg-surface-raised shadow-elevation-1 p-4` (Approval, Question, WrapUp, RunFailure, framed ResultCard). Receipt and ToolRun are borderless chips.
2. **Four "done" vocabularies**: `ToolCallStatus`, `StatusGlyph`, task status, approval text.
3. **No shared card header or footer**: each card hand-rolls icon, title, meta, and actions.
4. **Open actions differ**: slots `openArtifact`, `openLibraryItem`, `openTask`, `openReceipt`; wrap-up and approval send different payloads.
5. **Motion is partial**: `CardEnter` in some cards, raw `psy-enter` in others.
6. **Naming drift**: Card/Line/Box/Pointer/Block; duplicated icon maps and per-block hook plumbing.

### Gaps
1. **No artifact pane in chat.** "Open" routes to the web shell's files pane; `openArtifact` has no web implementation. Inline preview is a thumbnail only.
2. **No tool-result to component map.** `ToolCall` carries `resultRef`, but ToolRun renders a one-line summary plus diff. Sheets, docs, search results, browser frames and mail are never shown from a tool result.
3. **Dispatch is a switch, not a registry**; adding a block touches protocol, MessageBlocks, i18n and stories.
4. **Specialist results are not blocks**; they live in Feed/Inbox, not the transcript.
5. **No artifact versioning or patch protocol.** The `artifact` block points at a stored item only.
6. **Diffs**: only a text DiffBlock and the Markdown editor's diff mode; no file or table diff view.

## 4. Proposal

### 4.1 One block and card system

**Card shell** (`<Card>`): the only chrome. Built on the new surface (`bg-surface-raised`, `shadow-elevation-1`, concentric radii). Slots: `header` (icon, title, status glyph, meta), `body`, `footer` (action bar), plus `variant` = `inline | framed | pinned`. Existing cards migrate onto it; old border style is deleted.

**One status vocabulary**: `pending | running | waiting | done | failed | blocked | cancelled`, with the `uncertain` tool state mapped to `done` plus a warning flag. A single `StatusGlyph` and one adapter per source type.

**One action model**: card actions are `{ id, label, kind: open | send | confirm | undo }`. `open` always means "open in the canvas" (4.2); `send` posts a user message or answer.

**Block registry** replaces the switch: `registerBlock(type, { View, Skeleton, Missing, fixtures })`. Unknown types render a quiet fallback card instead of null. Tool-result renderers register the same way, keyed by tool name or `resultKind` (assistant-ui style): `registerToolView("calendar.list", View)`.

**Fixed block taxonomy** (everything fits one of these):

| Class | Blocks | Rule |
|---|---|---|
| Prose | text | markdown, untrusted gets the marker |
| Activity | tool run, run steps, receipt, task, compaction | borderless chips; fold consecutive items |
| Decision | approval (dock), question, wrap-up | never inline for approval; one primary button |
| Output | artifact, file, specialist result, mail and meeting cards, diffs | **summary card in chat; full view in canvas** |
| Learning | learned, taught, suggestion | one-line, undoable |

Rule: chat carries summaries, the canvas carries content. A card that would exceed about 12 lines becomes a summary card with "Open".

Mail and meeting cards, people cards and specialist results are Output-class cards: a typed `kind` plus a small summary body, and an `open` action targeting the canvas. Voice stays outside the transcript (capsule/HUD); a finished utterance lands as ordinary text blocks. Ask about my screen keeps its floating panel, with "Open in Psyche" creating a transcript thread whose answer is a normal text block plus an image artifact (the cropped region).

### 4.2 The output canvas (artifact pane)

A right-hand pane (sheet on narrow widths) that hosts one **artifact** at a time with tabs for recents. It reuses `packages/viewers` through `ViewerHost` and `ViewerRegistry`; it does not add a second rendering stack.

Artifact types and renderers:

| Type | Content format (model emits) | Renderer |
|---|---|---|
| `doc` | markdown | rich markdown viewer/editor (existing) |
| `code` | text + language | CodeMirror viewer (existing) |
| `table` | `{columns, rows}` JSON or CSV | Univer sheet viewer (existing), editable |
| `chart` | declarative spec (Vega-Lite-like subset or our own `{kind, x, y, series}`) | client chart renderer, no model JS |
| `diagram` | Mermaid text | client Mermaid render, strict mode |
| `html` | HTML string | sandboxed iframe (section 4.6) |
| `diff` | unified diff or `{path, hunks}` for one or more files | new file-diff viewer |
| `image` | blob ref | image viewer |

Canvas chrome: title, type icon, **version picker**, Copy, Download, Open full-screen, and Edit (where the type is editable). Streaming: the pane opens as soon as the `artifact.create` tool call begins, rendering partial args (skeleton, then progressive content), so latency is hidden without extra tokens.

User edits made in the canvas are saved as a new version authored by `user`, and the agent is told only a one-line delta on its next turn (4.3).

### 4.3 Cheap emission (the token model)

Two tools, both typed:

```
artifact.create { type, title, content }              -> { id, version: 1 }
artifact.update { id, base: version, ops: [...] }     -> { id, version: n+1 }
```

Ops by type, smallest first:
- `doc`/`code`/`html`/`diagram`: `{op:"replace", old, new}` (old must match exactly once, otherwise the call fails fast with a short error and the model retries or falls back), or `{op:"insert", after, text}`. `{op:"rewrite", content}` is the fallback and is logged so we can watch how often it happens.
- `table`: `{op:"set", cell|range, value}`, `{op:"addRows"}`, `{op:"addColumn"}`, `{op:"sort"|"filter"}` as view metadata.
- `chart`: JSON-merge-patch on the spec.
- `diff`: generated by the client from two versions; the model never writes one for display.

Context discipline, which is where the savings come from:
1. **The transcript holds references, not bodies.** The model's tool results come back as `{id, version, bytes, hash, summary}`, not the content. The content lives in the artifact store.
2. **The model reads on demand** via `artifact.read { id, range? }`, normally a window or a search hit, not the whole file.
3. **Active artifact injection.** Only the artifact the user currently has open is injected, in a stable prompt-cache prefix block keyed by `id@version`. Older artifacts appear as one-line manifest entries (id, title, type, version).
4. **User canvas edits** reach the model as a compact patch (the same op format) when the user next sends a message.
5. **Tool and run output follows the same rule**: large results (search hits, mail bodies, files, page snapshots) are stored and returned by `resultRef` plus a summary; the client renders the full thing from the ref via the registered tool view. This extends what `ToolCall.resultRef` already does.
6. **Compaction** (existing) replaces superseded versions with the manifest line.

### 4.4 Versioning

- Store per artifact: `id`, `type`, `title`, `versions[]` with `{n, author: agent|user|specialist, ops | snapshot, createdAt, runId}`.
- Snapshot every N versions or when ops exceed a size threshold; otherwise store ops (cheap, and gives the diff view for free).
- Version picker shows author and time; selecting an old version is read-only with "Restore as new version". No destructive history edits.
- Optimistic concurrency: `update` carries `base`. If the user edited in the meantime the agent gets a short conflict result plus the patch it missed, instead of silently overwriting.
- Each version links to the run step that produced it, so the run trace can jump to the canvas and the canvas can jump to the step.

### 4.5 How runs and specialists surface

- **Run output.** A run that produces something yields an Output card in the transcript (artifact summary, status, version, Open). Intermediate steps stay in the run trace; the trace's step inspector gets "Open output" when a step wrote a version.
- **Tool results.** The tool-view registry renders inline compact previews (a calendar list, a search hit list, a mail summary) and an `Open` action that places the full result in the canvas as a read-only artifact (`type` derived from the result kind). Browser frames and screenshots open as `image`.
- **Specialists.** The result of a specialist job becomes a real transcript block (`specialist_result`) in the thread that spawned it, as well as appearing in the Feed/Inbox. Kinds map to artifact types: `findings`/`draft`/`plan` to `doc`, `changes` to `diff`, `items` to `table`. Spawn lines stay as Activity chips and link to the job.
- **Streaming specialists** write to their own artifact via the same tools, so a user can watch a draft form in the canvas while the main chat continues.
- **Mail and meetings.** Compose-mail produces a `doc` artifact (editable, with Send as a confirm-class action through the approval dock). Meeting notes and prep are `doc` artifacts; action items are a `table`.

### 4.6 Sandboxing and security (untrusted HTML)

Model-written HTML and anything derived from web/mail content is untrusted.
- Render only in an `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`, served from an opaque origin (`srcdoc` or a dedicated `artifact://` / sandbox host). No cookies, storage, or app-origin access.
- CSP on the frame: `default-src 'none'; script-src 'unsafe-inline' <pinned CDN allowlist or none>; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'`. No network by default, matching the Open WebUI hardening suggestion; a per-artifact opt-in prompt can enable specific origins, shown like an approval.
- Communication only through a typed `postMessage` bridge from the host (resize, copy, "ask Psyche about this"); the host validates the origin and message shapes, and nothing in the frame can call tools. This deliberately differs from MCP Apps, where the frame may call tools; if we adopt MCP Apps later, tool calls go through the normal approval and taint path.
- Navigation and popups blocked (`allow-popups` off); links open via host `openLink` after a check.
- Every artifact derived from tainted input is marked untrusted in the header; `html` artifacts from untrusted sources start in "preview off" with a **Run** click.
- Charts, diagrams, tables and docs never execute model code: they are data rendered by our components. React/Sandpack artifacts stay behind the existing `ReactArtifactFrame`, self-hosted bundler only (no external CodeSandbox).
- Size and rate caps per version; strip `javascript:` URLs from markdown; Mermaid in strict mode.

### 4.7 Phased build

Each phase ships behind a flag, with stories and fixtures.

1. **Foundations (no new features).** `<Card>` shell, unified status vocabulary, block registry with fallback, action model; migrate old-generation cards; lint rule against hand-rolled card chrome. Visual-regression via Storybook.
2. **Protocol.** `artifact.create/update/read` schemas (TypeBox), version store in the gateway, `resultRef` summaries, manifest injection and cache-prefix rule, `specialist_result` block. Gateway tests for exact-once replace and conflicts.
3. **Canvas v1.** Right pane host on `ViewerHost`; doc, code, table, image; streaming partial render; version picker; Open actions wired from ArtifactCard and ToolRun.
4. **Tool views.** Registry plus inline previews for the top tools (calendar, mail, search, browser snapshot, file ops); read-only open-in-canvas.
5. **New types.** diff viewer, chart, diagram, html with the sandbox; sandbox security tests (escape attempts, CSP, no-network).
6. **Specialists, mail, meetings.** Transcript result blocks, editable draft artifacts, send via approval dock, run-trace links.
7. **Polish.** Motion pass (`CardEnter` everywhere), a11y, i18n, narrow-width sheet, Ask-about-my-screen handoff, token-cost dashboard (rewrite vs patch ratio, bytes avoided).

## 5. Decision points (recommended defaults first)

1. **Canvas layout.** Right pane on wide windows, bottom sheet on narrow, one artifact at a time with recents tabs. *Default: yes.* (Alternative: inline expandable cards only.)
2. **Edit protocol.** Exact-once `replace` ops with `rewrite` fallback, plus typed table/chart ops. *Default: yes.*
3. **Auto-open policy.** Open the canvas automatically only when an artifact is created in the foreground run; otherwise show a card and let the user open it. *Default: this.*
4. **Artifact types for v1.** doc, code, table, image first; chart, diagram, diff, html in phase 5. *Default: this order.* Charts use our own small spec, not model-written JS.
5. **HTML artifacts.** Allow with the opaque-origin sandbox and `connect-src 'none'`, off by default for tainted sources. *Default: allow.* (Alternative: no HTML at all.)
6. **Storage and versions.** Gateway-side store, ops with periodic snapshots, user edits as first-class versions, no history deletion. *Default: this.*
7. **Specialist results.** Promote to transcript blocks and also keep Feed/Inbox. *Default: both.*
8. **Rollout.** Do phase 1 (card shell and registry) before any new wave of cards lands, and freeze new hand-rolled card chrome until it ships. *Default: yes.*

## 6. Open questions for verification

- Confirm Claude Artifacts' exact update semantics and sandbox host from official docs; our design does not depend on the details.
- Check Vercel AI SDK data-part format and assistant-ui's current recommended tool-UI API before choosing the registry shape.
- v0, Cursor, Perplexity, Raycast and Muse were not verified from primary sources.
- Prompt-cache hit economics for the active-artifact prefix should be measured on our router before we promise numbers.
