import type { UiPlatform } from "../../../lib/platform.ts";
import type { MessageId } from "../index.ts";

type Table = Readonly<Partial<Record<MessageId, string>>>;

/**
 * Platform variants of catalogue messages (`./windows.ts`, `./linux.ts`). macOS is the base
 * wording, so only Windows and Linux have a table; `other` (phones) reads the base messages.
 * The tables are not imported here: `catalogues.ts` loads the running platform's two files on
 * demand and registers them, so a Mac renderer never parses the Windows and Linux text.
 */
const VARIANTS: Partial<Record<UiPlatform, Table>> = {};
const VARIANT_LOCALES: Partial<Record<UiPlatform, Readonly<Record<string, Table>>>> = {};

/** Makes `platform`'s English variants and their translations available to `t()`. */
export function registerPlatformVariants(
  platform: UiPlatform,
  english: Table,
  locales: Readonly<Record<string, Table>>,
): void {
  VARIANTS[platform] = english;
  VARIANT_LOCALES[platform] = locales;
}

/** True when `platform`'s variants are registered (macOS and phones have none to load). */
export function hasPlatformVariants(platform: UiPlatform): boolean {
  return VARIANTS[platform] !== undefined;
}

/** The variant of `id` on `platform`, or undefined when the base message applies. */
export function platformVariant(platform: UiPlatform, id: MessageId): string | undefined {
  return VARIANTS[platform]?.[id];
}

/** A translated variant of `id` for `locale` on `platform`, if a translator wrote one. */
export function translatedPlatformVariant(
  platform: UiPlatform,
  locale: string,
  id: MessageId,
): string | undefined {
  return VARIANT_LOCALES[platform]?.[locale]?.[id];
}
