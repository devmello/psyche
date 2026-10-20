export {
  activeI18n,
  createI18n,
  type I18n,
  type I18nOptions,
  isMessageId,
  type MessageValues,
  setActiveI18n,
  t,
} from "./core.ts";
export { describeError, errorCode, errorSummary } from "./errors.ts";
export { I18nProvider, type I18nProviderProps, useI18n } from "./I18nProvider.tsx";
export {
  canonicalLocale,
  DIRECTION_SETTING,
  type Direction,
  type DirectionSetting,
  directionOf,
  LOCALE_SETTING,
  localeName,
  MESSAGE_LOCALES,
  messageLocaleFor,
  OFFERED_LOCALES,
  resolveDirection,
  resolveLocale,
  runtimeLocale,
} from "./locale.ts";
export { type Catalogue, en, type MessageId } from "./messages/index.ts";
