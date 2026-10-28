import type { ScopeMode } from "../settings/ConnectorsSection.tsx";
import type { MacHelperStatus } from "../settings/MacHelperStatus.tsx";
import type { ProviderKind, TccPermission, TccState, ToolCheck } from "../settings/types.ts";

/** Onboarding (UI design §3.19): the steps, the shell callbacks and the result. */

export type OnboardingStepId =
  | "agent"
  | "about"
  | "permissions"
  | "connectors"
  | "mail"
  | "sandbox"
  | "model"
  | "where"
  | "memory"
  | "wins"
  | "habits"
  | "done";

export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = [
  "agent",
  "about",
  "permissions",
  "connectors",
  "mail",
  "sandbox",
  "model",
  "where",
  "memory",
  "wins",
  "habits",
  "done",
];

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

export type Workspace = "local" | "vm";

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

/** Callbacks for the steps added by the first-run redesign; all optional (the step says so). */
export interface OnboardingExtrasProps {
  /** Parses an export or "what do you know about me" text without saving it. */
  onPreviewImport?: (format: ImportSource, content: string) => Promise<ImportedMemoryPreview>;
  /** Saves the reviewed items as the owner's memory; resolves with how many were saved. */
  onCommitImport?: (items: ImportedMemory[]) => Promise<number>;
  /** Runs one starter task live and resolves with its answer. */
  onRunWin?: (win: "brief" | "meetings" | "inbox") => Promise<string>;
  /** Called whenever the step changes or a step is finished, so a restart resumes. */
  onProgress?: (progress: { step: OnboardingStepId; done: OnboardingStepId[] }) => void;
  /** Steps a re-run leaves out because they are already set up. */
  completed?: readonly OnboardingStepId[];
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
  permissions: Record<TccPermission, PermissionAnswer>;
  connectors: ConnectedAccount[];
  model: ModelChoice;
  workspace: Workspace;
  /** Set when the mail step was offered (a mail account is connected). */
  mail?: MailChoices;
  /** The About-you answers (empty strings when skipped). */
  owner?: OwnerProfile;
  /** Habit switches, when that step was reached. */
  habits?: import("./habits.ts").HabitChoices;
}

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
   * Stores a provider key in the vault and resolves with its reference, plus the vault's
   * recovery key when storing it created the vault (shown once in the Model step).
   */
  onSaveKey?: (provider: string, key: string) => Promise<SavedKey> | SavedKey;
  /** Runs the tool-calling check on the chosen model. */
  onCheckModel?: (
    choice: Omit<ModelChoice, "toolCheck">,
  ) => Promise<"passed" | "failed"> | "passed" | "failed";
  /** VM mode needs macOS 15+ on Apple silicon; `false` disables the option with a reason. */
  vmAvailable?: boolean;
  /**
   * `false` where this window can't ask macOS (the web, #554): the Permissions step is left out
   * and Done says they are set up in the desktop app. Default true.
   */
  macPermissions?: boolean;
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
 * the field stays open for another paste, and a recovery key is still shown.
 */
export type SavedKey = string | { keyRef: string; recoveryKey?: string; refused?: string };

/** One line of the Done step's "Ready to go" list. */
export interface SetupCheck {
  id: string;
  label: string;
  state: "ok" | "warn";
  detail: string;
}
