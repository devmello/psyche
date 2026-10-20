import { getSettings, setSetting } from "@psyche/db";
import { isAdminSettingKey, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { requireFreshPresence } from "../presence-gate.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";

/**
 * Security settings (security §10): `permissions.*`, `computerUse.*`, `exec.*`, `vault.*`, `devices.*`,
 * `gateway.*`, the owner identities and the channel DM / allow policies. Besides
 * `operator.admin` they need fresh user presence: a device-only `policy_change` approval bound to
 * the exact key and value, which the broker only accepts with a verified presence assertion
 * (requiresAuthentication).
 */
// `computerUse`: enabling computer use and raising an app's tier widen what the agent may do on
// the Mac (security §12), like `permissions.apps`.
const PRESENCE_ROOTS = [
  "permissions",
  "exec",
  "vault",
  "devices",
  "gateway",
  "identityLinks",
  "computerUse",
];
const PRESENCE_KEYS = [
  /^commands\.ownerAllowFrom$/,
  /^channels\.[^.]+\.(dmPolicy|allowFrom|groupAllowFrom)$/,
];

export function needsPresence(key: string): boolean {
  const root = key.split(".")[0] ?? "";
  return PRESENCE_ROOTS.includes(root) || PRESENCE_KEYS.some((re) => re.test(key));
}

export const settingsHandlers: Record<string, HandlerDef> = {
  "settings.get": {
    run(call: Call, params: { keys?: string[] }) {
      const keys = params.keys?.filter((k) => !k.startsWith(INTERNAL_SETTING_PREFIX));
      const all = getSettings(call.ctx.db, keys);
      const settings = Object.fromEntries(
        Object.entries(all).filter(([k]) => !k.startsWith(INTERNAL_SETTING_PREFIX)),
      );
      return { settings, stateVersion: call.ctx.bus.stateVersion };
    },
  },
  "settings.set": {
    // Not transactional: a security key first awaits the broker. The write itself is one row.
    async run(call: Call, params: { key: string; value: unknown; approvalId?: string }) {
      const { key, value } = params;
      if (key.startsWith(INTERNAL_SETTING_PREFIX)) {
        throw new PsycheError(
          "invalid_params",
          `Setting keys starting with "${INTERNAL_SETTING_PREFIX}" are reserved`,
        );
      }
      if (isAdminSettingKey(key) && !call.identity.scopes.includes("operator.admin")) {
        throw new PsycheError("forbidden", `Changing ${key} requires operator.admin`);
      }
      // Fresh presence once a verifier was enrolled (helper Touch ID, passkeys); admin only before.
      if (needsPresence(key)) {
        await requireFreshPresence(
          call,
          {
            name: key,
            summary: `Change the security setting ${key}`,
            subject: value ?? null,
            details: { setting: key, value: (value ?? null) as never },
          },
          params.approvalId,
        );
      }
      const entry = setSetting(call.ctx.db, key, value);
      const stateVersion = call.ctx.bus.bumpStateVersion();
      call.emit("settings.changed", { entries: [entry] });
      return { entry, stateVersion };
    },
  },
};
