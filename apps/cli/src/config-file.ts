import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors.ts";

/**
 * `$PSYCHE_HOME/config.json` (feature A5; architecture §12): operator config, never secrets.
 * The Gateway reads it at start and rejects unknown `gateway.*` keys, so the CLI validates with
 * the same rules before writing (apps/gateway README "Config keys").
 */

export const GATEWAY_KEYS: Record<string, "string" | "port" | "string[]" | "boolean"> = {
  "gateway.host": "string",
  "gateway.port": "port",
  "gateway.allowedOrigins": "string[]",
  "gateway.publicOrigin": "string",
  "gateway.trustedProxy.enabled": "boolean",
  "gateway.trustedProxy.trustedProxies": "string[]",
};

export type ConfigObject = Record<string, unknown>;

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function readConfig(home: string): { exists: boolean; config: ConfigObject } {
  const path = configPath(home);
  if (!existsSync(path)) return { exists: false, config: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError(
      "failure",
      `config.json is not valid JSON (${err instanceof Error ? err.message : err})`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError("failure", "config.json must be a JSON object");
  }
  return { exists: true, config: raw as ConfigObject };
}

/** Problems the Gateway would refuse to start with, as readable strings. */
export function validateConfig(config: ConfigObject): string[] {
  const problems: string[] = [];
  const gateway = config.gateway;
  if (gateway === undefined) return problems;
  if (gateway === null || typeof gateway !== "object" || Array.isArray(gateway)) {
    return ["gateway must be an object"];
  }
  const flat = flatten({ gateway });
  for (const [key, value] of Object.entries(flat)) {
    const type = GATEWAY_KEYS[key];
    if (!type) {
      problems.push(`${key} is not a known key`);
      continue;
    }
    const err = checkType(type, value);
    if (err) problems.push(`${key} ${err}`);
  }
  const host = (gateway as ConfigObject).host;
  if (typeof host === "string" && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    problems.push(
      `gateway.host ${host} is not loopback; the Gateway refuses it (use Tailscale Serve or Cloudflare Access for remote access)`,
    );
  }
  const tp = (gateway as ConfigObject).trustedProxy as ConfigObject | undefined;
  if (tp?.enabled === true && !(Array.isArray(tp.trustedProxies) && tp.trustedProxies.length > 0)) {
    problems.push("gateway.trustedProxy.enabled needs trustedProxies CIDRs");
  }
  return problems;
}

function checkType(type: string, value: unknown): string | null {
  switch (type) {
    case "string":
      return typeof value === "string" ? null : "must be a string";
    case "boolean":
      return typeof value === "boolean" ? null : "must be a boolean";
    case "port":
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535
        ? null
        : "must be an integer 0-65535";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? null
        : "must be an array of strings";
    default:
      return null;
  }
}

/** Flattens nested objects to dotted keys; arrays are leaves. */
export function flatten(obj: ConfigObject, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v))
      Object.assign(out, flatten(v as ConfigObject, key));
    else out[key] = v;
  }
  return out;
}

export function getPath(obj: ConfigObject, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as ConfigObject)[part];
  }
  return cur;
}

export function setPath(obj: ConfigObject, key: string, value: unknown): ConfigObject {
  const copy = structuredClone(obj);
  const parts = key.split(".");
  let cur = copy;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[part] = {};
    cur = cur[part] as ConfigObject;
  }
  cur[parts.at(-1) as string] = value;
  return copy;
}

export function writeConfig(home: string, config: ConfigObject): void {
  const path = configPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Parses a CLI value: JSON when it parses, else the raw string. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
