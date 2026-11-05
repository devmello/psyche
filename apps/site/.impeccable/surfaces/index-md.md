---
version: 1
slug: "index-md"
primary_target: "index.md"
related_targets: []
---

# Landing page (apps/site/index.md)

Mode: Persuade. Audience: owners first (deciding whether to trust an agent with their life), developers second. Action: star/watch on GitHub; secondary, build from source. Proof: real UI clips recorded from Storybook on fictional fixture data (`public/demos/`). Constraints: alpha, macOS only, unsigned; no invented proof; reduced-motion and no-WebGL fallbacks; phone width without horizontal scroll; Muse mentioned once, low on the page.

## Direction contract

THESIS: The page is one open notebook on a desk: Psyche's memory, receipts and approvals are paper you can read. It refuses the category default of a centred headline over a product screenshot and a row of feature cards.

OWN-WORLD: The app's ink world. Paper grays (gray-1..12, hue 80), one ink accent #2c5aa0 per view, amber only for "needs you". New York display serif for titles, system sans for text, mono only for real file paths, ids and commands. Sheets of paper with soft offset shadows, ruled margins, running heads that name the file a page is about. Dark mode is the desk at night: the sheets stay paper under the lamp.

STORY: A visitor sees that Psyche keeps its memory as files, watches it remember with sources, search, catch up, ask before acting and leave receipts, reads exactly what stays on the Mac and what is not finished, then stars the repo or builds it.

FIRST VIEWPORT: A two-page spread filling the viewport under a quiet nav. Left page: serif headline at display scale, two-sentence deck, ink "Star on GitHub" button with "Build from source" beside it, status line (alpha, macOS, Apache-2.0). Right page: a real-time three.js stack of sheets (MEMORY.md, a receipt, an approval) leaning on the gutter; pointer tilts it, scroll fans the sheets apart. HTML stack paints first and stays as the fallback.

FORM: Notebook of files, position 5 on my list, dealt lead. seed:6e35e2e9750f5d1a. Signature interaction: the sheets fan apart along the scroll and each label reads as its file name. Motion grammar: sheets are laid down (rise, settle, shadow tightens), ink rules draw; nothing idles.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Scroll choreography (follow-up, 2026-11-04)

Owner ask: the page should get more animated as it scrolls, not blander; every section needs one strong, scroll-linked moment that shows what Psyche does.

MOTION THESIS: The scroll is the agent's working day. Each section scrubs one sequence of the product's own mechanism. Hero: the stack fans into four files. Memory: mail, chat and calendar scraps travel into MEMORY.md and become lines with source chips (pinned). Brief: Home's brief inks in word by word and each claim snaps on its numbered source (pinned). Search and Home: the two pages are dealt onto the desk from either side. Approvals: the lights go down, the lamp comes on, a running send stops at the approval card, Allow once is pressed, the card folds away and the receipt prints (pinned). Receipts: lines print along a drawn hash chain. What stays: rows file into a line around "This Mac" that draws shut; only model calls cross it, telemetry is struck. Status: items are checked off. Close: the commands type out.

GRAMMAR: one engine (`scroll-scenes.ts`) writes `--p` 0 to 1 per `[data-scene]`; CSS derives every transform, clip and opacity from it, so motion is scrubbed, not triggered. Pins only at ≥961 px wide and ≥760 px tall; elsewhere pin scenes run over their own height. Default `--p: 1` is the finished state (no script, reduced motion). Clips play one at a time and hold still while the page scrolls. Illustrations are labelled as illustrations with fictional data; the real UI clips follow each one.


## Demo stages (round 3, 2026-11-04)

Owner ask: show the app's functions, traits and use cases with demos, not long text scrolls that prove nothing (the cited-sentence section was the example). Owner answers: demos scrubbed by the scroll on desktop; include the iPhone app.

THESIS: Below the hero, the page is six use cases, each shown by the real app doing it. A pinned stage per use case: the recording on one side, a heading, one line and three to five steps on the other. The scroll is the playhead: the clip moves only as you scroll, runs backwards when you scroll up, and each step lights as the clip reaches it; a hairline under the clip shows the position, with a tick per step. A step is a button that shows its moment.

SEQUENCE: Hero (unchanged) · Home: what needs you, catch-up with its source, the brief · Search: a question answered with source chips, a chip opened to the passage and the mail · Approvals under the lamp: a vault fill stopped at its card, Allow once, the email still waits · Memory: Review with the words each fact came from, Confirm, then the person's page · Devices: pairing code, what each device may do, then the iPhone app answering an approval · Files: SOUL.md to AGENTS.md, MEMORY.md opened as Markdown · Status · Close.

PROOF RULES: every recording is the real UI on fictional fixture data (Storybook stories in `packages/ui`, `Site demos` stories for the scripted ones; the iPhone take from the Debug build's `-psycheScenario live` fixtures), labelled "Recorded from the app on fictional data." Only features on main; Teach by showing and shared skills are not featured until they merge. The iPhone app is called in development.

GRAMMAR: stages are dealt onto the desk from alternating sides (`--e`), set aside as they leave (`--x`), and alternate which side holds the recording. Pinned only at ≥961 px wide and ≥760 px tall; elsewhere the clip plays when in view, one at a time, and the steps follow it. Reduced motion: posters at each clip's key moment, nothing pinned, Play on request.
