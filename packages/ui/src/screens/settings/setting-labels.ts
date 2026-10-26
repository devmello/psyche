import { VM_SETTING_KEYS } from "@psyche/protocol";
import { t } from "../../i18n/core.ts";

/**
 * Plain labels for setting keys (docs/ui-audit.md: a raw key never shows at level 1). Keys are
 * free-form strings in the protocol (`settings.get` / `settings.set`), so this list is the one
 * place their words are looked up; the words themselves live in the catalogue as
 * `settings.key.<key>`. `test/setting-labels.test.ts` fails when a key the kit reads or writes
 * has no label here. Labels match the field label the Settings screen shows for the key.
 */
const LABELLED_KEYS = [
  "appearance.theme",
  "appearance.gray",
  "appearance.accentSeed",
  "appearance.reduceMotion",
  "appearance.contrast",
  "appearance.zoom",
  "appearance.reduceTransparency",
  "appearance.glass",
  "appearance.glassTint",
  "appearance.glassBlur",
  "appearance.glassRefraction",
  "backup.schedule",
  "browser.realChrome",
  "browser.botAuth",
  "computerUse.enabled",
  "computerUse.apps",
  "context.maxTokens",
  "context.compactAt",
  "context.keepRecentTurns",
  "data.transcriptRecall",
  "data.replayRetentionDays",
  "gateway.bind",
  "models.primary",
  "models.utility",
  "models.image",
  "models.providers",
  "permissions.mode",
  "permissions.policy",
  "permissions.folders",
  "persona.name",
  "persona.tagline",
  "persona.emoji",
  "persona.creature",
  "persona.creatureId",
  "search.web.provider",
  "search.web.searxngUrl",
  "vault.backend",
  "vault.fillDefault",
  VM_SETTING_KEYS.enabled,
  VM_SETTING_KEYS.guestNodeId,
  VM_SETTING_KEYS.defaultWorkspace,
  VM_SETTING_KEYS.clipboard,
  VM_SETTING_KEYS.credentials,
  // L6 (#452): a fresh sandbox Mac for every task; the VM section adds its switch.
  VM_SETTING_KEYS.resetPerTask,
  "vm.shares",
  "voice.pushToTalk",
  "voice.mode",
  "voice.systemWide",
  "voice.hotkey",
  "voice.engine",
  "voice.conversation.enabled",
  "voice.conversation.start",
  "voice.conversation.reply",
  "voice.conversation.bargeIn",
  "ui.onboarding.completedAt",
  "ui.transcriptMode",
] as const;

type LabelledKey = (typeof LABELLED_KEYS)[number];

/** The label for a labelled key, in the active language. */
const labelOf = (key: LabelledKey): string => t(`settings.key.${key}`);

/** Every labelled key and its label, read in the active language on each access. */
export const SETTING_LABELS: Readonly<Record<string, string>> = Object.defineProperties(
  {},
  Object.fromEntries(
    LABELLED_KEYS.map((key) => [key, { enumerable: true, get: () => labelOf(key) }]),
  ),
);

/** Families of keys with an id at the end. */
const PREFIX_LABELS: readonly [prefix: string, label: (rest: string) => string][] = [
  [
    "permissions.connectors.",
    (id) => t("settings.key.permissions.connectors", { id: id.replace(/^conn_/, "") }),
  ],
  ["models.roles.", (role) => t("settings.key.models.roles", { role })],
];

const isLabelled = (key: string): key is LabelledKey =>
  (LABELLED_KEYS as readonly string[]).includes(key);

/** The label for a key; never the raw key (an unknown key reads "this setting"). */
export function settingLabel(key: string): string {
  if (isLabelled(key)) return labelOf(key);
  for (const [prefix, label] of PREFIX_LABELS) {
    if (key.startsWith(prefix) && key.length > prefix.length)
      return label(key.slice(prefix.length));
  }
  return t("settings.key.unknown");
}
