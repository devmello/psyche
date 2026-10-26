import type { SettingEntry, Settings } from "@psyche/protocol";
import { asc, eq, inArray } from "drizzle-orm";
import { settingFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { settings } from "../schema.ts";

/** One setting, or `undefined` if it was never set. */
export function getSetting(db: PsycheDb, key: string): SettingEntry | undefined {
  const row = db.drizzle.select().from(settings).where(eq(settings.key, key)).get();
  return row === undefined ? undefined : settingFromRow(row);
}

/** Settings as a flat key → value map; all of them, or only `keys` (missing keys are absent). */
export function getSettings(db: PsycheDb, keys?: readonly string[]): Settings {
  const query = db.drizzle.select().from(settings);
  const rows =
    keys === undefined
      ? query.orderBy(asc(settings.key)).all()
      : keys.length === 0
        ? []
        : query
            .where(inArray(settings.key, [...keys]))
            .orderBy(asc(settings.key))
            .all();
  const out: Settings = {};
  for (const row of rows) out[row.key] = settingFromRow(row).value;
  return out;
}

/** Upserts a setting. `value` must be JSON-serializable (`undefined` is rejected). */
export function setSetting(db: PsycheDb, key: string, value: unknown): SettingEntry {
  if (key.length === 0) throw new TypeError("setting key must not be empty");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError(`setting ${key}: value is not JSON-serializable`);
  const at = db.now();
  const row = db.drizzle
    .insert(settings)
    .values({ key, value: encoded, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({ target: settings.key, set: { value: encoded, updatedAt: at } })
    .returning()
    .get();
  return settingFromRow(row);
}

/** Removes settings; returns the keys that existed. Missing keys are ignored. */
export function deleteSettings(db: PsycheDb, keys: readonly string[]): string[] {
  if (keys.length === 0) return [];
  return db.drizzle
    .delete(settings)
    .where(inArray(settings.key, [...keys]))
    .returning({ key: settings.key })
    .all()
    .map((r) => r.key);
}
