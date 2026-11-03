/** The onboarding pieces with no components: safe for the main bundle (the flow loads on demand). */
export {
  CAPABILITIES,
  CAPABILITY_IDS,
  type Capability,
  type CapabilityId,
  isAvailable,
} from "./capabilities.ts";
export { HABIT_DEFAULTS, HABIT_KEYS, type HabitChoices, habitSettings } from "./habits.ts";
export { MAIL_DEFAULTS, mailSettings } from "./mail-settings.ts";
export {
  MEMORY_CHOICE_DEFAULTS,
  MEMORY_CHOICE_KEYS,
  memorySettings,
  readMemoryChoices,
} from "./memory-choices.ts";
export {
  normalizeStep,
  ONBOARDING_PROGRESS_KEY,
  type OnboardingProgress,
  parseProgress,
} from "./progress.ts";
export {
  type BundledHelperKey,
  type ConnectedAccount,
  type ImportedMemory,
  type ImportedMemoryPreview,
  type ImportSource,
  type MailChoices,
  type MemoryChoices,
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
  type TouchIdSetupPort,
  type TouchIdStatus,
} from "./types.ts";
