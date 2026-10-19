import { getSettings, setSetting } from "@psyche/db";
import { isAdminSettingKey, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";

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
    transactional: true,
    run(call: Call, params: { key: string; value: unknown }) {
      const { key, value } = params;
      if (key.startsWith(INTERNAL_SETTING_PREFIX)) {
        throw new PsycheError(
          "invalid_params",
          `Setting keys starting with "${INTERNAL_SETTING_PREFIX}" are reserved`,
        );
      }
      // Security §10: security settings need operator.admin. Fresh user presence (Touch ID or a
      // passkey) is not enforced yet: it needs the helper (S14) or passkeys (INT-2).
      if (isAdminSettingKey(key) && !call.identity.scopes.includes("operator.admin")) {
        throw new PsycheError("forbidden", `Changing ${key} requires operator.admin`);
      }
      const entry = setSetting(call.ctx.db, key, value);
      const stateVersion = call.ctx.bus.bumpStateVersion();
      call.emit("settings.changed", { entries: [entry] });
      return { entry, stateVersion };
    },
  },
};
