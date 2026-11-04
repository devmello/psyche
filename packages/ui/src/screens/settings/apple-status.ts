import type { AppleLlmStatus } from "@psyche/protocol";
import { t } from "../../i18n/core.ts";
import type { Tone } from "./shared.tsx";

/**
 * What Settings says about Apple's on-device model, from `models.appleStatus`: shared by the
 * search choice (SearchSection) and the memory per-source choice (EverythingFields). The status is
 * read-only; asking never runs the model.
 */

/** Short chip: ready, or the one thing that is missing. */
export function appleState(status: AppleLlmStatus): { text: string; tone: Tone } {
  if (status.available) return { text: t("settings.searchModel.apple.ready"), tone: "success" };
  switch (status.reason) {
    case "apple_intelligence_not_enabled":
      return { text: t("settings.searchModel.apple.needsAi"), tone: "approval" };
    case "model_not_ready":
      return { text: t("settings.searchModel.apple.notReady"), tone: "info" };
    case "unsupported_os":
    case "device_not_eligible":
      return { text: t("settings.searchModel.apple.notOnThisMac"), tone: "neutral" };
    default:
      return { text: t("settings.searchModel.apple.unavailable"), tone: "neutral" };
  }
}

/** The plain sentence for why it is off or unavailable; undefined when it is ready. */
export function appleReason(status: AppleLlmStatus): string | undefined {
  if (status.available) return undefined;
  switch (status.reason) {
    case "apple_intelligence_not_enabled":
      return t("settings.searchModel.apple.why.off");
    case "unsupported_os":
      return t("settings.searchModel.apple.why.os");
    case "device_not_eligible":
      return t("settings.searchModel.apple.why.device");
    case "model_not_ready":
      return t("settings.searchModel.apple.why.notReady");
    default:
      return t("settings.searchModel.apple.why.unknown");
  }
}

/** Whether the owner can pick it now. A model still getting ready cannot be used yet either. */
export const appleUsable = (status: AppleLlmStatus | null | undefined): boolean =>
  status?.helperConnected === true && status.available;
