import { getSetting } from "@psyche/db";
import {
  BROWSER_DEV_PREVIEW_PORTS_ENV,
  BROWSER_DEV_PREVIEW_PORTS_KEY,
  BROWSER_PARTITION_ENV,
  BROWSER_PARTITION_KEY,
  BROWSER_SIGNED_IN_ORIGINS_ENV,
  BROWSER_SIGNED_IN_ORIGINS_KEY,
  type BrowserPartitionMode,
  DEFAULT_BROWSER_PARTITION,
  normalizeBrowserOrigin,
  normalizeDevPreviewPort,
  PsycheError,
  parseBrowserPartition,
} from "@psyche/protocol";

/**
 * The agent browser's sign-in mode, signed-in sites and dev-preview ports (Settings → Browser).
 * Each value comes from, in order: the environment variable (a development override, read-only in
 * Settings), the stored setting, the built-in default. The composed browser reads them through
 * getters, so a change applies to the next browser session; the dev-preview ports are read on
 * every use too.
 */

export type BrowserSettingSource = "env" | "setting" | "default";

export interface Sourced<T> {
  value: T;
  source: BrowserSettingSource;
}

export interface BrowserAgentSettingsValues {
  partition: Sourced<BrowserPartitionMode>;
  signedInOrigins: Sourced<string[]>;
  devPreviewPorts: Sourced<number[]>;
}

type Db = Parameters<typeof getSetting>[0];

/** Each environment variable that overrides a setting, and the setting it stands in for. */
export const BROWSER_ENV_OVERRIDES: Record<string, string> = {
  [BROWSER_PARTITION_KEY]: BROWSER_PARTITION_ENV,
  [BROWSER_SIGNED_IN_ORIGINS_KEY]: BROWSER_SIGNED_IN_ORIGINS_ENV,
  [BROWSER_DEV_PREVIEW_PORTS_KEY]: BROWSER_DEV_PREVIEW_PORTS_ENV,
};

/** The environment variable that sets `key`, or undefined when none does. */
export function envOverrideFor(key: string, env: NodeJS.ProcessEnv): string | undefined {
  const name = BROWSER_ENV_OVERRIDES[key];
  if (name === undefined) return undefined;
  return (env[name] ?? "").trim() === "" ? undefined : name;
}

/** Origins from the comma-separated env value; an entry that does not validate is dropped. */
function originsFromEnv(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const r = normalizeBrowserOrigin(part);
    if (r.ok && !out.includes(r.origin)) out.push(r.origin);
  }
  return out;
}

/** Ports from the comma-separated env value; an entry that is not a port is dropped. */
function portsFromEnv(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    const r = normalizeDevPreviewPort(/^\d+$/.test(trimmed) ? Number(trimmed) : undefined);
    if (r.ok && !out.includes(r.port)) out.push(r.port);
  }
  return out.sort((a, b) => a - b);
}

function storedValue(db: Db, key: string): unknown {
  return getSetting(db, key)?.value;
}

/** Only a value that validates is used; anything else reads as unset. */
function storedPartition(db: Db): BrowserPartitionMode | undefined {
  return parseBrowserPartition(storedValue(db, BROWSER_PARTITION_KEY));
}

function storedOrigins(db: Db): string[] | undefined {
  const raw = storedValue(db, BROWSER_SIGNED_IN_ORIGINS_KEY);
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const o of raw) {
    const r = normalizeBrowserOrigin(o);
    if (r.ok && !out.includes(r.origin)) out.push(r.origin);
  }
  return out;
}

function storedPorts(db: Db): number[] | undefined {
  const raw = storedValue(db, BROWSER_DEV_PREVIEW_PORTS_KEY);
  if (!Array.isArray(raw)) return undefined;
  const out: number[] = [];
  for (const p of raw) {
    const r = normalizeDevPreviewPort(p);
    if (r.ok && !out.includes(r.port)) out.push(r.port);
  }
  return out.sort((a, b) => a - b);
}

/** The effective values and where each comes from. Reads the database on every call. */
export function resolveBrowserAgentSettings(
  db: Db,
  env: NodeJS.ProcessEnv,
): BrowserAgentSettingsValues {
  const envPartition = parseBrowserPartition((env[BROWSER_PARTITION_ENV] ?? "").trim());
  const partition: Sourced<BrowserPartitionMode> =
    envOverrideFor(BROWSER_PARTITION_KEY, env) !== undefined
      ? { value: envPartition ?? DEFAULT_BROWSER_PARTITION, source: "env" }
      : storedPartition(db) !== undefined
        ? { value: storedPartition(db) as BrowserPartitionMode, source: "setting" }
        : { value: DEFAULT_BROWSER_PARTITION, source: "default" };
  const envSigned = envOverrideFor(BROWSER_SIGNED_IN_ORIGINS_KEY, env);
  const signedStored = storedOrigins(db);
  const signedInOrigins: Sourced<string[]> =
    envSigned !== undefined
      ? { value: originsFromEnv(env[BROWSER_SIGNED_IN_ORIGINS_ENV] ?? ""), source: "env" }
      : signedStored !== undefined
        ? { value: signedStored, source: "setting" }
        : { value: [], source: "default" };
  const envPorts = envOverrideFor(BROWSER_DEV_PREVIEW_PORTS_KEY, env);
  const portsStored = storedPorts(db);
  const devPreviewPorts: Sourced<number[]> =
    envPorts !== undefined
      ? { value: portsFromEnv(env[BROWSER_DEV_PREVIEW_PORTS_ENV] ?? ""), source: "env" }
      : portsStored !== undefined
        ? { value: portsStored, source: "setting" }
        : { value: [], source: "default" };
  return { partition, signedInOrigins, devPreviewPorts };
}

/**
 * Validates a value written with `settings.set` for one of the three keys and returns the form
 * that is stored. Other keys pass through. A key an environment variable sets is refused: the
 * variable would hide the write.
 */
export function normalizeBrowserAgentSetting(
  key: string,
  value: unknown,
  env: NodeJS.ProcessEnv,
): unknown {
  if (!(key in BROWSER_ENV_OVERRIDES)) return value;
  const envName = envOverrideFor(key, env);
  if (envName !== undefined) {
    throw new PsycheError(
      "invalid_params",
      `${key} is set by the ${envName} environment variable; unset it to change this in Settings.`,
      { details: { reason: "set_by_environment", env: envName } },
    );
  }
  if (key === BROWSER_PARTITION_KEY) {
    const mode = parseBrowserPartition(value);
    if (mode === undefined) {
      throw new PsycheError("invalid_params", "The sign-in mode must be clean, auto or profile.");
    }
    return mode;
  }
  if (key === BROWSER_SIGNED_IN_ORIGINS_KEY) {
    if (!Array.isArray(value)) {
      throw new PsycheError("invalid_params", "The signed-in sites must be a list of origins.");
    }
    const out: string[] = [];
    for (const raw of value) {
      const r = normalizeBrowserOrigin(raw);
      if (!r.ok) {
        throw new PsycheError(
          "invalid_params",
          `Not a site Psyche can sign in to (${r.reason}). Use https://host, or http:// for localhost only.`,
          { details: { reason: r.reason } },
        );
      }
      if (!out.includes(r.origin)) out.push(r.origin);
    }
    return out;
  }
  // devPreviewPorts
  if (!Array.isArray(value)) {
    throw new PsycheError("invalid_params", "The dev preview ports must be a list of ports.");
  }
  const ports: number[] = [];
  for (const raw of value) {
    const r = normalizeDevPreviewPort(raw);
    if (!r.ok) {
      throw new PsycheError(
        "invalid_params",
        "A dev preview port must be a whole number from 1 to 65535.",
      );
    }
    if (!ports.includes(r.port)) ports.push(r.port);
  }
  return ports.sort((a, b) => a - b);
}
