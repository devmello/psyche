import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registrableDomain } from "@psyche/protocol";
import type { CookieSession } from "./promote-cookies.ts";

/**
 * Sites the owner is signed into in the persistent profile, found from its cookies (security §6).
 * A site counts when the profile holds at least one non-expired cookie for its registrable domain
 * (`canvas.ucsc.edu` and `login.ucsc.edu` are both `ucsc.edu`). The result is written to
 * `$PSYCHE_HOME/browser/detected-sessions.json` as domain names only, never a cookie or a value;
 * the Gateway reads it on every new browser tab.
 */

export interface DetectedSite {
  /** `https://<registrable domain>`, the form Settings → Browser lists and forgets. */
  origin: string;
  /** Cookie host names seen under the domain. */
  hosts: string[];
  addedAt: string;
  detected: true;
}

export function detectedFile(home: string): string {
  return join(home, "browser", "detected-sessions.json");
}

interface Found {
  domain: string;
  hosts: string[];
}

/** A cookie without an expiry is a session cookie and counts while it exists. */
export async function detectSessions(
  profile: CookieSession,
  nowSeconds: number = Date.now() / 1000,
): Promise<Found[]> {
  const byDomain = new Map<string, Set<string>>();
  for (const c of await profile.cookies.get({})) {
    if (c.expirationDate !== undefined && c.expirationDate <= nowSeconds) continue;
    const host = (c.domain ?? "").replace(/^\./, "").toLowerCase();
    if (host === "") continue;
    const domain = registrableDomain(host);
    const hosts = byDomain.get(domain) ?? new Set<string>();
    hosts.add(host);
    byDomain.set(domain, hosts);
  }
  return [...byDomain.entries()]
    .map(([domain, hosts]) => ({ domain, hosts: [...hosts].sort() }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

export function writeDetected(home: string, found: readonly Found[]): void {
  const file = detectedFile(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ domains: found.map((f) => f.domain) }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Refreshes the file from the profile and returns the sites for Settings. */
export async function refreshDetected(
  home: string,
  profile: CookieSession,
  nowSeconds: number = Date.now() / 1000,
  now: () => Date = () => new Date(),
): Promise<DetectedSite[]> {
  const found = await detectSessions(profile, nowSeconds);
  writeDetected(home, found);
  const at = now().toISOString();
  return found.map((f) => ({
    origin: `https://${f.domain}`,
    hosts: f.hosts,
    addedAt: at,
    detected: true,
  }));
}

/** Forget for a detected site: removes every profile cookie under its registrable domain. */
export async function forgetDetected(profile: CookieSession, origin: string): Promise<number> {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return 0;
  }
  const domain = registrableDomain(host);
  let removed = 0;
  for (const c of await profile.cookies.get({})) {
    const h = (c.domain ?? "").replace(/^\./, "");
    if (h === "" || registrableDomain(h) !== domain) continue;
    try {
      await profile.cookies.remove(`https://${h}${c.path ?? "/"}`, c.name);
      removed += 1;
    } catch {
      // Already gone.
    }
  }
  profile.flushStorageData();
  return removed;
}
