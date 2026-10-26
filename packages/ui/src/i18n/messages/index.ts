import { agent } from "./agent.ts";
import { blocks } from "./blocks.ts";
import { chat } from "./chat.ts";
import { common } from "./common.ts";
import { context } from "./context.ts";
import { design } from "./design.ts";
import { errors } from "./errors.ts";
import { glass } from "./glass.ts";
import { onboarding } from "./onboarding.ts";
import { people } from "./people.ts";
import { screens } from "./screens.ts";
import { settings } from "./settings.ts";
import { settingsLanguage } from "./settings-language.ts";
import { shell } from "./shell.ts";
import { specialists } from "./specialists.ts";
import { time } from "./time.ts";
import { voice } from "./voice.ts";
import { web } from "./web.ts";
import { workflows } from "./workflows.ts";

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
  ...chat,
  ...blocks,
  ...context,
  ...agent,
  ...shell,
  ...settings,
  ...settingsLanguage,
  ...onboarding,
  ...people,
  ...specialists,
  ...screens,
  ...web,
  ...glass,
  ...design,
  ...voice,
  ...workflows,
} as const;

export type MessageId = keyof typeof en;
export type Catalogue = Readonly<Record<MessageId, string>>;
