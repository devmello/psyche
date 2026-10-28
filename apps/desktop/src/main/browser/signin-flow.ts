import { type CookieSession, forgetCookies, promoteCookies } from "./promote-cookies.ts";
import type { SignedInSite, SignedInStore } from "./signed-in-sites.ts";

/** Hosts whose cookies move: the site itself plus every host the tab visited on the way. */
export function flowHostsFor(origin: string, visited: Iterable<string>): string[] {
  const hosts = new Set<string>(visited);
  try {
    hosts.add(new URL(origin).hostname);
  } catch {
    // Not a URL: only the visited hosts.
  }
  return [...hosts].sort();
}

/**
 * "Stay signed in": copies the flow's cookies from the clean session into the profile and
 * records the origin. The caller then moves the tab onto the profile.
 */
export async function staySignedIn(o: {
  from: CookieSession;
  to: CookieSession;
  store: SignedInStore;
  origin: string;
  hosts: readonly string[];
}): Promise<SignedInSite> {
  const hosts = flowHostsFor(o.origin, o.hosts);
  const r = await promoteCookies(o.from, o.to, hosts);
  return o.store.add(o.origin, [...new Set([...hosts, ...r.hosts])]);
}

/** Settings → Browser "Sign out / forget": drops the entry and its cookies from the profile. */
export async function forgetSite(o: {
  profile: CookieSession;
  store: SignedInStore;
  origin: string;
}): Promise<boolean> {
  const site = o.store.forget(o.origin);
  if (site === undefined) return false;
  await forgetCookies(o.profile, site.hosts);
  return true;
}
