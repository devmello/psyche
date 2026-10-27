import { describe, expect, it } from "vitest";
import { isAdminSettingKey, isUserSettingKey, USER_SETTING_PREFIXES } from "../src/index.ts";

describe("isAdminSettingKey (allowlist, S23 review PR-1-C)", () => {
  it.each([
    "permissions.mode",
    "Permissions.mode",
    "GATEWAY.bind",
    "vault.autoLockMinutes",
    "grants.siteExpiryDays",
    "approvals.ttlMinutes",
    "channels.telegram.dmPolicy",
    "commands.ownerAllowFrom",
    "identityLinks",
    "session.dmScope",
    "mcp.servers",
    "connectors.google.actionMatrix",
    "skills.installPolicy",
    "plugins.enabled",
    "models.roles.primary",
    "updates.check",
    "browser.realChrome",
    "vm.shares",
    "memory.sensitiveTopics",
    "backup.recipients",
    "notifications.routes",
    "cleanupPeriodDays",
    "someFutureRoot.flag",
  ])("%s is admin-only", (key) => {
    expect(isAdminSettingKey(key)).toBe(true);
  });

  it.each([
    "appearance",
    "appearance.theme",
    "Appearance.Theme",
    "ui.sidebar.collapsed",
    "editor.fontSize",
    "notifications.sound",
    "notifications.sound.volume",
    "notifications.quietHours.enabled",
    "notifications.quietHours.start",
    "notifications.quietHours.end",
  ])("%s is an ordinary setting", (key) => {
    expect(isAdminSettingKey(key)).toBe(false);
    expect(isUserSettingKey(key)).toBe(true);
  });

  it("matches whole segments only", () => {
    expect(isAdminSettingKey("appearancex.theme")).toBe(true);
    expect(isAdminSettingKey("uix")).toBe(true);
    expect(isAdminSettingKey("notifications.soundboard")).toBe(true);
    expect(isAdminSettingKey("notifications")).toBe(true);
    expect(isAdminSettingKey("notifications.quietHoursOverride")).toBe(true);
  });

  it("keeps the allowlist short and cosmetic", () => {
    expect(USER_SETTING_PREFIXES.length).toBeLessThanOrEqual(10);
  });
});
