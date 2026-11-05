import type { UiPlatform } from "../../../lib/platform.ts";
import type { MessageId } from "../index.ts";
import { linux } from "./linux.ts";
import { LINUX_LOCALES } from "./linux-locales.ts";
import { windows } from "./windows.ts";
import { WINDOWS_LOCALES } from "./windows-locales.ts";

/**
 * Platform variants of catalogue messages (`./windows.ts`, `./linux.ts`). macOS is the base
 * wording, so only Windows and Linux have a table; `other` (phones) reads the base messages.
 */
export const PLATFORM_VARIANTS: Partial<
  Record<UiPlatform, Readonly<Partial<Record<MessageId, string>>>>
> = { windows, linux };

/** The variant of `id` on `platform`, or undefined when the base message applies. */
export function platformVariant(platform: UiPlatform, id: MessageId): string | undefined {
  return PLATFORM_VARIANTS[platform]?.[id];
}

const VARIANT_LOCALES: Partial<
  Record<UiPlatform, Readonly<Record<string, Readonly<Partial<Record<MessageId, string>>>>>>
> = { windows: WINDOWS_LOCALES, linux: LINUX_LOCALES };

/** A translated variant of `id` for `locale` on `platform`, if a translator wrote one. */
export function translatedPlatformVariant(
  platform: UiPlatform,
  locale: string,
  id: MessageId,
): string | undefined {
  return VARIANT_LOCALES[platform]?.[locale]?.[id];
}
