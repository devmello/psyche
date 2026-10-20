import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
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
    params: Type.Object({
      key: SettingKey,
      value: Type.Unknown(),
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ entry: SettingEntry, stateVersion: Type.Integer({ minimum: 0 }) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Sets one setting. Every key outside the cosmetic allowlist (appearance, ui, editor, shortcuts, locale, notifications.sound, notifications.badges) also needs operator.admin. Security keys (permissions, exec, vault, devices, gateway, owner identities, channel DM / allow policies) also need fresh user presence once the Gateway has a presence verifier: the first call fails approval_required with details.approvalId (a device-only policy_change card bound to the key and value); retry with that approvalId after approving. Once presence was enrolled, a Gateway whose verifiers can no longer verify fails presence_required instead of falling back to operator.admin alone. Side-effecting.",
  }),
} as const;
