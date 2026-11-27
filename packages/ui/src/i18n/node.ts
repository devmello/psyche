/**
 * The message formatter without React, for processes that are not a renderer (the desktop's main
 * process shows a few native dialogs). `import("@psyche/ui/i18n-core")` loads it on demand, and
 * `createLoadedI18n` loads only the one language it is asked for.
 */
export { createI18n, createLoadedI18n, type I18n } from "./core.ts";
export { en, type MessageId } from "./messages/index.ts";
