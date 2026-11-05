import { t } from "../i18n/core.ts";
import { uiPlatform } from "./platform.ts";

/**
 * Platform words for code that composes text (`platformTerm("thisDevice")` → "This Mac" /
 * "This PC"). Whole messages that name a Mac need no call here: `t()` already picks their Windows
 * variant (`i18n/messages/variants/windows.ts`). Use a term only where a word is passed into a
 * message or shown alone.
 */
export type PlatformTerm =
  | "os"
  | "device"
  | "thisDevice"
  | "thisDeviceLower"
  | "presence"
  | "secretStore"
  | "systemSettings"
  | "fileManager"
  | "trayArea"
  | "taskbar"
  | "systemSearch"
  | "helper"
  | "terminal"
  | "alt"
  | "mod";

export function platformTerm(term: PlatformTerm): string {
  return t(`platform.term.${term}`);
}

/**
 * Whether a Mac-only capability (Apple apps, VM guests, Apple's on-device model, Secure Enclave)
 * can exist here: false on Windows, where it is hidden or says "Available on macOS" instead of
 * failing (cross-platform-2026 §4.3). The web on another OS keeps showing it: the Gateway it
 * talks to may run on a Mac.
 */
export const macOnlyAvailable = (): boolean => uiPlatform() !== "windows";

/** "Available on macOS": the label a Mac-only capability shows on Windows. */
export const macOnlyLabel = (): string => t("platform.macOnly");
