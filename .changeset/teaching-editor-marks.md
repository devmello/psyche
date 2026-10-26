---
"@psyche/viewers": minor
"@psyche/ui": minor
---

Teaching loop (#680): margin marks in the Markdown editor. `MarkdownEditor` takes `marks` (a line's text and a tooltip) and `onMarkActivate`, and draws a dot in a gutter beside each matching line; the gutter only exists while there are marks. The editor slot passes them through: Soul & Memory gives every lesson-owned line a mark, and activating one opens that lesson in the "Learned from you" list. The gutter is aria-hidden, so its dots are a pointer-only cue and the list stays the keyboard and VoiceOver path.
