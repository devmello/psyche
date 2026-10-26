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
  "agent.showReasoning",
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
  "teaching.enabled",
  "teaching.implicit",
  "teaching.paused",
  "teaching.weeklyCard",
  "data.replayRetentionDays",
  "data.reasoningRetentionDays",
  "memory.graph",
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
  "specialists.maxConcurrent",
  "specialists.monthlyCapUsd",
  "specialists.showInFeed",
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
  "screenAsk.enabled",
  "screenAsk.shortcut",
  "screenAsk.destination",
  "screenAsk.alwaysImage",
  "voice.engine",
  "voice.conversation.enabled",
  "voice.conversation.key",
  "voice.conversation.reviewBeforeSend",
  // Mail & meetings (docs/workflows/mail-and-meetings-2026.md §7.3)
  "workflows.paused",
  "workflows.readOnly",
  "mail.digest.enabled",
  "mail.digest.time",
  "mail.digest.days",
  "mail.digest.onlyWhenNeeded",
  "mail.followups.enabled",
  "mail.followups.waitDays",
  "mail.followups.showTwice",
  "mail.voice.enabled",
  "mail.draft.localModel",
  "mail.schedule.hoursStart",
  "mail.schedule.hoursEnd",
  "mail.schedule.bufferMin",
  "mail.schedule.focusTime",
  "mail.schedulingLink",
  "mail.poll.activeMin",
  "mail.poll.idleMin",
  "meetings.prep.enabled",
  "meetings.prep.scope",
  "meetings.prep.leadMin",
  "meetings.prep.notifyMin",
  "meetings.prep.saveToNotes",
  "meetings.prep.dailyCap",
  "meetings.notes.enabled",
  "meetings.notes.folder",
  "meetings.notes.tasksApp",
  "meetings.notes.recapDraft",
  "meetings.notes.consentLine",
  "meetings.notes.cloudSummary",
  "ui.onboarding.completedAt",
  "ui.transcriptMode",
  "ui.language",
  "ui.locale",
  "ui.direction",
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
  ["mail.accounts.", (account) => t("settings.key.mail.accounts", { account })],
  ["models.roles.", (role) => t("settings.key.models.roles", { role })],
  ["specialists.enabled.", (role) => t("settings.key.specialists.enabled", { role })],
  ["specialists.model.", (role) => t("settings.key.specialists.model", { role })],
  ["specialists.budget.", (role) => t("settings.key.specialists.budget", { role })],
  ["specialists.maxMode.", (role) => t("settings.key.specialists.maxMode", { role })],
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
