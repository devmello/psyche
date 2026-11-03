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
  "capabilities.onlineSearch",
  "tools.loading",
  "appearance.theme",
  "appearance.gray",
  "appearance.accentSeed",
  "appearance.reduceMotion",
  "appearance.contrast",
  "appearance.zoom",
  "appearance.showInDock",
  "appearance.openAtLogin",
  "appearance.glass",
  "appearance.glassTint",
  "appearance.glassBlur",
  "appearance.glassRefraction",
  "browser.realChrome",
  "browser.botAuth",
  "browser.useSignedInSessions",
  "daily.brief.enabled",
  "daily.brief.time",
  "daily.wrapup.enabled",
  "daily.wrapup.time",
  "daily.notify",
  "daily.messages",
  "daily.followups.enabled",
  "daily.followups.sensitivity",
  "nudges.enabled",
  "nudges.consentedAt",
  "nudges.sensitivity",
  "nudges.phrasing",
  "computerUse.enabled",
  "computerUse.apps",
  "context.maxTokens",
  "exec.srtPath",
  "context.compactAt",
  "context.keepRecentTurns",
  "teaching.enabled",
  "teaching.implicit",
  "teaching.paused",
  "teaching.weeklyCard",
  "data.replayRetentionDays",
  "data.reasoningRetentionDays",
  "memory.graph",
  "memory.everything",
  "memory.work",
  "memory.work.enabled",
  "memory.work.trackedLists",
  "memory.work.anchorsFromFolders",
  "memory.work.remind.enabled",
  "memory.work.remind.dueSoonHours",
  "memory.work.remind.dayOf",
  "memory.surfaces",
  "memory.surfaces.tiers.work.home",
  "memory.surfaces.tiers.work.brief",
  "memory.surfaces.tiers.work.notification",
  "memory.surfaces.tiers.work.channel",
  "memory.surfaces.tiers.workMail.home",
  "memory.surfaces.tiers.workMail.brief",
  "memory.surfaces.tiers.workMail.notification",
  "memory.surfaces.tiers.workMail.channel",
  "memory.surfaces.tiers.people.home",
  "memory.surfaces.tiers.people.brief",
  "memory.surfaces.tiers.people.notification",
  "memory.surfaces.tiers.people.channel",
  "memory.surfaces.birthdays",
  "memory.surfaces.hideSources",
  "memory.surfaces.kinds.project",
  "memory.surfaces.kinds.course",
  "memory.surfaces.kinds.assignment",
  "memory.surfaces.kinds.event",
  "memory.recall.mode",
  "gateway.bind",
  "models.primary",
  "models.utility",
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
  "search.model.engine",
  "search.semantic.enabled",
  "search.semantic.engine",
  "search.semantic.allowCloud",
  "search.cards.enabled",
  "search.encrypt",
  "search.rerank.enabled",
  "search.queryModel.enabled",
  "specialists.maxConcurrent",
  "specialists.monthlyCapUsd",
  "specialists.showInFeed",
  "search.web.searxngUrl",
  VM_SETTING_KEYS.enabled,
  VM_SETTING_KEYS.guestNodeId,
  VM_SETTING_KEYS.defaultWorkspace,
  // L6 (#452): a fresh sandbox Mac for every task; the VM section adds its switch.
  VM_SETTING_KEYS.resetPerTask,
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
  "notifications.quietHours.enabled",
  "notifications.quietHours.start",
  "notifications.quietHours.end",
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
  "meetings.transcribe.endpoint",
  "meetings.transcribe.model",
  "meetings.notes.tasksApp",
  "meetings.notes.recapDraft",
  "meetings.notes.consentLine",
  "meetings.notes.cloudSummary",
  "ui.onboarding.completedAt",
  "ui.onboarding.progress",
  "ui.transcriptMode",
  "ui.language",
  "ui.links.openIn",
  "widgets.remoteImages",
  "ui.map.tiles",
  "ui.map.styleUrl",
  "ui.map.styleUrlDark",
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
  [
    "permissions.liftedFloors.",
    (id) => t("settings.key.permissions.liftedFloors", { id: id.replace(/^conn_/, "") }),
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
