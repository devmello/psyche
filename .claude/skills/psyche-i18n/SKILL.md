---
name: psyche-i18n
description: Adding or changing user-visible strings in Psyche across all 10 languages, on desktop, web and shared UI (packages/ui i18n messages) and on iOS (Localizable.xcstrings). Use whenever a change adds, renames or rewords any text a user can see, including errors and accessibility labels.
---

# Strings in all 10 languages

Every user-visible string ships in all 10 languages in the same PR. `pnpm i18n:check` enforces this for TypeScript.

## Desktop, web and shared UI

- English source messages are in `packages/ui/src/i18n/messages/<area>.ts` (e.g. `settings.ts`, `blocks.ts`, `chat.ts`). Keys are dotted: `<area>.<section>.<name>`.
- Translations live in `packages/ui/src/i18n/messages/locales/<area>[-suffix]/<lang>.ts`. One area's keys can be split across several folders per language: for example `blocks.approval.rateLimited` is in `locales/blocks/ar.ts` but in `locales/blocks-rest/de.ts` and `locales/blocks-a/es.ts`. To find where a neighbouring key lives in each language, run `grep -rln '"<a nearby key>"' packages/ui/src/i18n/messages/locales`, then add your key next to it in each of those files.
- Use the `t("key", { vars })` helper with ICU syntax for plurals and selects, as the neighbouring strings do. Never concatenate translated fragments.
- Translate for meaning, keep it short, and match the tone of the strings around it. Keep placeholders (`{seconds}`, `{name}`) unchanged.
- Run `pnpm i18n:check` and make sure it passes. It reports missing keys and placeholder mismatches per language.
- Errors that reach the owner should say what happened and what to do, not "isn't available".

## iOS

- Strings live in `apps/ios/**/Localizable.xcstrings`, and `CFBundleLocalizations` lists the languages. Add every new key with all 10 translations.
- Use `String(localized:)` and `Text("key")`, as the existing code does.

## Learnings

(The `reflect` skill adds dated lines here.)
