---
name: Psyche Docs
description: The app's ink world on paper. A notebook of plain files on a desk, for the public docs site and its landing page.
colors:
  ink: "oklch(0.4727 0.1241 258.67)"
  ink-hover: "oklch(0.4377 0.1217 258.67)"
  ink-text: "oklch(0.4727 0.1241 258.67)"
  ink-soft: "oklch(0.9662 0.0171 245.79)"
  ink-soft-2: "oklch(0.9393 0.0303 249.57)"
  ink-line: "oklch(0.803 0.0742 258.67)"
  amber: "#ffc53d"
  amber-line: "#f3d673"
  amber-text: "#ab6400"
  amber-soft: "#fefbe9"
  paper-1: "oklch(0.991 0.0013 80)"
  paper-2: "oklch(0.982 0.0017 80)"
  paper-3: "oklch(0.956 0.0025 80)"
  paper-5: "oklch(0.906 0.0035 80)"
  paper-6: "oklch(0.884 0.004 80)"
  paper-7: "oklch(0.85 0.0045 80)"
  paper-9: "oklch(0.55 0.005 80)"
  paper-11: "oklch(0.5 0.0045 80)"
  paper-12: "oklch(0.244 0.003 80)"
  sheet: "oklch(0.997 0.001 80)"
  desk: "oklch(0.938 0.003 80)"
  night-paper-1: "oklch(0.178 0.0013 80)"
  night-paper-12: "oklch(0.949 0.003 80)"
  night-sheet: "oklch(0.213 0.0017 80)"
  night-desk: "oklch(0.155 0.0013 80)"
  night-ink-text: "oklch(0.78 0.077 258.67)"
  night-band: "oklch(0.165 0.002 80)"
  night-band-dark: "oklch(0.118 0.0015 80)"
  lit-sheet: "oklch(0.93 0.0035 80)"
  lit-paper-5: "oklch(0.84 0.0045 80)"
  lit-paper-9: "oklch(0.5 0.005 80)"
  lit-paper-11: "oklch(0.43 0.0045 80)"
  lit-paper-12: "oklch(0.22 0.003 80)"
  lit-ink-text: "oklch(0.44 0.124 258.67)"
  lit-ink-soft: "oklch(0.89 0.03 250)"
typography:
  display:
    fontFamily: "ui-serif, \"New York\", \"Iowan Old Style\", \"Source Serif 4 Variable\", Charter, Georgia, serif"
    fontSize: "clamp(44px, 6.3vw, 96px)"
    fontWeight: 500
    lineHeight: 0.97
    letterSpacing: "-0.028em"
  headline:
    fontFamily: "ui-serif, \"New York\", \"Iowan Old Style\", \"Source Serif 4 Variable\", Charter, Georgia, serif"
    fontSize: "clamp(32px, 3.7vw, 54px)"
    fontWeight: 500
    lineHeight: 1.04
    letterSpacing: "-0.022em"
  headline-doc:
    fontFamily: "ui-serif, \"New York\", \"Iowan Old Style\", \"Source Serif 4 Variable\", Charter, Georgia, serif"
    fontSize: "clamp(34px, 4vw, 44px)"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "ui-serif, \"New York\", \"Iowan Old Style\", \"Source Serif 4 Variable\", Charter, Georgia, serif"
    fontSize: "27px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.012em"
  title-small:
    fontFamily: "ui-serif, \"New York\", \"Iowan Old Style\", \"Source Serif 4 Variable\", Charter, Georgia, serif"
    fontSize: "20px"
    fontWeight: 500
    letterSpacing: "-0.005em"
  deck:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "clamp(17px, 1.45vw, 21px)"
    fontWeight: 400
    lineHeight: 1.5
  body-landing:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "17.5px"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "16.5px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
  mono-head:
    fontFamily: "ui-monospace, \"SF Mono\", \"JetBrains Mono\", Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  hero-sheet: "3px"
  sheet: "6px"
  sheet-phone: "4px"
  chip: "5px"
  control: "7px"
  button: "10px"
  block: "10px"
  frame: "12px"
  modal: "14px"
  pill: "999px"
spacing:
  gutter-x: "clamp(16px, 4vw, 56px)"
  gutter-x-phone: "12px"
  leaf-gap: "clamp(40px, 7vw, 112px)"
  leaf-pad-y: "clamp(24px, 4vw, 64px)"
  leaf-pad-x: "clamp(22px, 5vw, 88px)"
  split-gap: "clamp(28px, 5vw, 88px)"
  facing-gap: "clamp(16px, 2vw, 28px)"
  stack-sm: "12px"
  stack-md: "20px"
  stack-lg: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.button}"
    padding: "0 20px"
    height: "46px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
    textColor: "#ffffff"
  button-quiet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.paper-12}"
    rounded: "{rounded.button}"
    padding: "0 20px"
    height: "46px"
  button-quiet-hover:
    backgroundColor: "{colors.paper-2}"
  source-chip:
    backgroundColor: "{colors.ink-soft}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.chip}"
    padding: "0 5px"
    height: "20px"
  code-inline:
    backgroundColor: "{colors.paper-3}"
    textColor: "{colors.paper-12}"
    rounded: "{rounded.chip}"
    padding: "0.1em 0.35em"
  leaf:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.paper-12}"
    rounded: "{rounded.sheet}"
    padding: "clamp(24px, 4vw, 64px) clamp(22px, 5vw, 88px) clamp(32px, 5vw, 80px)"
  leaf-lamplit:
    backgroundColor: "{colors.lit-sheet}"
    textColor: "{colors.lit-paper-12}"
    rounded: "{rounded.sheet}"
  clip-frame:
    backgroundColor: "{colors.paper-1}"
    rounded: "{rounded.frame}"
  clip-control:
    backgroundColor: "{colors.paper-1}"
    textColor: "{colors.paper-12}"
    rounded: "{rounded.pill}"
    padding: "0 12px 0 10px"
    height: "32px"
  terminal:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.paper-12}"
    rounded: "{rounded.frame}"
    padding: "18px 20px 20px"
  callout-warning:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.paper-12}"
    rounded: "{rounded.block}"
---

# Design System: Psyche Docs

## Overview

**Creative North Star: "The Notebook of Files"**

The site is the app's ink world set down on a desk. Every surface is a sheet of paper: the landing page is an open notebook with a two-page spread, then single leaves laid one after another on the desk; the doc pages are the same paper, read flat. Paper is a warm-neutral gray (hue 80, almost no chroma), text is near-black ink, and one ink blue carries every link, button and source mark. Amber appears only when something needs you.

The world is literal about what Psyche is: memory and receipts are plain files, so pages are headed by the file they are about, set in mono, and every landing section closes by citing the doc page it was drawn from with a numbered source chip, the way Psyche cites its sources. Proof is real UI, recorded on fictional fixture data and framed like a print pinned to the page; nothing is illustrated or invented.

Night is a material change, not an inversion. Doc pages go to true dark grays. The landing page keeps every sheet as lamplit paper on a dark desk, and the approvals section is one lamplit sheet on a dark night band under a single warm pool of light, in either theme.

**Key Characteristics:**
- Warm-neutral paper grays, one ink accent per view, amber reserved for "needs you".
- Display serif (New York first) for titles at weight 500 with tight negative tracking; system sans for reading; mono only for real paths, ids and commands.
- Sheets with soft, layered offset shadows and a 1px margin rule; no borders on sheets.
- Running heads are real file paths only.
- Numbered source chips close each section and link its doc page.
- Motion is scrubbed by the scroll: every section below the hero has one sequence that shows the product working (memory gathered, a claim cited, an action stopped and allowed, files kept inside the Mac). Nothing idles.

## Colors

Near-neutral paper with one saturated blue and a reserved amber; the palette is intentionally almost monochrome so the ink reads as meaning.

### Primary
- **Notebook Ink** (`ink`, the brand #2c5aa0): primary buttons, focus rings, the active sidebar tick, the outline marker, the active nav underline, `accent-color` and caret. Hover deepens to **Pressed Ink** (`ink-hover`).
- **Ink Text** (`ink-text`): links, source chips, doc-page citations. In dark doc pages it lifts to **Moonlit Ink** (`night-ink-text`) for contrast; on lamplit sheets it darkens slightly (`lit-ink-text`).
- **Ink Wash** (`ink-soft`, `ink-soft-2`): source-chip fill, selected search result, text selection, highlighted code lines.
- **Ink Rule** (`ink-line`): resting underline of links, hover border of the pager.

### Secondary
- **Needs-You Amber** (`amber`, `amber-line`, `amber-text`, `amber-soft`): warning callouts (1px inset amber ring on amber-soft), and the 2px amber ring and amber running head of the approval sheet in the hero stack. Nothing else.

### Neutral
- **Paper ramp** (`paper-1` to `paper-12`, the app's gray-1..12 at hue 80): `paper-1` page background, `paper-2` sidebar and code blocks, `paper-3` inline code and search field, `paper-5` hairlines and dividers, `paper-6`/`paper-7` borders and button outlines, `paper-9` faint marks, `paper-11` secondary text, `paper-12` primary text.
- **Sheet** (`sheet`): the brightest paper, for leaves, the notebook, pager cards and the terminal.
- **Desk** (`desk`): the surface the landing sheets lie on; the landing nav sits on it too.
- **Desk at Night** (`night-paper-1`, `night-sheet`, `night-desk`, `night-paper-12`): the doc theme's true dark grays under `.dark`.
- **Night Band** (`night-band`, deepening to `night-band-dark` in dark mode): the full-bleed band behind the approvals sheet.
- **Lamplit Paper** (`lit-sheet` and the `lit-*` overrides): the paper a sheet becomes under the lamp, a step dimmer than daylight sheet with darker secondary text so small type stays legible.

### Named Rules
**The One Ink Rule.** One accent per view, and it is ink. Ink marks what you can act on or follow (links, buttons, sources, focus); it never decorates.

**The Amber Means You Rule.** Amber appears only where the owner's decision is required. It is never a highlight, a badge color or a second accent.

**The Lamplit Paper Rule.** On the landing page, paper stays paper at night: in dark mode, and on the night band in either mode, sheets take the `lit-*` overrides instead of going dark. Doc pages are the exception; they use the true dark ramp.

## Typography

**Display Font:** ui-serif, resolving to New York on Apple systems, then Iowan Old Style, then self-hosted Source Serif 4 (variable, optical size), then Charter and Georgia.
**Body Font:** system-ui (SF Pro Text on Apple systems) with Segoe UI, Roboto and Helvetica Neue fallbacks.
**Label/Mono Font:** ui-monospace (SF Mono), JetBrains Mono, Menlo, Consolas.

**Character:** A bookish serif at a modest weight over a plain system sans: the notebook's titles are handwritten-careful, the text is the operating system's own voice. Mono is evidence, not decoration.

### Hierarchy
- **Display** (500, clamp(44px, 6.3vw, 96px), 0.97, -0.028em, max 11ch): the hero headline on the notebook's left page only.
- **Headline** (500, clamp(32px, 3.7vw, 54px), 1.04, -0.022em, max 17ch): landing leaf titles; facing-page halves step down to clamp(30px, 3vw, 44px), the closing title up to clamp(36px, 4.6vw, 66px).
- **Doc Headline** (500, clamp(34px, 4vw, 44px), 1.1, -0.02em): doc page h1.
- **Title** (500, 27px, 1.2, -0.012em): doc h2, with a 1px paper-5 rule above. Doc h3 is 20px; landing column heads 22px; the nav wordmark 21px; sidebar groups 15.5px; table row heads and index entries 18 to 19px. All in the display serif.
- **Deck** (400, clamp(17px, 1.45vw, 21px), 1.5, max 34em): the hero's two-sentence deck, in paper-11.
- **Body** (400, 16.5px, 1.7, 72ch on doc pages; 17.5px, 1.6, 36em on landing leaves): reading text, secondary copy in paper-11.
- **Label** (400 to 550, 13.5 to 15.5px): status lines, captions (14px), margin notes, button text (15.5px, 550).
- **Mono Head** (400, 12.5px): running heads, citation paths, receipt times (tabular).

### Named Rules
**The Serif Is For Titles Rule.** The display serif sets headings, the wordmark, sidebar groups and a few row labels, always at 500. Running text, buttons and captions stay in the sans.

**The Mono Is Evidence Rule.** Mono only for a real file path, id, time or command. A running head names the file the page is about (`workspace/MEMORY.md`, `audit/2026-10.jsonl`); a section with no real file has no running head.

## Layout

The landing page is a desk with a 1480px max reading width and a fluid side gutter (`gutter-x`, 12px on phones). The first viewport is an open book: two equal pages split by a 1px gutter line with a soft 80px fold gradient, pinned while the hero stack fans (desktop only, 961px+ wide and 640px+ tall; static under reduced motion). Below, leaves are laid with large vertical gaps (`leaf-gap`); inside a leaf, copy and clip sit in a 5:7 split (flipped 7:5 for receipts). Search and Home are two facing half-sheets with the second dropped up to 120px to break the grid. The close is a centered 980px column ending in a five-column docs index.

At 960px and below every split collapses to one column, the book becomes a single page and the hero stack gets a fixed height; at 560px and below the gutter drops to 12px, sheet radii tighten, the comparison table reflows to stacked rows, and buttons fill the line. Nothing scrolls horizontally.

Doc pages keep VitePress's frame at a 1400px layout max, with 72ch measure for paragraphs and lists.

## Elevation & Depth

Depth is paper on a desk: soft, layered, offset-down shadows with three stops (contact, near, far), warm-tinted in light mode and pure black at night. Sheets are borderless; the shadow is their edge. Lift is a state: a sheet arriving or a modal floating takes the lift shadow, and settles to the sheet shadow when laid.

### Shadow Vocabulary
- **Sheet** (`--shadow-sheet`): resting leaves, clip frames, the terminal, hero sheets.
- **Lift** (`--shadow-lift`): the notebook spread, the search modal, a sheet before it is laid.
- **Lamplit** (three black stops to 0.8 alpha): the approvals sheet on the night band.
- **Primary button** (two small ink-tinted stops): the only shadow on a control.

### Named Rules
**The Laid Down Rule.** Sheets are laid down by the scroll: a leaf rises 64px with a -0.7deg turn and straightens as it reaches 40% of the viewport (cubic ease on the scroll progress), and its running-head rule draws with it. Search and Home are dealt from either side. Reduced motion and no-script show every sheet flat.

## Shapes

Paper has barely rounded corners: 6px for leaves and the notebook (4px on phones), 3px for the hero's small sheets. Controls and framed objects are rounder: 10px buttons, code blocks, callouts and pager cards; 12px clip frames and the terminal; 14px for the search modal; 5px chips and inline code. The only pill is the clip's play control. Lines are 1px hairlines throughout: margin rules, running-head rules, dividers, ledger rows (dashed). The single 2px stroke is the ink focus ring.

## Components

### Buttons
Quiet and solid, never loud.
- **Shape:** gently rounded (10px), 46px tall, 20px side padding, 15.5px at weight 550, 9px icon gap.
- **Primary:** ink fill, white text, a small ink-tinted shadow. Hover deepens to pressed ink and lifts 1px; active returns flat.
- **Quiet:** sheet fill with a paper-7 hairline and paper-12 text; hover darkens the border to paper-9 and fills paper-2.
- **Small control:** the terminal's Copy button, 7px radius, paper-2 fill, paper-6 border, 13px.
- **Focus:** a 2px ink outline at 2px offset, everywhere.

### Source Chip
The site's signature citation. Each landing section ends with a link: a numbered chip (20px square minimum, 5px radius, ink-soft fill, 12px mono numeral in ink-text), the doc page's title in ink-text at 550, and the doc path in 12.5px mono. Numbers run in page order (1, 2, 3, 4). Hover underlines the title only.

### Leaves (Cards / Containers)
- **Corner Style:** 6px.
- **Background:** sheet; lamplit sheet in dark mode and on the night band.
- **Shadow Strategy:** sheet shadow at rest; see Elevation.
- **Border:** none. A 1px paper-4 margin rule runs top to bottom near the left edge.
- **Internal Padding:** `leaf-pad-y` / `leaf-pad-x`.

### Running Head
A 12.5px mono file path above a leaf's content with a full-width 1px rule below it, then generous space before the title. Only real paths.

### Demo Clip
A real recording of the app framed as a print: 12px radius, paper-6 hairline ring plus the sheet shadow, a paper-1 backdrop. Each clip has a desktop take and a separate phone-width take (served under 560px) so app text stays legible. A pill play/pause control appears on hover, on focus, when paused and always on touch. A caption follows in 14px paper-11 with a bold lead naming the place in the app.

### Navigation
VitePress nav with a 21px serif wordmark; the active link takes a 2px ink underline sitting on the nav's bottom edge. On the landing page the nav sits on the desk with no divider. Sidebar groups are serif 15.5px; the active item gets a 1px ink tick in the margin.

### Doc Content
Links are ink-text with a 1px ink-line underline that turns currentColor on hover. Tables are rule-only (no fills, no zebra), tabular numerals. Code blocks are paper sheets, not dark slabs: paper-2 with a paper-5 hairline and 10px radius. Callouts are 10px ruled notes; warnings carry the amber ring.

### Terminal
The closing install block: a sheet with a hairline ring and sheet shadow, a head row naming the requirements, a Copy control with a polite live region, and the commands in mono.

## Motion

One engine, `scroll-scenes.ts`, writes `--p` (0 → 1) on each `[data-scene]` element per animation frame (rects read first, then written). CSS derives every transform, clip-path and opacity from `--p` with `clamp()` windows (`--k: clamp(0, (p - start) / length, 1)`), so motion is scrubbed by the scroll and reversible.

- **Flow scenes** (`data-scene="flow"`) run while the element rises from the bottom of the viewport to `data-end` (default 0.4 of the viewport).
- **Pin scenes** (`data-scene="pin"`) are tall tracks with a sticky stage, pinned only at 961px+ wide and 760px+ tall: memory 260vh, brief 210vh, approvals 300vh. Elsewhere they run over their own height.
- **Default `--p: 1`** is the finished state, so no script and `prefers-reduced-motion` show every scene complete, unpinned.
- **Sequences:** memory scraps travel into MEMORY.md lines with source chips; the brief inks in word by word (word opacity 0.16 → 1) and each claim's numbered chip snaps on with a 1px ink underline; the night band darkens from the desk and the lamp gradient grows; the approval gate runs, stops on an amber line, presses Allow once, folds the card and prints the receipt; receipts print along a dashed hash chain; the "This Mac" edges draw clockwise as rows file in; status checks pop in turn; install lines type by whole characters (`round()` on `ch`).
- **Budget:** only transform, opacity and clip-path change per frame. Demo clips play one at a time and hold still while the page scrolls (resume 180ms after it rests), which keeps scrolling at 60fps. Illustrations are labelled as illustrations with fictional data.

## Do's and Don'ts

### Do:
- **Do** use ink for every actionable or cited thing and nothing else; one accent per view.
- **Do** keep landing sheets as lamplit paper in dark mode, and put doc pages on the true dark ramp.
- **Do** head a sheet with the real file it is about, in mono, or leave it without a head.
- **Do** close each landing section with a numbered source chip linking its doc page.
- **Do** show the product with real recordings on fictional fixture data, with a phone-width take for each clip.
- **Do** set titles in the display serif at 500 with negative tracking; body in the system sans.
- **Do** give small metadata text at least 4.5:1 against its sheet; the lamplit overrides already darken paper-9 to `lit-paper-9` for this.
- **Do** give every motion a static fallback under `prefers-reduced-motion` and a no-WebGL HTML stack for the hero.

### Don't:
- **Don't** use amber for anything but "needs you".
- **Don't** put topic labels or eyebrows above titles; running heads are file paths only.
- **Don't** turn code blocks into dark slabs or give sheets borders; paper is edged by its shadow.
- **Don't** use mono for prose, labels or decoration.
- **Don't** invert the landing sheets to dark paper at night.
- **Don't** use sparkles or other AI glyphs, testimonials, counts or illustrated proof.
- **Don't** let anything idle or loop for attention; the clips are the only things that play.
