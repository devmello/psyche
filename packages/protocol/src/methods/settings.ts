import { Type } from "@sinclair/typebox";
import { SettingEntry, Settings } from "../schemas/surfaces.ts";
import { defineMethod } from "./define.ts";

/**
 * `settings.*` (data model §10). `settings.set` needs `operator.write`; every key outside the
 * cosmetic allowlist (`isAdminSettingKey`, `USER_SETTING_PREFIXES`) additionally needs
 * `operator.admin` plus fresh user presence, which the Gateway enforces (security §10). A
 * successful set emits `settings.changed`.
 */

/** Dotted key, e.g. `appearance.theme`; no empty segments. */
const SettingKey = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$",
});

export const SettingsMethods = {
  "settings.get": defineMethod({
    params: Type.Object({ keys: Type.Optional(Type.Array(SettingKey, { maxItems: 256 })) }),
    result: Type.Object({ settings: Settings, stateVersion: Type.Integer({ minimum: 0 }) }),
    scope: "operator.read",
    description: "Returns all settings, or only the given keys, with the current stateVersion.",
  }),
  "settings.set": defineMethod({
    params: Type.Object({ key: SettingKey, value: Type.Unknown() }),
    result: Type.Object({ entry: SettingEntry, stateVersion: Type.Integer({ minimum: 0 }) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Sets one setting. Every key outside the cosmetic allowlist (appearance, ui, editor, shortcuts, locale, notifications.sound, notifications.badges) also needs operator.admin. Side-effecting.",
  }),
} as const;
