# Spike 04 — Accessibility-tree snapshots for an LLM on macOS

Time box: one day. You are a Psyche engineer (read `README.md`) running a throwaway Swift prototype in `spikes/ax-snapshot/` with a write-up in `docs/spikes/spike-04-ax-snapshot.md`. Branch `spike/04-ax-snapshot`. Do not touch any package.

## Read first
`prompts/_shared-rules.md`; `docs/02-architecture.md` §6; `docs/05-security-and-permissions.md` §12; `research_notes/Psyche personal agent landscape/macos_vm_and_integration.md` KQ3; `claude_desktop_and_peers.md` Q3.

## Question to answer
How good are Accessibility-tree snapshots as the primary (screenshot-free) representation for driving Notes, Mail, Finder, System Settings, Safari (read-only) and an Electron app, and what does the snapshot format need to look like?

## Build
1. A signed command-line tool (ad-hoc is fine for the spike; note the TCC reset pitfall) that, given a running app, walks the focused window's AX tree with depth and node limits, prunes non-interactive containers, and emits one line per element: stable ref, role, title/value, enabled/focused, bounding box in screen points, available actions; sets `AXManualAccessibility` for Electron apps.
2. Actions by ref: `AXPress`, `AXSetValue`, focus, and a `CGEventPost` fallback for click/type; scroll.
3. Tasks to attempt from the tree alone: create a Note with a title and body; create a Reminder; open a folder in Finder and rename a file; read the current Safari tab's URL and title; fill a form in an Electron app.
4. Measure snapshot time and size per app; record where the tree was insufficient and a screenshot would be needed.

## Report
The recommended snapshot schema (fields, limits, ref stability rules), per-app findings, the permission prompts encountered and their order, screenshot-fallback triggers, and guidance for S14's `computer.*` capabilities.
