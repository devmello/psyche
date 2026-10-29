# Generative UI (agent-built widgets in chat)

Owner request, 2026-10-29: "generative UI where the agent can generate UI to make the progress, the tasks, widgets, in the chat live so that we don't need to create it before."

Status: **plan only**. Nothing here is built. Owner decisions are collected in §11, each with a recommendation.

## 1. Summary

The agent gets two tools, `render_ui` and `update_ui`. `render_ui` takes a **widget spec**: a small JSON tree of components from a fixed catalogue (progress, checklist, timeline, stat tiles, table, small charts, buttons, forms, layout). The spec is data, never code. The Gateway validates it against a versioned TypeBox schema, stores it as a **Widget** entity with an id and a revision, and puts a `ui` block in the message that points at it, the same way `approval` and `question` blocks point at their entities today. `packages/ui` renders it with the existing tokens.

Widgets stay live. The agent, a tool, a background job or a scheduled task can patch a widget by id while the run is going and after it ends, or **bind** a widget to a host entity (a Task, an automation, a research run) so the host keeps it current without the model spending tokens. Every button and form goes through the existing ask/answer flow or the Permission Broker; a widget can never perform a write on its own and can never look like an approval card. Anything the catalogue can't express goes to a sandboxed artifact, as today.

## 2. What exists today

Audited on main at `6d163174`.

| Piece | Where | What it means for this design |
| --- | --- | --- |
| Typed block union | `packages/protocol/src/schemas/blocks.ts` (`Block`, discriminator `type`), `Message.blocks` in `schemas/threads.ts` | A new `ui` block slots in as one more member. |
| Reference blocks | `approval` = `{approvalId}`, `question` = `{inputRequestId}`; cards read the entity from the store | The pattern to copy: the block holds a `widgetId`, the spec lives in its own entity so it can change without rewriting the message. |
| Block registry | `packages/ui/src/blocks/registry.tsx`, registrations in `blocks/MessageBlocks.tsx`; unknown types → `UnknownBlock` | The widget renderer registers once and is lazy-loaded. |
| Approval card | `blocks/ApprovalCard.tsx` (fixed template from `packages/permissions/src/cards.ts` `renderForSurface`), docked by `chat/ApprovalDock.tsx`; `ui/test/card-chrome-lint.test.ts` | Already host-owned and outside the message stream (docs/05 §3.7). §7.4 builds on this. |
| Question card | `blocks/QuestionCard.tsx`, answered with `questions.answer` | Widget choices reuse it (§6.2). |
| Plan / checklist / wrap-up | `plan`, `checklist` (`blocks/Checklist.tsx`, fed by the `update_plan` tool in `packages/agent-core/src/context.ts`), `wrap_up` (`blocks/WrapUp.tsx`, buttons send a message) | Fixed shapes for one job each. Generative UI generalises them; they stay as they are. |
| Research progress (#1001) | No block: a tool call plus `research.progress` events (`schemas/research.ts`), `research/ResearchProgress.tsx` | Live state today comes from bespoke per-entity events. Bindings (§5.4) let a widget reuse those streams. |
| Schedule card (#1002) | `automation_workflow` block, `blocks/AutomationWorkflowCard.tsx` | Stays the typed proposal card; a widget can bind to an automation's run status. |
| Edit-audit chip (#985) | Not a block: `chat/ChangeChip.tsx` from `audit.change.recorded` | Unaffected. |
| Source chips (#1012) | `sources` block, `blocks/SourceChips.tsx`, untrusted border | Widgets reuse the untrusted border and label. |
| Artifacts | `packages/viewers/src/core/artifact.ts`: inner `<iframe sandbox="allow-scripts" srcdoc>`, CSP `default-src 'none'`, `connect-src 'none'`; hosted on a separate origin whose host page (`ArtifactFrame.tsx`, `allow-scripts allow-same-origin` by design, see the file header) builds the inner frame. React via self-hosted Sandpack (`react/sandpack.ts`) | The escape hatch (§6.5). |
| Documents (#997) | `docs/design/documents-2026.md`: doc/sheet/slides canvas artifacts with typed ops, versions, exports | Not a widget concern; a widget can link to a document. |
| MCP Apps | `packages/mcp-host/src/host.ts` serves declared `ui://` resources; no RPC or UI host yet | Out of scope; a later phase can render `ui://` through the artifact frame (§10, P9). |
| Markdown | Streamdown in `blocks/Markdown.tsx`: `skipHtml`, `isSafeLink` (http(s), mailto, `#`, relative) | Widget `markdown` and text props reuse this component as is. |
| Live events | `frames.ts`: `seq` + `stateVersion`; gaps → refresh (`ui/src/data/store.ts`), no replay. `chat.block` is append-only; live state goes through per-entity events (`tool_call.updated`, `task.updated`, `research.progress`, `approval.updated`) | A `widget.updated` event fits this model; reconnect = refetch snapshots. |
| Persistence | `messages.blocks` JSON (`packages/db/migrations/202610182200_db_init.sql`, `packages/db/src/schema.ts`) | A new `widgets` table; the message keeps only the reference. |
| Taint | docs/05 §3.6; `TaintSource` in `schemas/permissions.ts`; turn-scoped, per tool call and Task; display in `ToolRun.tsx`, `blocks/taint-text.ts` | No per-block taint field exists. Widgets add one (§7.3). |
| Feed / Overview | `FeedPost.card` (`schemas/surfaces.ts`), `screens/feed/`; `packages/ui/src/overview/`. Only threads pin | Feed snapshot and Overview pinning are new (§8). |
| Channels | `apps/gateway/src/compose/channels.ts` forwards only `text` blocks; approvals go as text via `packages/channels/src/format/approval-card.ts` | Widgets need a text fallback (§8). |

## 3. Goals and non-goals

Goals: the agent can show progress, task lists, status, numbers, tables, charts and simple inputs without a developer adding a block type first; they update live; they are as safe as text.

Non-goals: arbitrary layout or styling, animation authoring, replacing the typed host cards (approval, question, automation proposal, research progress, plan), or a general app runtime. Those are artifacts.

## 4. The widget spec (v1)

### 4.1 Shape

```jsonc
{
  "v": 1,
  "title": "Inbox cleanup",            // shown in host chrome, ≤ 80 chars
  "fallbackText": "Inbox cleanup: 3 of 5 steps done (60%).", // channels, a11y summary, copy
  "root": {
    "id": "root", "type": "stack", "children": [
      { "id": "p", "type": "progress", "label": "Cleanup", "value": 3, "max": 5 },
      { "id": "steps", "type": "checklist", "items": [
        { "id": "s1", "label": "Archive newsletters", "state": "done" },
        { "id": "s2", "label": "Draft replies", "state": "active" },
        { "id": "s3", "label": "Unsubscribe", "state": "todo" }
      ]},
      { "id": "go", "type": "button", "label": "Draft the replies now",
        "action": { "kind": "reply", "text": "Draft the replies now" } }
    ]
  }
}
```

Every node has an `id` unique in the widget (`^[a-z0-9_-]{1,40}$`) and a `type`. Ids are how patches address nodes, so the agent should pick stable, meaningful ones.

### 4.2 Catalogue

| Group | Node types | Notes |
| --- | --- | --- |
| Progress and status | `progress` (value/max or indeterminate, optional `steps[]`), `checklist` (items with `todo / active / done / skipped / failed`), `timeline` (entries with time, label, tone), `status` (one-line badge with tone) | The core of the request. |
| Numbers | `stat` (label, value, unit, delta, tone), `kv` (label/value rows) | |
| Data | `table` (columns with type `text / number / date / link`, rows; sortable by the host), `chart` (`bar / line / sparkline`, ≤ 4 series) | Charts are a small in-house SVG renderer, not a chart library (§9). |
| Content | `text` (plain), `markdown` (via `Markdown.tsx`), `code` (Shiki via `blocks/highlighter.ts`), `image` (§7.2), `map` (§11 D4), `link` (host-routed) | |
| Containers | `card` (title, subtitle, children), `list` (items with title, meta, optional action) | |
| Interaction | `button`, `choices` (single or multi), `form` (fields: `text / textarea / number / select / toggle / date`, one submit) | Every action is one of the kinds in §6.2. |
| Layout | `stack` (vertical/horizontal, gap from a fixed scale), `grid` (2–4 columns, collapses on narrow widths), `tabs` | No absolute positioning, no sizes in pixels. |

Styling is semantic only: `tone` is one of `neutral / info / success / warning / danger`, `emphasis` is `normal / strong`, `density` is `compact / comfortable`. The renderer maps those to the existing tokens in light and dark. There are no colour values, fonts, CSS or class names in the spec, and the approval card's accent is not one of the tones (§7.4).

### 4.3 Schema and versioning

- `packages/protocol/src/schemas/widgets.ts`: `WidgetSpec`, `WidgetNode` (a TypeBox union with `Type.Recursive`), `WidgetPatch`, `Widget` (entity), `WidgetAction`. `UiBlock = {type: "ui", widgetId}` joins `Block`. Codegen as usual (`pnpm protocol:gen`; Swift gets the types for free).
- `spec.v` versions the catalogue separately from `PROTOCOL_VERSION`. Changes are additive (new node types, new optional props), like the rest of the protocol (`packages/protocol/CHANGES.md`). A renderer that meets an unknown node type renders that node's `fallbackText` (every node may carry one) or nothing, never the whole widget as an error.
- Limits, enforced by the Gateway validator, not by the model's good manners: spec ≤ 32 KB serialized; ≤ 200 nodes; depth ≤ 8; strings ≤ 500 chars (`markdown` ≤ 8 000); `table` ≤ 500 rows stored, 25 shown with "Show all"; `chart` ≤ 4 series × 365 points; `form` ≤ 12 fields; ≤ 6 buttons per container. A rejected spec returns a precise validation error to the model so it can fix and retry in the same turn.

## 5. Live updates

### 5.1 Entity and storage

`Widget = {id, threadId, messageId, rev, spec, taint, owner, binding?, state: "live" | "frozen", pinned, createdAt, updatedAt}`.

New table `widgets` (id, thread_id, message_id, rev, spec JSON, taint JSON, owner JSON, binding JSON, state, pinned, created_at, updated_at), written through the existing writer guard. Only the latest snapshot is stored (D7); the transcript holds the `ui` block, so reloading a thread shows each widget as it last was.

### 5.2 Patches

`update_ui({widgetId, baseRev?, ops[]})`, ops addressed by node id rather than JSON Pointer paths (paths break when the agent inserts a sibling):

- `set {id, props}`: shallow-merge props of one node (e.g. `{value: 4}` on a progress).
- `append {id, items | rows | points | children}`: add to a list-like node; `prepend` likewise.
- `remove {id}`, `replace {id, node}`.
- `meta {title?, fallbackText?}`.

The Gateway applies patches serially per widget, re-validates the whole result against the limits, bumps `rev`, persists, and publishes `widget.updated {widgetId, rev, ops}` on the thread. If `baseRev` is given and stale the patch is rejected with the current rev, so a model that raced a binding can re-read and retry. Patches to one widget are coalesced to at most 4 publishes a second; a patch is ≤ 8 KB.

### 5.3 Who may patch

`owner` records who created the widget: `{kind: "run", runId}`, `{kind: "task", taskId}`, `{kind: "automation", automationId}` or `{kind: "job", jobId}`. Patches are accepted from:

- the agent in the same thread, in this run or any later run (it gets the ids back from `render_ui` and can list its live widgets with a `list_ui` read);
- the owning Task, automation or job through a Gateway-internal handle (`widgets.patch`, not exposed to other threads);
- the host, through a binding (§5.4).

Nothing else. A tool in another thread, an MCP server or a channel message cannot address a widget by guessing its id.

### 5.4 Bindings (live without tokens)

A node can bind to a host entity instead of carrying values: `"bind": {"source": "task", "id": "tsk_…", "field": "progress"}`. Sources in v1: `task` (status, plan steps, progress), `automation` (next run, last run status, run history; this is where the Scheduled tasks view work plugs in), `research` (the `research.progress` phases), `tool_call` (status), `job` (background-mode jobs). The renderer subscribes to the events that already exist for those entities, so a progress widget for a background task, or a scheduled task's status, stays current after the run that drew it has ended, with no model involvement and no patches stored. A bound value that the owner can't see (entity deleted, other thread) renders as "Unavailable".

Bindings are the recommended way to show anything the host already tracks; manual patches are for state only the agent knows.

### 5.5 Streaming, ordering, reconnects, replay

- **While the model writes the spec.** P3 renders on the complete tool input: the `tool_call` block shows "Building widget…" with a skeleton sized from the declared `title`. P9 adds progressive rendering: the Gateway partial-parses the streaming tool input and publishes ephemeral `widget.draft` frames for nodes that are already complete (closed objects), never half a node. Drafts are not persisted; the committed spec replaces them.
- **Ordering.** `rev` is the order. The client applies `widget.updated` only when `rev == local + 1`; otherwise it refetches with `widgets.get([id])`.
- **Reconnect.** The store already refreshes on a `seq` gap (`ui/src/data/store.ts`). On refresh it refetches snapshots for widgets in loaded messages and pinned widgets in one `widgets.get` call.
- **Reload and history.** `chat.history` returns messages with `ui` blocks; the client batches `widgets.get` for the page. A frozen widget renders the same as a live one minus its live dot.
- **Freezing.** A widget freezes when its owner ends and it has no binding, when the thread exceeds the live cap (§9), or after 7 days without a patch. Frozen widgets keep their last snapshot and their buttons still work (they only send messages or propose calls), but take no more patches or event subscriptions.

## 6. Interaction and escape hatch

### 6.1 Principles

No auto-actions: nothing fires on render, on a timer, on hover or on focus. Every action needs a click or Enter/Space on a focused control by the owner, in a host-rendered control. The renderer, not the spec, decides what a control does with that gesture.

### 6.2 Action kinds

| Kind | What happens | Permission path |
| --- | --- | --- |
| `reply {text}` | Sends `text` as an owner message in the thread, shown in the transcript with a small "from widget" chip so the owner sees exactly what was sent. | It is the owner's message; the run that answers it is a normal turn. |
| `answer {inputRequestId, value}` | Answers an open question (`questions.answer`). `choices` with `"ask": true` is rendered from a real `InputRequest` the Gateway creates, so it is the existing ask/answer flow with a richer layout. | Existing. |
| `form submit {as: "reply"}` | Field values (typed by the owner) are composed into an owner message, visible in the transcript. | As `reply`. |
| `form submit {as: "tool", tool}` / `button {kind: "tool", tool, args}` | Proposes one tool call with the given args (form fields filled in). The Gateway hands it to the agent loop as if the model had called it in a new turn, so it meets the Permission Broker, the binding hash, grants and taint exactly as the equivalent model call would. If the policy says `ask`, the real approval card appears in the dock. | Broker; never weaker than the model calling the tool. |
| `open {route | artifactId | fileId | url}` | Host navigation: an app route (like `app_link`), an artifact, a file viewer, or a link through the existing safe-link path. | Navigation rules (new origin in a tainted context asks, docs/05 §3.6). |

A widget button with `kind: "tool"` carries a host-drawn marker ("asks first" when the Broker would ask) so the owner knows a click opens an approval, not performs the action. Tool actions are D2: recommended, but shipped after the read-only and reply/answer phases.

### 6.3 Read tools

Buttons may also call read-only tools (e.g. "Refresh" calls `list_ui` or a search). These go through the Broker too; reads that are `allow` by policy run without a card and their results can patch the widget.

### 6.4 When the agent uses UI

Render UI when the answer is **state** (progress, a task list, a status that will change), **structure** (more than ~4 comparable items, numbers worth scanning, a trend) or **a choice** the owner makes with a click. Write text when the answer is explanation, opinion, a short fact, or anything the owner will want to quote. Keep widgets compact: one widget per purpose, default `density: compact`, a title, no decoration, no repeated text around it ("Here is a widget showing…" is banned in the guidance). Update an existing widget instead of drawing a new one. Prefer a binding over patches. Always write a real `fallbackText`.

This guidance goes into the `render_ui` tool description and a short section of the system prompt, plus an eval set (P3) with cases where text is the right answer.

### 6.5 Declarative spec or artifact

| Use a widget spec when | Use an artifact when |
| --- | --- |
| It fits the catalogue: progress, lists, tables, stats, small charts, simple forms. | It needs custom layout, drawing, animation, game logic, or a chart type the catalogue lacks. |
| It must update live from the agent, a job or a binding. | It is a self-contained thing the owner will open, keep or export. |
| It needs buttons that act (reply, answer, tool via the Broker). | It only needs in-page interaction (artifacts have no network and no host actions). |
| It must work in Feed, Overview and channels (text fallback). | Desktop/web only is fine. |

Artifacts keep their current sandbox unchanged. A widget can link to one with `open {artifactId}`; an artifact cannot embed or patch a widget.

## 7. Security

### 7.1 Specs are data

- No script, no event handlers, no HTML: the spec has no field that takes markup. `markdown` goes through `Markdown.tsx` with `skipHtml` and `isSafeLink`. All other strings render as text nodes.
- No CSS, class names, colours, fonts, pixel sizes or z-index. The renderer owns every style.
- No remote fetches by the renderer except images under §7.2. Links render through the safe-link path and open on click only.
- The validator rejects unknown props (`additionalProperties: false`), so smuggling fields for a future renderer doesn't work.

### 7.2 Images and maps

`image.src` is one of: a local file id or artifact asset id served by the Gateway (`fileId`), a `data:` image ≤ 256 KB, or an `https` URL. Remote URLs are off by default (D3); when the owner allows them they load through a Gateway image proxy (strips cookies and referrer, size cap, image types only), and in a tainted widget they stay behind a "Load image" click so an injected spec can't use them as tracking beacons. `map` in v1 is a list of places with "Open in Maps"; tiles are D4.

### 7.3 Taint

- `Widget.taint` is a list of `TaintSource` (the type in `schemas/permissions.ts`). At `render_ui` and at every `update_ui`, the Gateway adds the current turn's taint sources (docs/05 §3.6), whether or not the model says the content came from them. Patches from a tainted turn taint the widget; taint is monotone and never removed by a later clean patch. A binding to an entity carries that entity's taint (a Task's `taintedSources[]`).
- Display: a tainted widget gets the same untrusted border and label as `ToolRun` and `SourceChips`, in its host chrome, with the sources listed on hover/focus (`blocks/taint-text.ts` wording).
- Actions from a tainted widget are tainted. A `tool` action carries the widget's taint into the proposed call as requester taint, so the Broker treats it as a tainted turn: `once` only, `taint:floor` applies, new targets ask. A `reply` from a tainted widget is an owner message whose text was chosen by tainted content, so the turn it starts inherits the widget's taint. The owner clicking does not launder it: the click proves the owner wanted *something*, not that the agent-authored args are what they wanted. Form fields the owner typed are owner content; the template and any prefilled values are not.
- Pinned and Feed copies keep the taint.

### 7.4 No fake approval UI

Prompt injection must not be able to draw something the owner mistakes for an approval. Layers, each enough on its own to stop the attack it names:

1. **Generated UI can't approve anything.** There is no action kind that answers an approval. `approvals.answer` needs a single-use `answerToken` that only the host card holds; the widget renderer never receives one. A fake "Allow" button can at most send a reply or propose a tool call, and a proposed call meets the real Broker and the real card.
2. **Placement.** Approval cards render only in `ApprovalDock` and the host card slots (docs/05 §3.7: outside the message stream). Widgets render only inline in the message column, in normal flow, with `contain: layout paint` and `overflow: clip` on their container, so nothing in a widget can overlap the dock, the composer or another message. No sticky, fixed or absolute positioning exists in the catalogue.
3. **Chrome.** Every widget sits in a host-drawn frame the spec can't remove or restyle: a header with a "Made by Psyche" glyph, the widget title, the live/frozen dot, the taint label when tainted, and a menu (copy text, pin, freeze, view source spec). The approval card keeps its own distinct chrome (elevated surface, shield and fingerprint icons, full-argument layout, dock position).
4. **Reserved vocabulary.** The approval accent colour and the `ShieldCheck`, `Fingerprint` and lock icons are not available to widgets (the icon set is an allowlist that excludes them). Button labels that start with approval words (Allow, Approve, Always allow, Deny, Grant, Authorize, Confirm payment) are rejected by the validator; the model gets an error telling it approvals are host-owned. The `ui/test/card-chrome-lint.test.ts` lint extends to the widget renderer.
5. **Tests.** A red-team suite (P7) feeds injected specs that imitate the approval card (copied text, layout, labels, tone tricks, Unicode lookalikes for the reserved words) and checks they are rejected or render inside widget chrome with no route to `approvals.answer`.

### 7.5 Abuse limits

Spec and patch size caps (§4.3), patch rate coalescing (§5.2), live cap per thread (§9), and `reply` actions rate-limited to one per click with a 1 s debounce so a widget can't be made into a message cannon.

## 8. Surfaces

- **Desktop and web chat:** full renderer, the same `packages/ui` component in both.
- **Mobile companion** (docs/design/mobile-companion-2026.md): same renderer in the web build; native shells can render the text fallback until a native renderer exists.
- **Feed:** a `FeedPost` may carry a widget snapshot (new optional `widget` field next to `card`). v1 is a static snapshot with `open` and `reply` actions only (D8).
- **Overview / dashboard:** "Pin to Overview" in the widget menu (`widgets.pin`) adds a live widget to an Overview section; pinned widgets keep their bindings (a scheduled task's status, a background job's progress) and count against their own cap of 6. Unpin from either place.
- **Channels (Messages, Telegram, etc.):** widgets never render; the channel gets the spec's `fallbackText`, followed by a host-generated text summary for the main nodes (progress → "3/5 · 60%", checklist → lines with ☐/☑, table → first 5 rows, stat → "label: value"). Buttons become nothing (or, for `answer` choices, the existing channel question flow where the adapter supports it). Live updates are not sent to channels, except a final summary when a bound background job finishes, if the owner opted into that notification. `apps/gateway/src/compose/channels.ts` gains the `ui` case next to `text`.

## 9. Performance and RAM

- The widget renderer is a lazy chunk loaded on the first `ui` block in a session; tables and charts are their own chunks inside it. Charts are a ~300-line in-house SVG renderer (bar, line, sparkline) on the existing tokens, so no chart library joins the bundle or the heap.
- No new processes, workers or always-on services. Patches and bindings ride the existing Gateway WebSocket and events.
- The client keeps snapshots only for widgets in loaded messages plus pinned ones; widgets scrolled out of the virtualised list drop their binding subscriptions and resubscribe on mount.
- Live cap: 8 live widgets per thread (D6). Drawing a ninth freezes the least recently patched one. Pinned widgets are capped at 6 across the app.
- Gateway cost: one row per widget, latest snapshot only, coalesced writes.

## 10. Phased plan

Each phase is one PR unless noted. P1–P3 give a useful read-only feature; later phases are independent of each other except where noted.

| Phase | PR | Contents | Done when |
| --- | --- | --- | --- |
| P1 | Protocol + storage | `schemas/widgets.ts` (spec v1, patch, entity, actions), `UiBlock`, `widget.updated` event, `widgets.get` method, `widgets` table and migration, validator with limits and reserved-word check, codegen. | Schema tests, validator tests (limits, unknown props, reserved labels). |
| P2 | Renderer (read-only) | Lazy `ui` block in `packages/ui`: host chrome, progress, checklist, timeline, status, stat, kv, table, card, list, text, markdown, code, stack/grid/tabs; tones on tokens; taint border; Storybook stories light/dark; a11y (§10.1). | Storybook + unit tests; axe on stories. |
| P3 | Agent tools | `render_ui`, `update_ui`, `list_ui` in agent-core; Gateway apply/coalesce/persist/publish; ownership; live cap and freezing; tool descriptions and system-prompt guidance; small eval set (UI vs text). | Gateway tests; evals pass. |
| P4 | Bindings | `bind` for task, automation, research, tool_call, job; renderer subscriptions; coordinate with the Scheduled tasks view for automation fields. | A background task's progress widget updates after its run ends. |
| P5 | Charts and images | In-house SVG charts with data-table alternative; images from file ids and `data:`; remote images behind D3 with the Gateway proxy. | Tests; bundle-size check on the lazy chunk. |
| P6 | Interaction I | `reply`, `answer` (choices via InputRequest), `open`, forms submitting as replies; "from widget" chip; tainted-reply inheritance. | Tests incl. taint inheritance. |
| P7 | Interaction II + red team | `tool` actions through the Broker with taint carried; "asks first" marker; red-team suite for fake approvals (§7.4). | Red-team suite green; docs/05 gets a §3.x on widget actions. |
| P8 | Surfaces | Channel text fallback; Feed snapshot field; Overview pinning (`widgets.pin`, Overview section). | Channel formatter tests; Overview story. |
| P9 | Later | Progressive `widget.draft` rendering of streaming specs; MCP Apps `ui://` rendering through the artifact frame; optional map tiles (D4). | Separate design notes as needed. |

### 10.1 Accessibility (built into P2, not a later pass)

- The renderer owns roles: `progressbar` with `aria-valuenow/min/max` and `aria-valuetext`; `list`/`listitem` for checklists with state in text, not only icons; real `<table>` with `<th scope>`; `tablist`/`tab`/`tabpanel` with arrow-key navigation; native buttons and form controls with labels.
- `label` is required on progress, chart, image (`alt`), form fields and icon-only buttons; the validator rejects specs without them.
- Each chart renders a visually hidden data table and a one-line summary; colour is never the only signal (tones pair with an icon or text).
- Live updates announce through one polite live region per widget, throttled to one announcement per 5 s, and only for `progress` milestones and status changes, so a busy widget doesn't flood a screen reader.
- Keyboard: widgets are in the tab order after their message; Escape leaves a widget's inner focus. `prefers-reduced-motion` disables value animations.
- Light and dark come from tokens; contrast is checked in Storybook per tone.

## 11. Owner decisions

**Accepted by the owner on 2026-10-29:** all ten recommendations below, as written. Implementation has not started; it begins with the first phase in §12 when the owner asks.

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | How the agent emits UI: tools (`render_ui`/`update_ui`) or a fenced block in its text (` ```psyche-ui `). | **Tools.** Typed input, validation errors the model can act on, taint attached at the call, no parser in the text stream. |
| D2 | May widget buttons propose tool calls at all? | **Yes, from P7**, always through the Broker with taint carried, never weaker than the model calling the tool. Ship read-only and reply/answer first. |
| D3 | Remote images in widgets. | **Off by default**; when on, through the Gateway proxy, and click-to-load in tainted widgets. |
| D4 | Maps: tiles from a provider, or a place list with "Open in Maps". | **Place list in v1.** Tiles mean a network dependency and a privacy leak; revisit as an opt-in later. |
| D5 | Pin widgets to Overview. | **Yes**, cap 6, keeps bindings live. |
| D6 | Live widgets per thread. | **8**, least recently patched freezes first. |
| D7 | Keep patch history or only the latest snapshot. | **Latest snapshot only.** Less disk and RAM; the transcript already says what the agent did. |
| D8 | Feed widgets live or static. | **Static snapshot** with open/reply in v1. |
| D9 | Can the agent patch its widgets in later runs of the same thread? | **Yes**, same thread only; other threads, MCP servers and channels never. |
| D10 | Should widget replies show in the transcript? | **Yes, always**, with a "from widget" chip. No hidden owner messages. |
