import { isIP } from "node:net";
import { DEFAULT_GATEWAY_PORT, PsycheError } from "@psyche/protocol";

/**
 * The owner's LAN choice (remote-gateway design §3.1, "LAN"): the `gateway.lan` setting, which
 * is a security setting like every `gateway.*` key (operator.admin plus fresh presence). Off by
 * default. It names the interface(s) to listen on; there is no "all interfaces".
 */
export const LAN_SETTING = "gateway.lan";

export interface LanSettings {
  enabled: boolean;
  /** Interface names (`en0`) or addresses (`192.168.1.20`). Empty = the primary interface. */
  interfaces: string[];
  port: number;
}

export function lanOff(): LanSettings {
  return { enabled: false, interfaces: [], port: DEFAULT_GATEWAY_PORT };
}

const INTERFACE_NAME = /^[A-Za-z0-9._:-]{1,32}$/;
const WILDCARDS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

/** `true` for an address that listens on every interface: refused, never "implicit". */
export function isWildcardAddress(value: string): boolean {
  return WILDCARDS.has(value.trim().toLowerCase());
}

/**
 * Validates a `gateway.lan` value. A missing value is "off". A present but malformed one throws:
 * the caller treats that as off too (see `readLanSettings`), so a corrupt row can never turn the
 * listener on.
 */
export function parseLanSettings(value: unknown): LanSettings {
  if (value === undefined || value === null) return lanOff();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PsycheError("invalid_params", "gateway.lan must be an object");
  }
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (key !== "enabled" && key !== "interfaces" && key !== "port") {
      throw new PsycheError("invalid_params", `gateway.lan.${key} is not a known key`);
    }
  }
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") {
    throw new PsycheError("invalid_params", "gateway.lan.enabled must be a boolean");
  }
  const port = v.port ?? DEFAULT_GATEWAY_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PsycheError("invalid_params", "gateway.lan.port must be an integer 1-65535");
  }
  const raw = v.interfaces ?? [];
  if (!Array.isArray(raw) || raw.length > 8) {
    throw new PsycheError("invalid_params", "gateway.lan.interfaces must be a list of at most 8");
  }
  const interfaces: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new PsycheError("invalid_params", "gateway.lan.interfaces must be strings");
    }
    const name = item.trim();
    if (isWildcardAddress(name)) {
      throw new PsycheError(
        "forbidden",
        "gateway.lan never listens on every interface; choose one",
      );
    }
    if (isIP(name) === 0 && !INTERFACE_NAME.test(name)) {
      throw new PsycheError("invalid_params", `gateway.lan.interfaces: bad entry ${item}`);
    }
    if (!interfaces.includes(name)) interfaces.push(name);
  }
  return { enabled: v.enabled === true, interfaces, port };
}

/** The stored setting as the listener sees it: anything unreadable is off. */
export function readLanSettings(value: unknown): LanSettings {
  try {
    return parseLanSettings(value);
  } catch {
    return lanOff();
  }
}
