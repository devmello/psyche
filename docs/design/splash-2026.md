# Startup splash, 2026-11

The screen the main window shows while the Gateway starts (`StartupSplashView`, wired by
`apps/web/.../StartupSplash.tsx`). Direction: the ink pass's desk-lamp-at-night world. A moth is
drawn in one ink line on paper; it wakes as Psyche does. No glow, no idle breathing, one accent
use (the moth's stroke; in the error state the stroke goes graphite and Try again is the accent).

## Sequence

All durations are motion tokens (`packages/ui/src/motion/tokens.ts`); nothing here is a literal.

| When | What | Token |
|---|---|---|
| 0 to 300 ms | Paper only. A start that pairs inside this never shows the body. | `splashDelay` |
| 300 ms | Body fades in; the moth starts drawing: body, antennae, fore wings, hind wings, veins, 90 ms apart, each stroke 560 ms (`ease.enter`). | `splashStroke`, `splashDraw` |
| ~720 ms | "Psyche" is written left to right in the serif (`--font-display`, weight 500), 320 ms. | `long` |
| ~620 ms | Status line and the three ruled marks fade in. | `medium` |
| as the start moves | Wings open: 0.40, 0.62, 0.82 and 1.0 of full width at setting up, waking, connecting and ready (`spring.gentle`). The marks fill one by one; the step in progress is half filled. The status line rewrites itself with a 4 px rise when the text changes. Steps never go back. | `gentle`, `long` |
| slow (8 s) | A quiet line says it is taking longer; "Open Psyche anyway" fades in. | `long` |
| failed | Wings fold to 0.40 and the moth goes graphite; the marks go away. The reason sits on a selectable paper chit, then Show logs and Try again. | `medium` |
| paired | Copy fades (`short` exit). The moth flies to the toolbar avatar (`spring.smooth`) and fades in its last 150 ms while the paper fades under it over 320 ms. The splash unmounts at 320 ms. | `long`, `short` |

Reduced motion: the same drawing with no draw, no wing movement and no flight; the 300 ms flash
guard stays, the hand-off is one 150 ms opacity crossfade (it used to be a hard cut).

## Cost

CSS plus SVG (nine paths), no images, no new dependencies, nothing loops. After the draw only
`opacity` and `transform` change. The lantern motion tokens (`duration.lantern*`), unused since the
owner rejected the lantern glow, are removed.
