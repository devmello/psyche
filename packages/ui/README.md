# @psyche/ui

**Owner:** S12 (`prompts/s12-*.md`). Feature ids: E4, E8, F3, C4 UI, O6/O8/O9, P7, S1 UI, R2, R3, U1 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

React components: message blocks, cards, screens, theme.

## Status

Placeholder created by S00 (bootstrap). The only exports are two tiny components used by the
hello windows in `apps/desktop` and `apps/web`:

- `PsycheMark({ size?, withWordmark? })`: an inline-SVG glyph plus the "Psyche" word mark.
- `StatusPill({ tone: "ok" | "warn" | "error" | "neutral", label, title? })`: a coloured status chip.

They use inline styles only (no CSS framework, no theme yet). S12 replaces them with the real kit
(docs/06-ui-design.md); keep the names or update both apps in the same PR. The entry point is
`src/index.tsx` (`tsconfig.json` uses `jsx: react-jsx` and the DOM lib).

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
