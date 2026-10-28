/**
 * Moves a site's cookies from a clean (in-memory) partition into the persistent profile after
 * the owner chose "Stay signed in" (security §6). Only cookies of the hosts the sign-in tab
 * visited are copied (the site and any SSO hosts, such as `login.ucsc.edu`), never the whole
 * clean partition, which may hold other tabs of the same task.
 *
 * localStorage and IndexedDB are not copied: they are bound to a renderer and an origin and
 * cannot be moved between sessions from the main process. Sign-ins that keep their token only
 * in storage need one more sign-in inside the profile.
 */

export interface CookieRecord {
  name: string;
  value: string;
  domain?: string | undefined;
  path?: string | undefined;
  secure?: boolean | undefined;
  httpOnly?: boolean | undefined;
  expirationDate?: number | undefined;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict" | undefined;
}

export interface CookieSetDetails extends CookieRecord {
  url: string;
}

export interface CookieJar {
  get(filter: Record<string, never>): Promise<CookieRecord[]>;
  set(details: CookieSetDetails): Promise<void>;
  remove(url: string, name: string): Promise<void>;
}

export interface CookieSession {
  cookies: CookieJar;
  flushStorageData(): void;
}

/** A session cookie in a persistent profile is dropped on quit; give it this lifetime. */
export const SESSION_COOKIE_DAYS = 30;

/** True when a cookie stored for `domain` is sent to `host` (RFC 6265 domain match). */
export function cookieMatchesHost(domain: string | undefined, host: string): boolean {
  if (domain === undefined || domain === "") return false;
  const d = domain.startsWith(".") ? domain.slice(1) : domain;
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function cookieUrl(c: CookieRecord): string {
  const host = (c.domain ?? "").replace(/^\./, "");
  return `https://${host}${c.path ?? "/"}`;
}

export interface PromoteResult {
  moved: number;
  hosts: string[];
}

export async function promoteCookies(
  from: CookieSession,
  to: CookieSession,
  hosts: readonly string[],
  nowSeconds: number = Date.now() / 1000,
): Promise<PromoteResult> {
  const all = await from.cookies.get({});
  const wanted = all.filter((c) => hosts.some((h) => cookieMatchesHost(c.domain, h)));
  const touched = new Set<string>();
  let moved = 0;
  for (const c of wanted) {
    const expirationDate = c.expirationDate ?? nowSeconds + SESSION_COOKIE_DAYS * 86_400;
    const details: CookieSetDetails = {
      url: cookieUrl(c),
      name: c.name,
      value: c.value,
      path: c.path ?? "/",
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: c.sameSite ?? "unspecified",
      expirationDate,
      // A host-only cookie has no leading dot in `domain`; leaving it unset keeps it host-only.
      ...(c.domain?.startsWith(".") ? { domain: c.domain } : {}),
    };
    try {
      await to.cookies.set(details);
      moved += 1;
      touched.add((c.domain ?? "").replace(/^\./, ""));
    } catch {
      // A cookie the profile refuses (for example a __Host- prefix mismatch) is skipped.
    }
  }
  to.flushStorageData();
  return { moved, hosts: [...touched].sort() };
}

/** Removes every cookie of `hosts` from a session (Forget). Returns how many were removed. */
export async function forgetCookies(ses: CookieSession, hosts: readonly string[]): Promise<number> {
  const all = await ses.cookies.get({});
  let removed = 0;
  for (const c of all) {
    if (!hosts.some((h) => cookieMatchesHost(c.domain, h))) continue;
    try {
      await ses.cookies.remove(cookieUrl(c), c.name);
      removed += 1;
    } catch {
      // Already gone.
    }
  }
  ses.flushStorageData();
  return removed;
}
