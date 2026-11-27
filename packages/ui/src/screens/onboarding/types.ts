import type { StarterFolderId } from "@psyche/protocol";
import type { ScopeMode } from "../settings/ConnectorsSection.tsx";
import type { MacHelperStatus } from "../settings/MacHelperStatus.tsx";
import type { ProviderKind, TccPermission, TccState, ToolCheck } from "../settings/types.ts";
import type { OnboardingAnswers } from "./progress.ts";

/** Onboarding (UI design §3.19): the steps, the shell callbacks and the result. */

export type OnboardingStepId = "you" | "stuff" | "model" | "memory" | "folders" | "safety" | "done";

/** Docs: docs/design/onboarding-2026.md §2. */
export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = [
  "you",
  "model",
  "stuff",
  "memory",
  "folders",
  "safety",
  "done",
];

/**
 * The steps first run walks through: your name, the model, what to help with, and Done. The
 * others (memory, folders, safety) keep their defaults and live in Settings; they open only when
 * a route or saved progress asks for one by name.
 */
export const DEFAULT_FLOW_STEPS: ReadonlySet<OnboardingStepId> = new Set([
  "you",
  "model",
  "stuff",
  "done",
]);

/** `unavailable`: this shell can't ask (the web build, or not macOS). */
export type PermissionAnswer = "pending" | "granted" | "denied" | "skipped" | "unavailable";

/** What asking for, or reading, a permission found. */
export type PermissionResult = TccState | "unavailable";

export interface PersonaDraft {
  name: string;
  /** Bundled creature id; also the fallback when a description can't be drawn. */
  creatureId: string;
  creatureMode: "bundled" | "describe";
  /** Natural-language creature, sent to the image model when one exists. */
  creatureDescription: string;
  tagline: string;
}

export interface ConnectedAccount {
  type: string;
  label: string;
  mode: ScopeMode;
  /**
   * Where the Gateway's instance stands (#620); absent means connected (host-supplied lists).
   * `needs_auth`: a macOS permission (`needs: "permission"`) or a sign-in (`"sign_in"`) to finish.
   */
  status?: "connected" | "needs_auth" | "error";
  needs?: "permission" | "sign_in";
  connectorId?: string;
}

export interface ModelChoice {
  kind: ProviderKind;
  /** `anthropic`, `openai`, `google`, `openrouter`, `ollama`, `lmstudio`. */
  provider: string;
  modelRef: string;
  /** Vault reference for the stored key; the key itself never stays in the UI. */
  keyRef: string | null;
  toolCheck: ToolCheck;
}

/** The About-you step: written to USER.md's structured fields. All optional. */
export interface OwnerProfile {
  name: string;
  timeZone: string;
  work: string;
  city: string;
}

export type ImportSource = "chatgpt" | "claude" | "text";

/** One memory the import found, shown for review before anything is saved. */
export interface ImportedMemory {
  id: string;
  text: string;
  kind: string;
  /** Looked like an instruction (the Gateway flags it); off by default. */
  flagged: boolean;
}

export interface ImportedMemoryPreview {
  items: ImportedMemory[];
  skipped: number;
}

/** What the Memory step asks (docs/design/onboarding-2026.md §4). */
export interface MemoryChoices {
  /** `memory.work.enabled`: off until the owner has seen the consent card. */
  work: boolean;
  /** When the consent card was confirmed (ISO); null while it has not been. */
  workConsentedAt: string | null;
  /** `memory.work.remind.enabled`: due-soon reminders, sent with the evening wrap-up. */
  remind: boolean;
  /** `memory.surfaces.tiers.people.brief`: facts about people in the daily brief. */
  people: boolean;
}

/** What the helper inside this app reports (`psyche-helper --print-identity`). */
export interface BundledHelperKey {
  deviceId: string;
  keyId?: string;
  /** `windows_hello` from the Windows helper (with `algorithm`, e.g. "RSA-2048"). */
  kind?: "windows_hello" | "device_identity";
  algorithm?: string;
  error?: string;
}

/** Where the helper's Touch ID key stands: read once when Safety opens, and after each action. */
export interface TouchIdStatus {
  /** `null`: this build bundles no helper. */
  identity: BundledHelperKey | null;
  /** The Gateway holds this key for the helper. */
  registered: boolean;
}

/** The desktop's Touch ID setup, in the steps Settings → Devices uses. Absent on the web. */
export interface TouchIdSetupPort {
  status(): Promise<TouchIdStatus>;
  /** Registers exactly the key the bundled helper reports. */
  register(): Promise<void>;
}

/** Callbacks for the steps added by the first-run redesign; all optional (the step says so). */
export interface OnboardingExtrasProps {
  /** Parses an export or "what do you know about me" text without saving it. */
  onPreviewImport?: (format: ImportSource, content: string) => Promise<ImportedMemoryPreview>;
  /** Saves the reviewed items as the owner's memory; resolves with how many were saved. */
  onCommitImport?: (items: ImportedMemory[]) => Promise<number>;
  /** Called whenever the step changes or a step is finished, so a restart resumes. */
  onProgress?: (progress: {
    step: OnboardingStepId;
    done: OnboardingStepId[];
    answers?: OnboardingAnswers;
  }) => void;
  /** Steps a re-run leaves out because they are already set up. */
  completed?: readonly OnboardingStepId[];
  /** A re-run: the agent's name and look are edited in Settings, so the You step omits them. */
  rerun?: boolean;
  /** Desktop: Touch ID key setup for Safety. Without it the row is not shown. */
  touchId?: TouchIdSetupPort;
}

/**
 * The mail and meetings decision screen's switches (mail-and-meetings-2026 §7.5). The step is
 * offered only when a mail account is connected; without one `OnboardingResult.mail` is absent.
 */
export interface MailChoices {
  /** Morning inbox digest at 7:30. */
  digest: boolean;
  /** Prep notes before meetings with people outside the team. */
  prep: boolean;
  /** Track replies the owner is waiting on (shown in the digest only). */
  followups: boolean;
  /** Learn the writing style from sent mail (starts off). */
  voice: boolean;
  /** Meeting notes from recordings (does nothing until the owner adds audio). */
  notes: boolean;
}

export interface OnboardingResult {
  persona: {
    name: string;
    creatureId: string;
    creatureDescription: string | null;
    tagline: string;
  };
  /** The macOS grants; `microphone` only on Windows (its privacy toggle, the one grant there). */
  permissions: Record<Exclude<TccPermission, "microphone">, PermissionAnswer> & {
    microphone?: PermissionAnswer;
  };
  connectors: ConnectedAccount[];
  /**
   * "Make these searchable" (on by default): the host turns on the search sources that match the
   * connected accounts. Present only when an account is connected.
   */
  searchable?: boolean;
  model: ModelChoice;
  /**
   * A re-run that left the Model step out: the Done check reads the model that is set and does
   * not bind another.
   */
  modelKept?: boolean;
  /** Set when the mail step was offered (a mail account is connected). */
  mail?: MailChoices;
  /** The About-you answers (empty strings when skipped). */
  owner?: OwnerProfile;
  /** Habit switches, when that step was reached. */
  habits?: import("./habits.ts").HabitChoices;
  /** Present (true) only when the owner turned on the optional "Prepare things overnight?" card. */
  nightShift?: true;
  /** Work tracking and people in the brief, when the Memory step was reached. */
  memory?: MemoryChoices;
  /**
   * The folders ticked on the opt-in Folders step (absolute paths from `files.starterFolders`).
   * Absent or empty: nothing is written. The host adds them read only, never read-write.
   */
  sharedFolders?: { id: StarterFolderId; path: string }[];
  /** Open Settings → File access once onboarding ends (the folders needed a card to be shared). */
  openFileAccess?: boolean;
  /** Where the chat opens after setup: a "Try next" button on Done picked it. */
  openAfter?: OnboardingTryTarget;
  /** The helper's Touch ID key was registered during setup (informational). */
  touchIdRegistered?: boolean;
}

/** The places Done's "Try next" buttons open. */
export type OnboardingTryTarget = "search" | "home" | "chat";

export interface OnboardingShellProps extends OnboardingExtrasProps {
  /** Installed RAM for local-model guidance. */
  ramGb?: number;
  /**
   * Asks macOS for a permission (the prompt, or the System Settings pane); resolves with the
   * new state. Without it the row says "Unavailable".
   */
  onRequestPermission?: (permission: TccPermission) => Promise<PermissionResult> | PermissionResult;
  /** Reads every permission without prompting, e.g. when the owner returns from System Settings. */
  onReadPermissions?: () => Promise<Partial<Record<TccPermission, PermissionResult>>>;
  /** Runs a connect flow (OAuth window); resolves `false` when the user backs out. */
  onConnect?: (type: string, mode: ScopeMode) => Promise<boolean | undefined> | boolean | undefined;
  /**
   * Stores a provider key in the vault and resolves with its reference. A vault this creates
   * keeps its recovery key (Home and Settings show it later); onboarding does not.
   */
  onSaveKey?: (provider: string, key: string) => Promise<SavedKey> | SavedKey;
  /** Runs the tool-calling check on the chosen model. */
  onCheckModel?: (
    choice: Omit<ModelChoice, "toolCheck">,
  ) => Promise<"passed" | "failed" | "untested"> | "passed" | "failed" | "untested";
  /** VM mode needs macOS 15+ on Apple silicon; `false` disables the option with a reason. */
  vmAvailable?: boolean;
  /**
   * `false` where this window can't ask macOS (the web, #554): the Permissions step is left out
   * and Done says they are set up in the desktop app. Default true.
   */
  macPermissions?: boolean;
  /**
   * Writes the ticked folders (read only) when the owner opens the chat. Rejects with
   * `approval_required` (and `details.approvalId`) when the Gateway wants its approval card
   * first; the flow then asks the owner to approve and calls again with that id.
   */
  onShareFolders?: (
    folders: { id: StarterFolderId; path: string }[],
    approvalId?: string,
  ) => Promise<void>;
  /** Desktop: the bundled Mac helper's state, shown in Permissions; never blocks a step. */
  helper?: MacHelperStatus;
  /**
   * Runs when the Done step opens: applies the model choice and reports what works (Gateway,
   * helper, model). The Done step lists the result; a warning never blocks finishing.
   */
  onVerify?: (result: OnboardingResult) => Promise<SetupCheck[]>;
}

/**
 * `refused`: the key was stored but the provider refused it on the check right after (#504);
 * the field stays open for another paste. The vault's recovery key is not part of onboarding: it
 * waits on Home ("Save your recovery key") and in Settings → Credentials.
 */
export type SavedKey = string | { keyRef: string; refused?: string };

/** One line of the Done step's "Ready to go" list. */
export interface SetupCheck {
  id: string;
  label: string;
  /** `fail`: refused or broken; `unchecked`: could not be verified (not a pass). */
  state: "ok" | "warn" | "fail" | "unchecked";
  detail: string;
  /** The step that fixes it; Done shows a link back to it. */
  fixStep?: OnboardingStepId;
}
