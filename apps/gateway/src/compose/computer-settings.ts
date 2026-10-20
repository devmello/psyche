import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSetting, setSetting } from "@psyche/db";
import {
  type AppTier,
  BROWSER_APPS,
  effectiveTier,
  LOCKED_OFF_APPS,
  type PolicyConfig,
  TERMINAL_IDE_APPS,
} from "@psyche/permissions";
import { PsycheError } from "@psyche/protocol";
import type { ComposeServices } from "./services.ts";

/**
 * Settings → Computer use (UI design §3.18, features F6 / J5) applied to the two enforcers:
 *
 * - the Mac helper reads `$PSYCHE_HOME/config/computer-use.json` (`{version, default, apps}`,
 *   apps/mac-helper README "Tiers"); the Gateway writes it from the settings, never through
 *   `node.invoke`. Off → `default: "off"`; on → apps the owner never chose stay `ask`;
 * - the Permission Broker's per-app tiers (`PolicyConfig.apps`): the owner's computer-use
 *   choices are layered over `permissions.policy`'s `apps`, so both enforcers agree.
 *
 * The UI kit's section (`ComputerUseSection`) writes `computerUse.enabled` (boolean) and
 * `computerUse.apps` (`[{id, name, tier}]`). Both are security settings (operator.admin plus
 * fresh presence, handlers/settings.ts). Fixed caps (password managers, banking, browsers,
 * terminals) are applied by both enforcers whatever the file says.
 */

export const COMPUTER_USE_ENABLED = "computerUse.enabled";
export const COMPUTER_USE_APPS = "computerUse.apps";

const TIERS: readonly AppTier[] = ["off", "read", "click", "interact"];
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+)+$/;

export interface ComputerUseFile {
  version: 1;
  default: "ask" | "off";
  apps: Record<string, AppTier>;
  /**
   * The broker's fixed caps (`@psyche/permissions` apps.ts), so both enforcers cap the same apps
   * (#267): bundle ids or `prefix.*` patterns → the highest tier allowed. A tier above its cap in
   * `apps` is already lowered here.
   */
  caps: Record<string, AppTier>;
}

/** Fixed caps as the helper reads them: password managers, banking, settings off; etc. */
export function fixedCaps(): Record<string, AppTier> {
  const caps: Record<string, AppTier> = {};
  for (const id of TERMINAL_IDE_APPS) caps[id] = "click";
  for (const id of BROWSER_APPS) caps[id] = "read";
  for (const id of LOCKED_OFF_APPS) caps[id] = "off";
  return caps;
}

/** Valid `{id, tier}` rows of `computerUse.apps`; anything else is dropped. */
export function appTiersFrom(value: unknown): Record<string, AppTier> {
  const out: Record<string, AppTier> = {};
  if (!Array.isArray(value)) return out;
  for (const row of value) {
    const r = row as { id?: unknown; tier?: unknown } | null;
    if (typeof r?.id !== "string" || !BUNDLE_ID.test(r.id) || r.id.length > 200) continue;
    if (!TIERS.includes(r.tier as AppTier)) continue;
    out[r.id] = r.tier as AppTier;
  }
  return out;
}

/**
 * The helper's file: the owner's computer-use tiers over `permissions.policy`'s `apps` (the
 * same layering the broker gets), each capped by the fixed caps, plus the caps themselves.
 */
export function computerUseFile(
  enabled: unknown,
  apps: unknown,
  policyApps: PolicyConfig["apps"] = {},
): ComputerUseFile {
  const caps = fixedCaps();
  if (enabled !== true) return { version: 1, default: "off", apps: {}, caps };
  const merged: Record<string, AppTier> = {};
  for (const [id, tier] of Object.entries({ ...(policyApps ?? {}), ...appTiersFrom(apps) })) {
    if (!BUNDLE_ID.test(id) || !TIERS.includes(tier as AppTier)) continue;
    merged[id] = effectiveTier(id, tier as AppTier).tier ?? "off";
  }
  return { version: 1, default: "ask", apps: merged, caps };
}

export function computerUsePath(home: string): string {
  return join(home, "config", "computer-use.json");
}

/** Atomic write, 0700 directory and 0600 file: the helper re-reads it before every action. */
export function writeComputerUseFile(home: string, file: ComputerUseFile): void {
  const dir = join(home, "config");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = computerUsePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface ComputerUseSettingsSync {
  /** Apply the stored settings now (boot, and after a helper connects). */
  sync(): void;
  /** `settings.changed` entries; re-applies when one of ours or `permissions.policy` changed. */
  onChanged(entries: readonly { key: string; value: unknown }[]): void;
  /**
   * The agent used an app: list it in Settings → Computer use as `ask` the first time, so the
   * owner can choose a tier ("Apps appear here the first time they're used"). Widens nothing.
   */
  noteApp(bundleId: string, name?: string): void;
}

/** `com.apple.Notes` → `Notes`, until the helper reports the display name. */
function displayName(bundleId: string): string {
  return bundleId.split(".").at(-1) ?? bundleId;
}

export function computerUseSettings(services: ComposeServices): ComputerUseSettingsSync {
  const { db, rawBroker, home, logger } = services;
  // The owner's `permissions.policy` apps, before the computer-use layer is merged in.
  let baseApps: PolicyConfig["apps"] = rawBroker.policy.apps;
  const warn = (msg: string, err: unknown) =>
    logger?.log("warn", msg, { code: PsycheError.from(err).code });

  function sync(): void {
    const enabled = getSetting(db, COMPUTER_USE_ENABLED)?.value;
    const ownerApps = getSetting(db, COMPUTER_USE_APPS)?.value;
    const file = computerUseFile(enabled, ownerApps, baseApps);
    try {
      writeComputerUseFile(home, file);
    } catch (err) {
      warn("writing config/computer-use.json failed", err);
    }
    const apps = { ...(baseApps ?? {}), ...(enabled === true ? appTiersFrom(ownerApps) : {}) };
    try {
      rawBroker.setPolicy({ ...rawBroker.policy, apps });
    } catch (err) {
      warn("applying computer-use tiers to the broker failed", err);
    }
  }

  return {
    sync,
    noteApp(bundleId, name) {
      if (!BUNDLE_ID.test(bundleId)) return;
      const raw = getSetting(db, COMPUTER_USE_APPS)?.value;
      const rows = Array.isArray(raw) ? raw : [];
      const known = rows.some(
        (r) => typeof r?.id === "string" && r.id.toLowerCase() === bundleId.toLowerCase(),
      );
      if (known) return;
      const entry = setSetting(db, COMPUTER_USE_APPS, [
        ...rows,
        { id: bundleId, name: name ?? displayName(bundleId), tier: "ask" },
      ]);
      services.publish("settings.changed", { entries: [entry] });
    },
    onChanged(entries) {
      let changed = false;
      for (const e of entries) {
        if (e.key === "permissions.policy") {
          // The composition root applied it already (it subscribed first); re-layer ours.
          baseApps = (e.value as PolicyConfig | null)?.apps;
          changed = true;
        } else if (e.key === COMPUTER_USE_ENABLED || e.key === COMPUTER_USE_APPS) {
          changed = true;
        }
      }
      if (changed) sync();
    },
  };
}
