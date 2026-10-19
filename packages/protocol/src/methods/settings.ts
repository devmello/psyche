import { Type } from "@sinclair/typebox";
import { SettingEntry, Settings } from "../schemas/surfaces.ts";
import { defineMethod } from "./define.ts";

/**
 * `settings.*` (data model §10). `settings.set` needs `operator.write`; keys under
 * an admin root (`isAdminSettingKey`) additionally need `operator.admin` plus fresh user presence, which
 * the Gateway enforces (security §10). A successful set emits `settings.changed`.
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
      "Sets one setting. Keys under an admin root (permissions, exec, vault, devices, gateway, channels, grants, approvals) also need operator.admin. Side-effecting.",
  }),
} as const;
