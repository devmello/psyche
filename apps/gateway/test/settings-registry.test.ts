import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { isKnownLocaleTag, SettingsRegistry } from "../src/settings-registry.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * `settings.set` validates against the registry (QA 2026-11-25, bug 5): known keys with typed
 * values, no invented keys, feature validators plugged in. Two lists, both through the registry
 * and through the composed Gateway: what is refused, and what a real client still writes.
 */

const reg = () => new SettingsRegistry();
const reasonOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as PsycheError).details?.["reason"] as string | undefined;
  }
  return undefined;
};

const BAD: [string, unknown, "setting_invalid" | "setting_unknown"][] = [
  // The values QA stored.
  ["appearance", 42, "setting_unknown"],
  ["no.such.key", true, "setting_unknown"],
  ["points.enabled", "yes", "setting_invalid"],
  ["locale", "xx-NOPE", "setting_invalid"],
  ["ui.locale", "xx-NOPE", "setting_invalid"],
  ["notifications.quietHours.start", "25:99", "setting_invalid"],
  // Near misses for each rule.
  ["appearance.theme", "purple", "setting_invalid"],
  ["appearance.theme", 1, "setting_invalid"],
  ["appearance.accentSeed", "blue", "setting_invalid"],
  ["appearance.zoom", 5000, "setting_invalid"],
  ["appearance.reduceMotion", "sometimes", "setting_invalid"],
  ["ui.language", "tlh", "setting_invalid"],
  ["ui.direction", "up", "setting_invalid"],
  ["notifications.quietHours.enabled", 1, "setting_invalid"],
  ["notifications.quietHours.end", "7:5", "setting_invalid"],
  ["specialists.maxConcurrent", 0, "setting_invalid"],
  ["specialists.maxConcurrent", 1.5, "setting_invalid"],
  ["ui", "x", "setting_unknown"],
  ["nope", 1, "setting_unknown"],
  ["Appearance.theme", "dark", "setting_unknown"],
];
const GOOD: [string, unknown][] = [
  ["appearance.theme", "dark"],
  ["appearance.theme", null],
  ["appearance.accentSeed", "#2c5aa0"],
  ["appearance.zoom", 110],
  ["appearance.reduceMotion", "system"],
  ["appearance.reduceMotion", true],
  ["appearance.b", { anything: 1 }], // a namespace's other keys stay open
  ["ui.language", "de"],
  ["ui.language", "system"],
  ["ui.locale", "en-GB"],
  ["ui.locale", "system"],
  ["locale", "pt-BR"],
  ["notifications.quietHours.start", "22:30"],
  ["points.enabled", false],
  ["specialists.model.researcher", "anthropic/claude-haiku-5-5"],
  ["mail.accounts.work", { x: 1 }],
  ["nightShift.budgetUsd", 0.5], // delegated: Night shift owns its own rules
  ["promises.enabled", true],
  ["cleanupPeriodDays", 30],
];

describe("SettingsRegistry", () => {
  it.each(BAD)("refuses %s = %j (%s)", (key, value, reason) => {
    expect(reasonOf(() => reg().validate(key, value))).toBe(reason);
  });

  it.each(GOOD)("accepts %s = %j", (key, value) => {
    expect(() => reg().validate(key, value)).not.toThrow();
  });

  it("runs a feature validator on its prefix only, and lets it normalise the value", () => {
    const r = reg();
    const seen: string[] = [];
    r.registerSettingValidator("nightShift", (key, value) => {
      seen.push(key);
      if (typeof value === "number" && value > 5) {
        throw new PsycheError("invalid_params", "too big", { details: { reason: "night_shift" } });
      }
      return typeof value === "string" ? value.trim() : value;
    });
    expect(r.validate("nightShift.budgetUsd", 1)).toBe(1);
    expect(r.validate("nightShift.notify", " x ")).toBe("x");
    expect(reasonOf(() => r.validate("nightShift.budgetUsd", 99))).toBe("night_shift");
    r.validate("promises.enabled", true);
    expect(seen).toEqual(["nightShift.budgetUsd", "nightShift.notify", "nightShift.budgetUsd"]);
  });

  it("a feature can add a typed key and a new namespace", () => {
    const r = reg();
    r.registerKey("plugin.acme.mode", {
      schema: Type.Union([Type.Literal("a"), Type.Literal("b")]),
      expected: '"a" or "b"',
    });
    expect(() => r.validate("plugin.acme.mode", "a")).not.toThrow();
    expect(reasonOf(() => r.validate("plugin.acme.mode", "c"))).toBe("setting_invalid");
    expect(reasonOf(() => r.validate("plugin.other.x", 1))).toBe("setting_unknown");
    r.registerNamespace("plugin");
    expect(() => r.validate("plugin.other.x", 1)).not.toThrow();
  });

  it("locale tags: real languages pass, invented ones do not", () => {
    for (const t of ["en", "en-GB", "pt_BR", "zh-Hant-TW", "ar-EG"]) {
      expect(isKnownLocaleTag(t)).toBe(true);
    }
    for (const t of ["xx-NOPE", "xx", "en-QQ", "", "not a tag"]) {
      expect(isKnownLocaleTag(t)).toBe(false);
    }
  });
});

describe("settings.set through the composed Gateway", () => {
  let composed: ComposedGateway | null = null;
  let home = "";
  let admin: TestClient | null = null;
  afterEach(async () => {
    admin?.close();
    await composed?.stop("test");
    composed?.gateway.context.db.close();
    composed = null;
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });
  async function boot() {
    home = mkdtempSync(join(tmpdir(), "psyche-setreg-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    admin = await adminClient(composed.gateway);
    return admin;
  }

  it("refuses the QA values with invalid_params and a reason, and stores nothing", async () => {
    const c = await boot();
    for (const [key, value, reason] of BAD) {
      const res = await c.request("settings.set", { key, value }, ik());
      expect(res.ok, `${key}`).toBe(false);
      const err = res.error as { code: string; details?: { reason?: string } };
      expect(err.code).toBe("invalid_params");
      expect(err.details?.reason).toBe(reason);
    }
    const got = await c.call<{ settings: Record<string, unknown> }>("settings.get", {});
    expect(got.settings.appearance).toBeUndefined();
    expect(got.settings["no.such.key"]).toBeUndefined();
    expect(got.settings["points.enabled"]).toBeUndefined();
  });

  it("still stores what the app writes (positive control), and null clears a key", async () => {
    const c = await boot();
    await c.call("settings.set", { key: "appearance.theme", value: "dark" }, ik());
    await c.call("settings.set", { key: "points.enabled", value: true }, ik());
    await c.call("settings.set", { key: "ui.test", value: { a: 1 } }, ik());
    const got = await c.call<{ settings: Record<string, unknown> }>("settings.get", {});
    expect(got.settings["appearance.theme"]).toBe("dark");
    expect(got.settings["points.enabled"]).toBe(true);
    await c.call("settings.set", { key: "appearance.theme", value: null }, ik());
  });

  it("owner-choice keys (permissions.mode) still write with no presence step", async () => {
    const c = await boot();
    // `permissions.mode` stays an owner choice with no presence step and is typed by its own path.
    const res = await c.request(
      "settings.set",
      { key: "permissions.mode", value: "balanced" },
      ik(),
    );
    expect(res.ok).toBe(true);
  });
});
