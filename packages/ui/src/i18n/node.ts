/**
 * The message formatter without React, for processes that are not a renderer (the desktop's main
 * process shows a few native dialogs). `import("@psyche/ui/i18n-core")` loads it on demand.
 */
export { createI18n, type I18n } from "./core.ts";
export { en, type MessageId } from "./messages/index.ts";
