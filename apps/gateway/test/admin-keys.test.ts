import { isAdminSettingKey } from "@psyche/protocol";
import { describe, expect, it } from "vitest";

describe("isAdminSettingKey", () => {
  it.each([
    "permissions",
    "permissions.mode",
    "Permissions.mode",
    "GATEWAY.bind",
    "vault.autoLock",
    "grants.siteExpiryDays",
    "approvals.ttlMinutes",
    "channels.telegram.dmPolicy",
  ])("treats %s as admin-only", (key) => {
    expect(isAdminSettingKey(key)).toBe(true);
  });

  it.each(["appearance.theme", "permissionsx.mode", "memory.paused", "cleanupPeriodDays"])(
    "treats %s as an ordinary setting",
    (key) => {
      expect(isAdminSettingKey(key)).toBe(false);
    },
  );
});
