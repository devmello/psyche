import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/**
 * The `.local` name a LAN client dials (`https://<label>.local:<port>`). The label is the Host's
 * mDNS name: on macOS `scutil --get LocalHostName` (what Bonjour answers for), otherwise the first
 * label of the machine's host name, reduced to what a DNS label may hold.
 */
export function sanitizeLabel(raw: string): string {
  const first = raw.trim().split(".")[0] ?? "";
  const label = first
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return label === "" ? "psyche-host" : label;
}

export function defaultHostLabel(
  platform: NodeJS.Platform = process.platform,
  name: () => string = hostname,
  localHostName: () => string | undefined = macLocalHostName,
): string {
  if (platform === "darwin") {
    const mac = localHostName();
    if (mac !== undefined && mac.trim() !== "") return sanitizeLabel(mac);
  }
  return sanitizeLabel(name());
}

function macLocalHostName(): string | undefined {
  try {
    // A fixed system tool with fixed arguments and no shell; best effort, falls back to hostname.
    return execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function lanHostName(label: string): string {
  return `${label}.local`;
}

/** `https://<label>.local:<port>`: the origin a LAN challenge names. */
export function lanOriginFor(label: string, port: number): string {
  return `https://${lanHostName(label)}:${port}`;
}
