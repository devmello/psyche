import { agent } from "./agent.ts";
import { agentNotes } from "./agent-notes.ts";
import { audit } from "./audit.ts";
import { blocks } from "./blocks.ts";
import { canvas } from "./canvas.ts";
import { capabilities } from "./capabilities.ts";
import { charts } from "./charts.ts";
import { chat } from "./chat.ts";
import { common } from "./common.ts";
import { connectorGallery } from "./connector-gallery.ts";
import { context } from "./context.ts";
import { design } from "./design.ts";
import { errors } from "./errors.ts";
import { glass } from "./glass.ts";
import { links } from "./links.ts";
import { mailMeetings } from "./mail-meetings.ts";
import { meetingRecord } from "./meeting-record.ts";
import { onboarding } from "./onboarding.ts";
import { overview } from "./overview.ts";
import { overviewGrowth } from "./overview-growth.ts";
import { people } from "./people.ts";
import { screenAsk } from "./screen-ask.ts";
import { screens } from "./screens.ts";
import { selfConnectors } from "./self-connectors.ts";
import { settings } from "./settings.ts";
import { settingsLanguage } from "./settings-language.ts";
import { shell } from "./shell.ts";
import { skillAuthor } from "./skill-author.ts";
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
  ...links,
  ...time,
  ...errors,
  ...chat,
  ...blocks,
  ...canvas,
  ...charts,
  ...context,
  ...agent,
  ...agentNotes,
  ...audit,
  ...shell,
  ...settings,
  ...settingsLanguage,
  ...skillAuthor,
  ...selfConnectors,
  ...mailMeetings,
  ...connectorGallery,
  ...onboarding,
  ...capabilities,
  ...people,
  ...specialists,
  ...screens,
  ...web,
  ...glass,
  ...design,
  ...voice,
  ...screenAsk,
  ...meetingRecord,
  ...workflows,
  ...overview,
  ...overviewGrowth,
} as const;

export type MessageId = keyof typeof en;
export type Catalogue = Readonly<Record<MessageId, string>>;
