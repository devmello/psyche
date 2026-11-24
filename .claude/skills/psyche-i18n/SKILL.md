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

## Platform variants (Mac, Touch ID)

An English string that names "Mac", "Touch ID" or "Finder" needs a Linux and a Windows variant in `packages/ui/src/i18n/messages/variants/*.ts`, in all 10 languages. Then run `packages/ui/test/platform-linux.test.tsx` and `platform-windows.test.tsx` by hand: `--related` does not pick them up for message files (`verify.sh` runs them when messages change). #1338 broke main this way.

## iOS

- Strings live in `apps/ios/**/Localizable.xcstrings`, and `CFBundleLocalizations` lists the languages. Add every new key with all 10 translations.
- Use `String(localized:)` and `Text("key")`, as the existing code does. In Swift package targets pass `bundle: .module` (`Text("key", bundle: .module)`, `String(localized: "key", bundle: .module)`), or the string shows English everywhere. `LocalizedLiteralsTests` enforces it. Each module (PsycheFeatures, PsycheBlocks, PsycheDesign, PsycheShared) has its own catalog: add the key to the module's own.
- `verify.sh` runs `.claude/scripts/xcstrings-coverage.py` on each touched catalog: every key with any translation needs all 11 locales (en + 10, **including zh-Hans**). #1542 shipped 10 keys without zh-Hans; `i18n:check` never reads xcstrings. Run it yourself before the PR: `python3 -I .claude/scripts/xcstrings-coverage.py <catalog>`.
- Parallel iOS PRs always conflict in `apps/ios/Sources/PsycheFeatures/Resources/Localizable.xcstrings`. Resolve with a JSON union of `strings`, keeping main's key order and format (`json.dumps(indent=2, ensure_ascii=False)`, no sorting), and merge `origin/main` right before you report. On a conflict take the three-way union of git stages 1, 2 and 3 (`git show :1:<file>` base, `:2:` ours, `:3:` theirs: apply each side's adds and removes onto the base), then run `xcstrings-coverage.py` and one build (#1624/#1625, #1616).

- **Never localize wire keys, and read scripted replaces line by line (#1618).** A sweep that wrapped literals in `String(localized:)` also wrapped the JSON key `"path"` in 5 lookups (`item[String(localized: "path", bundle: .module)]`): on a non-English phone Library open, `memory.read` and Space folders would have broken. Only text a person reads is localized: not dictionary keys, method names, enum raw values or ids. After any scripted replace, read the whole diff, including `//` comment lines. `ClientLocalizationTests.noLocalizedWireKeys` guards it. An interpolated key in the catalog is the generated form (`%@`, `%lld`), not the source text.

## Notices the Gateway authors

A notification the Gateway writes (`notifier.notify`, security alerts) keeps its English `title` and `body` as the fallback and adds `message: { titleKey, bodyKey, params }`. Add the two ids and their ICU text to `packages/ui/src/i18n/messages/notices.ts` (ids `notice.<area>.<name>.title|body`) and to all 10 `locales/notices/<lang>.ts` files. Pass only strings and numbers as `params`; use `select` params with fixed words (`"yes"`, `"none"`, an enum) for variants and never concatenate. The notifier strips control, format and bidirectional characters from every value, so a device name is safe to pass, but clamp it yourself if it must be short. Desktop and web render it through `noticeText()` (inbox); old clients and unknown ids show the English text. OS and channel text is still the English fallback, and iOS does not read `message` yet.

## Learnings

- 2026-11-18: Gateway-sent text counts too: notifications, notices and channel messages. #1327 and #1333 shipped English-only notices. Find how neighbouring notices are localised and do the same in all 10 languages.
