import type { UiPlatform } from "../../../lib/platform.ts";
import type { MessageId } from "../index.ts";
import { windows } from "./windows.ts";

/**
 * Platform variants of catalogue messages (`./windows.ts`). macOS is the base wording, so only
 * Windows has a table; `other` (Linux, phones) reads the base messages.
 */
export const PLATFORM_VARIANTS: Partial<
  Record<UiPlatform, Readonly<Partial<Record<MessageId, string>>>>
> = { windows };

/**
 * Translations of the Windows variants, by message locale (`{ de: { "web.remote.thisMac": "Dieser
 * PC" } }`). Empty until translators add them; a missing one shows the English variant.
 */
export const WINDOWS_LOCALES: Readonly<
  Record<string, Readonly<Partial<Record<MessageId, string>>>>
> = {};

/** The variant of `id` on `platform`, or undefined when the base message applies. */
export function platformVariant(platform: UiPlatform, id: MessageId): string | undefined {
  return PLATFORM_VARIANTS[platform]?.[id];
}

/** A translated variant of `id` for `locale` on `platform`, if a translator wrote one. */
export function translatedPlatformVariant(
  platform: UiPlatform,
  locale: string,
  id: MessageId,
): string | undefined {
  return platform === "windows" ? WINDOWS_LOCALES[locale]?.[id] : undefined;
}
