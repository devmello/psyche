import { getSetting, type PsycheDb } from "@psyche/db";
import { type PolicyConfig, SENSITIVE_CATEGORY_SETTING_PREFIX } from "@psyche/permissions";

/**
 * The owner's Settings switches for the sensitive categories (`permissions.sensitive.*`): both on
 * unless the owner turned one off, so an install that never touched them keeps both.
 */
export function sensitiveCategoriesFrom(db: PsycheDb): { government: boolean; icloud: boolean } {
  const on = (k: string) =>
    getSetting(db, `${SENSITIVE_CATEGORY_SETTING_PREFIX}${k}`)?.value !== false;
  return { government: on("government"), icloud: on("icloud") };
}

/**
 * Applies a switch to the live broker. Only this one layer changes: connector matrices, lifted
 * floors and Computer use tiers are layered onto the live policy by other parts and stay.
 */
export function applySensitiveCategories(
  broker: { policy: PolicyConfig; setPolicy(c: PolicyConfig): void },
  db: PsycheDb,
): void {
  broker.setPolicy({ ...broker.policy, sensitiveCategories: sensitiveCategoriesFrom(db) });
}
