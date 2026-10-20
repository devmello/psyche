import type { ScopeMode } from "../settings/ConnectorsSection.tsx";
import type { MacHelperStatus } from "../settings/MacHelperStatus.tsx";
import type { ProviderKind, TccPermission, TccState, ToolCheck } from "../settings/types.ts";

/** Onboarding (UI design §3.19): the steps, the shell callbacks and the result. */

export type OnboardingStepId = "agent" | "permissions" | "connectors" | "model" | "where" | "done";

export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = [
  "agent",
  "permissions",
  "connectors",
  "model",
  "where",
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
}

export interface OnboardingShellProps {
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
