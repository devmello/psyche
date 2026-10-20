import { common } from "./common.ts";
import { context } from "./context.ts";
import { errors } from "./errors.ts";
import { settingsLanguage } from "./settings-language.ts";
import { time } from "./time.ts";

/**
 * The English catalogue: every user-facing string in the kit and the web app, by stable id
 * (`<group>.<area>.<name>`), as ICU MessageFormat. Each group lives in its own file; ids never
 * change meaning: reword freely, but a string that means something new gets a new id.
 * docs/guides/translating.md explains the rules and how to add a language.
 */
export const en = {
  ...common,
  ...time,
  ...errors,
  ...context,
  ...settingsLanguage,
} as const;

export type MessageId = keyof typeof en;
export type Catalogue = Readonly<Record<MessageId, string>>;
