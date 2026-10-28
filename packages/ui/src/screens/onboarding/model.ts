/** The onboarding pieces with no components: safe for the main bundle (the flow loads on demand). */
export {
  CAPABILITIES,
  CAPABILITY_IDS,
  type Capability,
  type CapabilityId,
  isAvailable,
  runnableWins,
  WIN_IDS,
  type WinId,
} from "./capabilities.ts";
export { HABIT_DEFAULTS, HABIT_KEYS, type HabitChoices, habitSettings } from "./habits.ts";
export { MAIL_DEFAULTS, mailSettings } from "./mail-settings.ts";
export { ONBOARDING_PROGRESS_KEY, type OnboardingProgress, parseProgress } from "./progress.ts";
export {
  type ConnectedAccount,
  type ImportedMemory,
  type ImportedMemoryPreview,
  type ImportSource,
  type MailChoices,
  type ModelChoice,
  ONBOARDING_STEP_IDS,
  type OnboardingResult,
  type OnboardingShellProps,
  type OnboardingStepId,
  type OwnerProfile,
  type PermissionAnswer,
  type PermissionResult,
  type PersonaDraft,
  type SavedKey,
  type SetupCheck,
  type Workspace,
} from "./types.ts";
