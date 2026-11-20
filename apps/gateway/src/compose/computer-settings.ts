import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSetting, listMachines, type PsycheDb, setSetting } from "@psyche/db";
import {
  type AppTier,
  BROWSER_APPS,
  effectiveTier,
  LAUNCHER_APPS,
  LINUX_TERMINAL_IDE_APPS,
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
/**
 * An app id as a helper names it: a macOS bundle id (`com.apple.Notes`) or a Linux desktop-file
 * id, dotted (`org.gnome.TextEditor`) or not (`firefox`, `gnome-terminal`). Dot-separated,
 * non-empty segments of letters, digits, `_`, `+` and `-`, starting with a letter or digit: no
 * whitespace, slashes, `..`, quotes or control characters. Callers also cap the length at 200.
 */
export const APP_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_+-]*(?:\\.[A-Za-z0-9_+-]+)*$";
/** The ids above, or a Windows app as its helper names it: the lowercase executable. */
const BUNDLE_ID =
  /^(?:[A-Za-z0-9][A-Za-z0-9_+-]*(?:\.[A-Za-z0-9_+-]+)*|[a-z0-9_][a-z0-9 _().-]*\.exe)$/;

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

/**
 * Fixed caps as the helper reads them: password managers, banking, settings off; etc. Ids are
 * macOS bundle ids, Windows executables and Linux desktop-file ids; an entry ending in `*`
 * (`com.chase.*`, `jetbrains-*`) is a prefix pattern.
 */
export function fixedCaps(): Record<string, AppTier> {
  const caps: Record<string, AppTier> = {};
  for (const id of TERMINAL_IDE_APPS) caps[id] = "click";
  for (const id of LINUX_TERMINAL_IDE_APPS) caps[id] = "click";
  for (const id of BROWSER_APPS) caps[id] = "read";
  for (const id of LOCKED_OFF_APPS) caps[id] = "off";
  for (const id of LAUNCHER_APPS) caps[id] = "off";
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

/**
 * Per-machine tiers (wave H4, design 8.3): `computerUse.machineApps` is
 * `{ [machineId]: [{id, name, tier}] }`, written by Settings → Computer use's machine picker and
 * filled with each app the agent first uses on a machine (`noteMachineApp`, tier `ask`). A
 * machine never inherits the Host's tiers or `permissions.policy`'s apps: an app the owner did
 * not choose for that machine asks there. Tiers are lowered to the fixed caps when written
 * (`normalizeMachineSetting`) and again when read, and the box's own `policy.json` ceiling is
 * enforced by its helper at dispatch whatever the Gateway sends.
 */
export const COMPUTER_USE_MACHINE_APPS = "computerUse.machineApps";
/**
 * Settings → Computer use → Default computer for background work (design 8.2): `""` (or absent)
 * for this computer, else a paired machine's id. Tasks and automations that name no computer run
 * there; a chat turn always means the Host unless it names a machine.
 */
export const COMPUTER_USE_DEFAULT_MACHINE = "computerUse.defaultMachine";

/** A machine id as a settings key: a plain id, never a dotted path or `__proto__`. */
const MACHINE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MACHINE_ROW_TIERS = ["off", "read", "click", "interact", "ask"] as const;
type MachineRowTier = (typeof MACHINE_ROW_TIERS)[number];
const MAX_MACHINE_APPS = 500;

/** One machine's tiers from `computerUse.machineApps`, each capped by the fixed caps. */
export function machineAppTiers(value: unknown, machineId: string): Record<string, AppTier> {
  if (!MACHINE_KEY.test(machineId) || machineId === "__proto__") return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  if (!Object.hasOwn(value, machineId)) return {};
  const rows = (value as Record<string, unknown>)[machineId];
  const out: Record<string, AppTier> = {};
  for (const [id, tier] of Object.entries(appTiersFrom(rows))) {
    out[id] = effectiveTier(id, tier).tier ?? "off";
  }
  return out;
}

/**
 * The file a machine's helper keeps as its `computer-use.json`: the owner's tiers for that machine
 * only (never the Host's), capped, plus the fixed caps. Off → `default: "off"`.
 */
export function machineComputerUseFile(
  enabled: unknown,
  value: unknown,
  machineId: string,
): ComputerUseFile {
  const caps = fixedCaps();
  if (enabled !== true) return { version: 1, default: "off", apps: {}, caps };
  return { version: 1, default: "ask", apps: machineAppTiers(value, machineId), caps };
}

/** `computerUse.defaultMachine` as a machine reference, or `undefined` for the Host. */
export function defaultMachineFrom(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (v === "" || v.toLowerCase() === "host") return undefined;
  return v.slice(0, 64);
}

/** The ids of the paired machines (a revoked device's machine is not one). */
function pairedMachineIds(db: PsycheDb): Set<string> {
  return new Set(listMachines(db).map((m) => m.id));
}

const badSetting = (key: string, why: string): PsycheError =>
  new PsycheError("invalid_params", `${key}: ${why}`, { details: { reason: "invalid_setting" } });

/**
 * Validates a write of `computerUse.machineApps` or `computerUse.defaultMachine`
 * (`settings.set`) and returns the value to store; any other key comes back unchanged. Unknown
 * machine ids and malformed rows are refused. A tier above an app's fixed cap is stored at the
 * cap, so no client can raise a tier above what the owner's caps allow; the box's ceiling then
 * applies on the box.
 */
export function normalizeMachineSetting(db: PsycheDb, key: string, value: unknown): unknown {
  if (key === COMPUTER_USE_DEFAULT_MACHINE) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "string") throw badSetting(key, "must be a machine id or empty");
    const id = value.trim();
    if (id === "") return "";
    if (!pairedMachineIds(db).has(id)) throw badSetting(key, `no paired machine has the id ${id}`);
    return id;
  }
  if (key !== COMPUTER_USE_MACHINE_APPS) return value;
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badSetting(key, "must map machine ids to app lists");
  }
  const paired = pairedMachineIds(db);
  const out: Record<string, { id: string; name: string; tier: MachineRowTier }[]> = {};
  for (const [machineId, rows] of Object.entries(value)) {
    if (!MACHINE_KEY.test(machineId) || !paired.has(machineId)) {
      throw badSetting(key, `no paired machine has the id ${machineId.slice(0, 64)}`);
    }
    if (!Array.isArray(rows) || rows.length > MAX_MACHINE_APPS) {
      throw badSetting(
        key,
        `the apps of ${machineId} must be a list of at most ${MAX_MACHINE_APPS}`,
      );
    }
    const seen = new Set<string>();
    const list: { id: string; name: string; tier: MachineRowTier }[] = [];
    for (const row of rows) {
      const r = row as { id?: unknown; name?: unknown; tier?: unknown } | null;
      if (typeof r?.id !== "string" || r.id.length > 200 || !BUNDLE_ID.test(r.id)) {
        throw badSetting(key, "an app id is not valid");
      }
      if (!MACHINE_ROW_TIERS.includes(r.tier as MachineRowTier)) {
        throw badSetting(key, `${r.id} has no valid tier`);
      }
      const lower = r.id.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      const asked = r.tier as MachineRowTier;
      // Never above the fixed cap: a client cannot raise a browser to interact or a password
      // manager above off, whatever it writes.
      const tier: MachineRowTier =
        asked === "ask"
          ? effectiveTier(r.id, undefined).tier === "off"
            ? "off"
            : "ask"
          : (effectiveTier(r.id, asked).tier ?? "off");
      const name =
        typeof r.name === "string" && r.name.trim() !== ""
          ? r.name.trim().slice(0, 200)
          : displayName(r.id);
      list.push({ id: r.id, name, tier });
    }
    out[machineId] = list;
  }
  return out;
}

/**
 * The agent used an app on a machine: list it under that machine in `computerUse.machineApps` as
 * `ask` the first time, so the owner can choose its tier there. Widens nothing. Returns the new
 * entry, or `undefined` when nothing changed.
 */
export function noteMachineApp(
  db: PsycheDb,
  machineId: string,
  appId: string,
  name?: string,
): ReturnType<typeof setSetting> | undefined {
  if (!MACHINE_KEY.test(machineId) || machineId === "__proto__") return undefined;
  if (!BUNDLE_ID.test(appId) || appId.length > 200) return undefined;
  if (!pairedMachineIds(db).has(machineId)) return undefined;
  const raw = getSetting(db, COMPUTER_USE_MACHINE_APPS)?.value;
  const all: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
  const rows =
    Object.hasOwn(all, machineId) && Array.isArray(all[machineId])
      ? [...(all[machineId] as unknown[])]
      : [];
  const known = rows.some(
    (r) =>
      typeof (r as { id?: unknown })?.id === "string" &&
      (r as { id: string }).id.toLowerCase() === appId.toLowerCase(),
  );
  if (known || rows.length >= MAX_MACHINE_APPS) return undefined;
  rows.push({
    id: appId,
    name: name === undefined || name.trim() === "" ? displayName(appId) : name.trim().slice(0, 200),
    tier: effectiveTier(appId, undefined).tier === "off" ? "off" : "ask",
  });
  all[machineId] = rows;
  return setSetting(db, COMPUTER_USE_MACHINE_APPS, all);
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
