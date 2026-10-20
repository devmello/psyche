import { VM_SETTING_KEYS } from "@psyche/protocol";

/**
 * Plain labels for setting keys (docs/ui-audit.md: a raw key never shows at level 1). Keys are
 * free-form strings in the protocol (`settings.get` / `settings.set`), so this map is the one
 * place their words live; `test/setting-labels.test.ts` fails when a key the kit reads or writes
 * has no label here. Labels match the field label the Settings screen shows for the key.
 */
export const SETTING_LABELS: Readonly<Record<string, string>> = {
  "appearance.theme": "Theme",
  "appearance.gray": "Gray family",
  "appearance.density": "Density",
  "appearance.accentSeed": "Accent colour",
  "appearance.reduceMotion": "Reduce motion",
  "appearance.contrast": "High contrast",
  "appearance.zoom": "Zoom",
  "backup.schedule": "Backup schedule",
  "browser.realChrome": "Real-Chrome mode",
  "computerUse.enabled": "Allow computer use",
  "computerUse.apps": "App access",
  "data.transcriptRecall": "Transcript recall",
  "data.replayRetentionDays": "Keep task replays for",
  "gateway.bind": "Bind address",
  "models.primary": "Primary model",
  "models.utility": "Utility model",
  "models.image": "Image model",
  "models.providers": "Model providers",
  "permissions.mode": "Default mode",
  "permissions.policy": "Permission policy",
  "permissions.folders": "Shared folders",
  "persona.name": "Name",
  "persona.tagline": "Vibe or tagline",
  "persona.emoji": "Emoji",
  "persona.creature": "Creature",
  "persona.creatureId": "Creature",
  "vault.backend": "Where credentials are kept",
  "vault.fillDefault": "Fill default",
  [VM_SETTING_KEYS.enabled]: "Use a sandbox Mac for tasks",
  [VM_SETTING_KEYS.guestNodeId]: "Guest that runs task commands",
  [VM_SETTING_KEYS.defaultWorkspace]: "Where a task runs by default",
  [VM_SETTING_KEYS.clipboard]: "Clipboard",
  [VM_SETTING_KEYS.credentials]: "Credentials placement",
  "vm.shares": "Shared folders in VM mode",
  "voice.pushToTalk": "Push-to-talk key",
  "voice.mode": "Dictation mode",
  "voice.systemWide": "Dictate into any app",
  "voice.hotkey": "System-wide hotkey",
  "voice.engine": "Speech engine",
  "ui.onboarding.completedAt": "Onboarding",
  "ui.transcriptMode": "Transcript detail",
};

/** Families of keys with an id at the end. */
const PREFIX_LABELS: readonly [prefix: string, label: (rest: string) => string][] = [
  ["permissions.connectors.", (id) => `Access for ${id.replace(/^conn_/, "")}`],
  ["models.roles.", (role) => `Model for ${role}`],
];

/** The label for a key; never the raw key (an unknown key reads "this setting"). */
export function settingLabel(key: string): string {
  const exact = SETTING_LABELS[key];
  if (exact !== undefined) return exact;
  for (const [prefix, label] of PREFIX_LABELS) {
    if (key.startsWith(prefix) && key.length > prefix.length)
      return label(key.slice(prefix.length));
  }
  return "this setting";
}
