# Translating Psyche

This guide is for contributors. It explains how text in the desktop app and the web UI is organised, the rules every UI change follows, and how to add a language.

Psyche's text ships in the languages listed in the catalogue registry (`packages/ui/src/i18n/messages/locales/index.ts`), English first. Everything a translation needs is in place: a message catalogue, a check that fails on text written straight into the UI and reports each language's coverage, locale-aware formatting, and a layout that works right to left.

## For people running Psyche

Onboarding's first step starts with a **Language** menu, and Settings → Appearance → **Language and region** has three controls:

- **Language**: the language of Psyche's text (`ui.language`). It starts on **Match system**, which picks the catalogue for your region format's language and falls back to English. The menu lists each shipped language by its own name ("Deutsch", "日本語"). A change applies at once. A string a language has not translated yet shows in English.
- **Region format**: how dates, times and numbers are written. It starts on **System**, which follows the region in macOS System Settings → General → Language & Region (on the web, the browser's language). Pick another region to override it. The example line under the menu shows the result.
- **Text direction**: **Automatic** follows the language, which is left to right while the text is English. **Right to left** mirrors the layout. It is meant for checking a translation.

Language and region are separate: English text with a German region writes dates the German way, and so on.

## Where the text lives

All user-facing text in `packages/ui` (the UI kit and its screens) and `apps/web` (the shell) lives in one message catalogue, `packages/ui/src/i18n/messages/`.

- **One file per screen group.** For example, `context.ts` holds the chat's context meter and compaction markers, and `errors.ts` holds the Gateway errors. `index.ts` combines them into `en`.
- **Ids are stable and dotted:** `<group>.<area>.<name>`, such as `context.meter.compactNow` or `settings.language.region`. Reword a string freely. If a string comes to mean something different, give it a new id, so a translation can never say something the English no longer says.
- **Messages are ICU MessageFormat**, formatted by [`intl-messageformat`](https://formatjs.github.io/docs/intl-messageformat/) (pinned in `packages/ui/package.json`):
  - `{name}`: a value.
  - `{n, number}`: a number in the region format.
  - `{n, plural, one {# day} other {# days}}`: plurals. Never build them from two strings.
  - `{tone, select, near {…} over {…} other {}}`: variants.
  - Apostrophes are literal (`Can't`). Write `'{'` for a literal brace.
- **No Markdown and no HTML in messages.** Where a sentence needs a link or bold text, split it at the markup and keep each piece a whole phrase.

## Using a message in code

```tsx
import { t } from "../../i18n/core.ts";

<Button>{t("context.meter.compactNow")}</Button>
<p>{t("context.limits.errorRange", { min: 20, max: 95 })}</p>
```

- **`t(id, values)` works in components and in plain helpers**, such as label records or toast text. Ids are typed, so a missing id fails `tsc`.
- **Ids built from data** use a template whose prefix exists: ``t(`context.breakdown.${key}`)``, where `key` is a union of known keys.
- **Formatting goes through the active i18n.** `activeI18n()` has `number`, `percent`, `date`, `time`, `dateTime` and `list`, all in the region format. The helpers in `lib/format.ts` (`formatRelative`, `formatDuration`, `formatTime`, `formatDate`) already do this. Don't call `toLocaleString()` without a locale.
- **Gateway errors:** show `describeError(err)` from `i18n/errors.ts`, not `err.message`.
  - The Gateway writes its messages in English, often with the exact cause. While the text is English, `describeError` shows that message.
  - In any other language it shows the catalogue sentence for the error's code (`errors.<code>`). Errors without a code show `errors.unknown`.
- **Remounting:** `I18nProvider`, inside `AppearanceProvider`, sets `lang` and `dir` on `<html>`. It remounts the app when the language, region or direction changes, so nothing keeps stale text.

## The check

```bash
pnpm i18n:check
```

`scripts/i18n-check.ts` runs in CI after lint. It fails when:

- **Text is hard-coded** in `.ts` and `.tsx` files under `packages/ui/src` and `apps/web/src`:
  - letters in JSX text;
  - user-facing attributes (`aria-label`, `title`, `placeholder`, `alt`, `label`, `description`, `did` and similar);
  - string expressions rendered as children (`{busy ? "Saving…" : "Save"}`);
  - `toast()` messages;
  - user-facing keys in object literals: `label`, `text`, `hint`, `description`, `title`, `placeholder`, `term`, `empty`, `detail` and `did`. These cover option lists, `action={{ label }}`, notices and label records.
- **An id is missing:** a `t("…")` id isn't in the English catalogue, or no id starts with the prefix of a template id.
- **A translation is wrong:** a catalogue in `messages/locales/` has an id that `en` doesn't, or a message that isn't valid ICU MessageFormat.

It also prints each language's coverage (`de: 2790/2840 ids translated (warning: 50 fall back to English)`). Missing ids are a warning, not a failure: they fall back to English one by one.

These are exempt:
- text inside `<code>`, `<kbd>`, `<pre>` and `<samp>`;
- class-name-like values in object literals (`"text-muted-foreground"`);
- stories, fixtures, tests, `mock-*` files and `sample-data` files.

For anything else that must stay as written, such as a product name or a protocol keyword, put `i18n-ignore` and the reason in a comment on that line or the line above. For a block of such values, use `i18n-ignore-start: <reason>` and `i18n-ignore-end`. The provider and model names in onboarding use this.

The kit and the web app have no hard-coded text left, so `scripts/i18n-baseline.json` is empty: every file must stay at zero. The baseline mechanism remains for future checks that need one:
- `pnpm i18n:check --update` locks in lower counts and refuses higher ones;
- `--verbose` lists every remaining string.

A label record in a `.ts` file (a `Record<Key, string>` of display names) keeps its exported name with getters that call `t()`:

```ts
export const MODE_LABEL: Record<PermissionMode, string> = {
  get manual() {
    return t("agent.mode.manual");
  },
  // …
};
```

## Right to left

Layouts use logical directions, so they mirror under `dir="rtl"`:

- `ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`, `text-end`, `border-s` and `border-e`, not `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `border-l` and `border-r`;
- `rtl:rotate-180` on chevrons and arrows that point along the reading direction.

Physical directions remain only where the meaning is physical, such as a macOS traffic-light inset or a drag handle on a fixed edge. To check a screen, set Text direction to Right to left.

## Adding a language

1. Create `packages/ui/src/i18n/messages/locales/<lang>.ts`, named by the language subtag (`es`, `pt`, `zh`):

   ```ts
   import type { Catalogue } from "../index.ts";

   export const es: Partial<Catalogue> = {
     "common.on": "Activado",
     // …the same ids as `en`
   };
   ```

   Ids you leave out fall back to English, one by one.
2. Register it in `messages/locales/index.ts`: import it and add it to `REGISTRY` after `en`. `MESSAGE_LOCALES`, the onboarding and Settings menus, and the check pick it up from there. Add its native name to `NATIVE_NAMES` in `i18n/locale.ts` if the runtime might not know it.
3. Keep every `{placeholder}` and every plural or select branch. A plural needs the forms your language uses (`zero`, `one`, `two`, `few`, `many`, `other`).
4. Run `pnpm i18n:check` (unknown ids and invalid messages fail; it prints your coverage) and `pnpm --filter @psyche/ui exec vitest run test/i18n.test.tsx`.
5. Pick the language in Settings → Appearance → Language and region and check the app. For a right-to-left language, the layout flips on its own; Text direction should stay on Automatic.

The desktop's packaging keeps only English in Electron's own resources (`apps/desktop/src/packaging/locales.ts`). Electron's built-in strings, such as the text field context menu, stay English until a language is added there too. The app's region format doesn't depend on that list: it comes from `app.getSystemLocale()`.
