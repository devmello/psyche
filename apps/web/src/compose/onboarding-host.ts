/**
 * The Gateway side of the onboarding steps (`@psyche/ui/onboarding`,
 * docs/design/onboarding-2026.md): memory import with a review, the memory and habit settings,
 * Touch ID key setup, saved progress and "what is already set up" for a re-run. Every function
 * takes the shell's `call`, so tests drive it with a stub and the UI kit stays free of Gateway
 * wiring.
 */
import {
  type BundledHelperKey,
  HABIT_DEFAULTS,
  HABIT_KEYS,
  type HabitChoices,
  habitSettings,
  type ImportedMemory,
  type ImportedMemoryPreview,
  type ImportSource,
  MAIL_DEFAULTS,
  type MailChoices,
  MEMORY_CHOICE_KEYS,
  type MemoryChoices,
  memorySettings,
  ONBOARDING_PROGRESS_KEY,
  type OnboardingProgress,
  type OnboardingStepId,
  type OwnerProfile,
  parseProgress,
  readMemoryChoices,
  type TouchIdSetupPort,
} from "@psyche/ui";
import { providerReady } from "./model-setup.ts";
import type { GatewayCall } from "./onboarding.ts";

type Call = GatewayCall;
let seq = 0;
const key = (what: string) => `onboarding:${what}:${Date.now()}:${++seq}`;

interface Claim {
  id: string;
  text: string;
  kind: string;
}

/** Parses an export without saving anything (`memory.import` dry run). */
export async function previewImport(
  call: Call,
  format: ImportSource,
  content: string,
): Promise<ImportedMemoryPreview> {
  const res = (await call("memory.import", { format, content, dryRun: true })) as {
    claims: Claim[];
    flagged: string[];
    skipped: number;
  };
  const flagged = new Set(res.flagged);
  return {
    items: res.claims.map((c) => ({
      id: c.id,
      text: c.text,
      kind: c.kind,
      flagged: flagged.has(c.id),
    })),
    skipped: res.skipped,
  };
}

/**
 * Saves the items the owner kept. The export is the owner's own, and they just reviewed it, so
 * each staged claim is confirmed (it becomes an owner claim). Returns how many were saved.
 */
export async function commitImport(call: Call, items: readonly ImportedMemory[]): Promise<number> {
  if (items.length === 0) return 0;
  const content = items.map((i) => `- ${i.text.replace(/\s+/g, " ").trim()}`).join("\n");
  const res = (await call(
    "memory.import",
    { format: "text", content },
    { idempotencyKey: key("import") },
  )) as { claims: Claim[] };
  for (const claim of res.claims) {
    await call(
      "memory.claims.confirm",
      { claimId: claim.id },
      { idempotencyKey: key(`confirm:${claim.id}`) },
    );
  }
  return res.claims.length;
}

/** Stores where the owner is, so quitting midway resumes (best effort). */
export async function saveProgress(call: Call, progress: OnboardingProgress): Promise<void> {
  await call(
    "settings.set",
    { key: ONBOARDING_PROGRESS_KEY, value: JSON.stringify(progress) },
    { idempotencyKey: key("progress") },
  );
}

export async function loadProgress(call: Call): Promise<OnboardingProgress | null> {
  const res = (await call("settings.get", { keys: [ONBOARDING_PROGRESS_KEY] })) as {
    settings: Record<string, unknown>;
  };
  return parseProgress(res.settings[ONBOARDING_PROGRESS_KEY]);
}

/** Writes the habit switches; a key an older Gateway doesn't know never blocks finishing. */
export async function saveHabits(call: Call, habits: HabitChoices): Promise<void> {
  for (const [settingKey, value] of Object.entries(habitSettings(habits))) {
    try {
      await call("settings.set", { key: settingKey, value }, { idempotencyKey: key(settingKey) });
    } catch {
      // Off is the safe default.
    }
  }
}

/**
 * What a re-run leaves out: only the model, when a primary one is set and ready (its key is in the
 * vault, or it runs locally). Every other step is shown pre-filled by `loadCurrent`.
 */
export async function detectCompleted(call: Call): Promise<OnboardingStepId[]> {
  try {
    const res = (await call("models.list", {})) as {
      providers: (Parameters<typeof providerReady>[0] & { id: string })[];
      roles: { primary?: string };
    };
    const primary = res.roles.primary;
    if (primary === undefined) return [];
    const provider = res.providers.find((p) => p !== undefined && primary.startsWith(`${p.id}/`));
    return providerReady(provider) ? ["model"] : [];
  } catch {
    // Unknown: leave the step in.
    return [];
  }
}

/** What the steps start with on a re-run: the stored values, so nothing resets to a default. */
export interface CurrentSetup {
  owner: Partial<OwnerProfile>;
  habits?: HabitChoices;
  mail?: MailChoices;
  memory: MemoryChoices;
}

const MAIL_KEYS: Record<keyof MailChoices, string> = {
  digest: "mail.digest.enabled",
  prep: "meetings.prep.enabled",
  followups: "mail.followups.enabled",
  voice: "mail.voice.enabled",
  notes: "meetings.notes.enabled",
};

/** A `- Label: value` line of USER.md's "About the owner" list. */
function userFact(content: string, label: string): string | undefined {
  const m = new RegExp(`^- ${label}:[ \\t]*(\\S.*)$`, "m").exec(content);
  return m?.[1]?.trim();
}

async function readSettings(call: Call, keys: readonly string[]): Promise<Record<string, unknown>> {
  try {
    const res = (await call("settings.get", { keys })) as { settings: Record<string, unknown> };
    return res.settings;
  } catch {
    return {};
  }
}

/** Reads USER.md and the settings the steps write. Anything unreadable stays at its default. */
export async function loadCurrent(call: Call): Promise<CurrentSetup> {
  const owner: Partial<OwnerProfile> = {};
  try {
    const user = (await call("memory.read", { path: "USER.md" })) as { content: string };
    const name = userFact(user.content, "Name");
    const timeZone = userFact(user.content, "Timezone");
    const work = userFact(user.content, "Work or study");
    const city = userFact(user.content, "Home city");
    if (name) owner.name = name;
    if (timeZone) owner.timeZone = timeZone;
    if (work) owner.work = work;
    if (city) owner.city = city;
  } catch {
    // The owner types it again.
  }
  const habitKeys = Object.values(HABIT_KEYS);
  const mailKeys = Object.values(MAIL_KEYS);
  const values = await readSettings(call, [...habitKeys, ...mailKeys, ...MEMORY_CHOICE_KEYS]);
  const flag = (settingKey: string, fallback: boolean) =>
    typeof values[settingKey] === "boolean" ? (values[settingKey] as boolean) : fallback;
  const anySet = (keys: string[]) => keys.some((k) => typeof values[k] === "boolean");
  return {
    owner,
    ...(anySet(habitKeys)
      ? {
          habits: {
            brief: flag(HABIT_KEYS.brief, HABIT_DEFAULTS.brief),
            wrapup: flag(HABIT_KEYS.wrapup, HABIT_DEFAULTS.wrapup),
            followups: flag(HABIT_KEYS.followups, HABIT_DEFAULTS.followups),
          },
        }
      : {}),
    ...(anySet(mailKeys)
      ? {
          mail: {
            digest: flag(MAIL_KEYS.digest, MAIL_DEFAULTS.digest),
            prep: flag(MAIL_KEYS.prep, MAIL_DEFAULTS.prep),
            followups: flag(MAIL_KEYS.followups, MAIL_DEFAULTS.followups),
            voice: flag(MAIL_KEYS.voice, MAIL_DEFAULTS.voice),
            notes: flag(MAIL_KEYS.notes, MAIL_DEFAULTS.notes),
          },
        }
      : {}),
    memory: readMemoryChoices(values),
  };
}

/**
 * Writes the Memory step's choices: `memory.work` and `memory.surfaces`, each only when it
 * changed, with the fields the owner did not touch kept as they are. A refused write leaves that
 * setting as it was (work stays off without its consent).
 */
export async function saveMemory(call: Call, choices: MemoryChoices): Promise<void> {
  const values = await readSettings(call, MEMORY_CHOICE_KEYS);
  for (const [settingKey, value] of Object.entries(memorySettings(values, choices))) {
    try {
      await call("settings.set", { key: settingKey, value }, { idempotencyKey: key(settingKey) });
    } catch {
      // Off is the safe default; the owner can set it in Settings → Memory.
    }
  }
}

/** `devices.presence.allowDevFileKey` (Gateway `DEV_FILE_KEY_SETTING`). */
const DEV_FILE_KEY_SETTING = "devices.presence.allowDevFileKey";

/** The desktop's Touch ID methods onboarding uses (`platform.helper.touchId`). */
export interface HelperTouchId {
  identity(): Promise<BundledHelperKey | null>;
  register(): Promise<unknown>;
}

/**
 * Touch ID key setup for Safety, in the same Gateway calls Settings → Devices makes: the key the
 * bundled helper reports, whether the Gateway holds it, the development-key switch, and
 * registering exactly that key. Without a helper port (the web) there is no setup to offer.
 */
export function touchIdSetup(
  call: Call,
  helper: HelperTouchId | undefined,
): TouchIdSetupPort | undefined {
  if (helper === undefined) return undefined;
  return {
    async status() {
      const identity = await helper.identity().catch(() => null);
      let registered = false;
      if (identity?.keyId !== undefined) {
        const list = (await call("devices.presenceKey.list", {}).catch(() => ({
          presenceKeys: [],
        }))) as { presenceKeys: { deviceId: string; keyId: string }[] };
        registered = list.presenceKeys.some(
          (k) => k.deviceId === identity.deviceId && k.keyId === identity.keyId,
        );
      }
      const dev = await readSettings(call, [DEV_FILE_KEY_SETTING]);
      return { identity, registered, allowDevFileKey: dev[DEV_FILE_KEY_SETTING] === true };
    },
    async register() {
      await helper.register();
    },
    async allowDevFileKey(on) {
      await call(
        "settings.set",
        { key: DEV_FILE_KEY_SETTING, value: on },
        { idempotencyKey: key("dev-file-key") },
      );
    },
  };
}

/** Creates a capability card's starter automation. */
export async function createStarterAutomation(
  call: Call,
  title: string,
  cron: string,
  prompt: string,
  timezone?: string,
): Promise<void> {
  await call(
    "automations.create",
    { kind: "cron", title, schedule: cron, prompt, ...(timezone ? { timezone } : {}) },
    { idempotencyKey: key(`automation:${title}`) },
  );
}
