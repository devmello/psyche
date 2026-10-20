---
"@psyche/ui": minor
"@psyche/web": minor
"@psyche/desktop": minor
---

Localization groundwork (A12):
- an ICU message catalogue with `t()`, `I18nProvider` and `describeError` for Gateway errors;
- locale-aware formatting from the macOS region format, with Settings → Appearance → Language and region (`ui.locale`, `ui.direction`);
- `pnpm i18n:check` against hard-coded UI text and missing ids, with a shrink-only baseline;
- the chat's context UI extracted and right-to-left safe.
