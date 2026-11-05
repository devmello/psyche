import { agent } from "./agent.ts";
import { agentNotes } from "./agent-notes.ts";
import { audit } from "./audit.ts";
import { automationChat } from "./automation-chat.ts";
import { blocks } from "./blocks.ts";
import { canvas } from "./canvas.ts";
import { capabilities } from "./capabilities.ts";
import { charts } from "./charts.ts";
import { chat } from "./chat.ts";
import { common } from "./common.ts";
import { connectorBundles } from "./connector-bundles.ts";
import { connectorGallery } from "./connector-gallery.ts";
import { connectorsPage } from "./connectors-page.ts";
import { context } from "./context.ts";
import { daily } from "./daily.ts";
import { design } from "./design.ts";
import { deviceAccess } from "./device-access.ts";
import { errors } from "./errors.ts";
import { glass } from "./glass.ts";
import { home } from "./home.ts";
import { links } from "./links.ts";
import { mailMeetings } from "./mail-meetings.ts";
import { meetingRecord } from "./meeting-record.ts";
import { memoryPage } from "./memory-page.ts";
import { memoryReview } from "./memory-review.ts";
import { memorySettings } from "./memory-settings.ts";
import { nudges } from "./nudges.ts";
import { onboarding } from "./onboarding.ts";
import { overview } from "./overview.ts";
import { overviewGrowth } from "./overview-growth.ts";
import { people } from "./people.ts";
import { research } from "./research.ts";
import { scheduled } from "./scheduled.ts";
import { screenAsk } from "./screen-ask.ts";
import { screens } from "./screens.ts";
import { securityState } from "./security-state.ts";
import { selfConnectors } from "./self-connectors.ts";
import { settings } from "./settings.ts";
import { settingsLanguage } from "./settings-language.ts";
import { settingsSections } from "./settings-sections.ts";
import { shell } from "./shell.ts";
import { skillAuthor } from "./skill-author.ts";
import { specialists } from "./specialists.ts";
import { teach } from "./teach.ts";
import { time } from "./time.ts";
import { voice } from "./voice.ts";
import { web } from "./web.ts";
import { whatCanYouDo } from "./what-can-you-do.ts";
import { widgets } from "./widgets.ts";
import { work } from "./work.ts";
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
  ...daily,
  ...nudges,
  ...shell,
  ...settings,
  ...settingsLanguage,
  ...settingsSections,
  ...skillAuthor,
  ...selfConnectors,
  ...connectorBundles,
  ...deviceAccess,
  ...mailMeetings,
  ...connectorGallery,
  ...connectorsPage,
  ...onboarding,
  ...whatCanYouDo,
  ...memoryReview,
  ...memoryPage,
  ...memorySettings,
  ...people,
  ...work,
  ...specialists,
  ...screens,
  ...web,
  ...teach,
  ...glass,
  ...design,
  ...voice,
  ...screenAsk,
  ...meetingRecord,
  ...workflows,
  ...overview,
  ...home,
  ...overviewGrowth,
  ...capabilities,
  ...research,
  ...scheduled,
  ...automationChat,
  ...widgets,
  ...securityState,
} as const;

export type MessageId = keyof typeof en;
export type Catalogue = Readonly<Record<MessageId, string>>;
