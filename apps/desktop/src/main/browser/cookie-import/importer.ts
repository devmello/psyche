import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import {
  type CookieRecord,
  type CookieSession,
  type CookieSetDetails,
  SESSION_COOKIE_DAYS,
} from "../promote-cookies.ts";
import { CookieAuditQueue } from "./audit-queue.ts";
import { groupByDomain, hostsOf, type ImportSite, siteSensitivity, sitesOf } from "./domains.ts";
import {
  deriveChromiumKey,
  type ImportCookie,
  type ReadResult,
  readChromiumCookies,
  readFirefoxCookies,
  type SqliteQuery,
  sweepStaleCopies,
} from "./read.ts";
import {
  cookieFileOf,
  type ImportBrowser,
  type ImportSource,
  isChromium,
  keychainAccountOf,
  keychainServiceOf,
  listSources,
} from "./sources.ts";

/**
 * "Import sign-ins from…" (docs/design/cookie-import-2026.md). Desktop main process only: the
 * owner starts it from Settings → Browser over the app window's own IPC; there is no tool and
 * no Gateway method that reaches it. Cookie values live only in this object's memory between
 * `scan` and `import`, and only cookies of the sites the owner ticked are written, into
 * Psyche's own profile. What leaves this file is domains, counts and flags.
 */

/** What the audit gets: counts and domains, never a cookie name or value. */
export interface CookieImportRecord {
  action: "imported" | "removed";
  browser: ImportBrowser;
  sites: { domain: string; cookies: number }[];
}

export interface CookieImportDeps {
  /** The owner's home folder, where the browsers keep their profiles. */
  homeDir: string;
  /** `$PSYCHE_HOME`: the imported-sites list lives in `browser/`. */
  psycheHome: string;
  /** Parent of the private folder each database copy goes into. */
  tmpRoot: string;
  platform: NodeJS.Platform;
  /** Psyche's own logged-in profile. Nothing else is ever written. */
  profile: () => CookieSession;
  /** "<Browser> Safe Storage" from the Keychain; macOS asks the owner. */
  readKeychain: (service: string, account: string) => Promise<string>;
  /**
   * Sends one audit entry to this Mac's own Gateway (`browser.cookieImport.record`). Entries
   * are queued in `$PSYCHE_HOME/browser/` first and sent in order by `flushAudit`; the caller
   * must not provide this for a remote Gateway.
   */
  record?: (entry: CookieImportRecord) => Promise<void>;
  nowMs?: () => number;
  sqlite?: SqliteQuery;
  /** How long a read list is kept for the pick (default 10 minutes). */
  scanTtlMs?: number;
}

export interface CookieImportScan {
  scanId: string;
  browser: ImportBrowser;
  sites: ImportSite[];
  expired: number;
  skipped: number;
}

export interface CookieImportResult {
  sites: { domain: string; cookies: number }[];
  /** Cookies the profile refused (for example a `__Host-` cookie with a domain). */
  failed: number;
}

export interface ImportedSite {
  domain: string;
  browser: ImportBrowser;
  cookies: number;
  importedAt: string;
}

interface StoredCookie {
  host: string;
  path: string;
  name: string;
}

interface StoredSite {
  domain: string;
  browser: ImportBrowser;
  importedAt: string;
  /** Which cookies the import wrote, so Remove deletes exactly those. Never a value. */
  cookies: StoredCookie[];
}

interface Scan {
  browser: ImportBrowser;
  groups: Map<string, ImportCookie[]>;
  expiresAt: number;
}

export function importedFile(home: string): string {
  return join(home, "browser", "imported-sign-ins.json");
}

const DOMAIN = /^[a-z0-9.-]{1,253}$/;

export class CookieImporter {
  readonly #d: CookieImportDeps;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #queue: CookieAuditQueue;
  /** Import and Remove run one at a time: both rewrite the imported-sites list. */
  #chain: Promise<unknown> = Promise.resolve();
  /** One read list at a time: a new Read replaces the old one. */
  #scan: { id: string; scan: Scan } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: CookieImportDeps) {
    this.#d = deps;
    this.#now = deps.nowMs ?? Date.now;
    this.#ttl = deps.scanTtlMs ?? 10 * 60_000;
    this.#queue = new CookieAuditQueue(deps.psycheHome, { now: this.#now });
    // A crash can leave a private copy of a cookie file behind: it is never needed again.
    sweepStaleCopies(deps.tmpRoot);
  }

  /** Sends the queued audit entries once the local Gateway is connected as admin. */
  async flushAudit(): Promise<number> {
    const send = this.#d.record;
    if (send === undefined) return 0;
    return this.#queue.flush(send);
  }

  pendingAudit(): number {
    return this.#queue.pending();
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  sources(): ImportSource[] {
    return listSources(this.#d.homeDir, this.#d.platform);
  }

  /** Reads the browser profile's cookies and keeps them for the pick. Returns no values. */
  async scan(browser: ImportBrowser, profileId: string): Promise<CookieImportScan> {
    this.discard();
    const file = cookieFileOf(this.#d.homeDir, this.#d.platform, browser, profileId);
    if (file === undefined) {
      throw new PsycheError("not_found", "Psyche couldn't find that browser profile");
    }
    const nowSeconds = Math.floor(this.#now() / 1000);
    const common = {
      file,
      tmpRoot: this.#d.tmpRoot,
      nowSeconds,
      ...(this.#d.sqlite ? { sqlite: this.#d.sqlite } : {}),
    };
    let read: ReadResult;
    if (isChromium(browser)) {
      const password = await this.#d.readKeychain(
        keychainServiceOf(browser),
        keychainAccountOf(browser),
      );
      read = await readChromiumCookies({ ...common, key: deriveChromiumKey(password) });
      if (read.cookies.length === 0 && read.skipped > 0) {
        throw new PsycheError("forbidden", "the browser's sign-ins could not be decrypted");
      }
    } else {
      read = await readFirefoxCookies(common);
    }
    const groups = groupByDomain(read.cookies);
    const id = randomBytes(16).toString("hex");
    this.#scan = { id, scan: { browser, groups, expiresAt: this.#now() + this.#ttl } };
    this.#timer = setTimeout(() => this.discard(id), this.#ttl);
    this.#timer.unref?.();
    return {
      scanId: id,
      browser,
      sites: sitesOf(groups),
      expired: read.expired,
      skipped: read.skipped,
    };
  }

  /** Forgets the read list (Cancel, a new Read, the timeout, or after Import). */
  discard(scanId?: string): void {
    if (scanId !== undefined && this.#scan?.id !== scanId) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#scan = undefined;
  }

  /**
   * Writes the cookies of the ticked sites into Psyche's profile. A sensitive site (bank,
   * payment, passwords, email, sign-in provider) is written only when `sensitive` names it: the
   * window sends that list for rows the owner ticked one by one, and main refuses otherwise.
   */
  import(
    scanId: string,
    domains: readonly string[],
    sensitive: readonly string[] = [],
  ): Promise<CookieImportResult> {
    return this.#exclusive(() => this.#import(scanId, domains, sensitive));
  }

  async #import(
    scanId: string,
    domains: readonly string[],
    sensitive: readonly string[],
  ): Promise<CookieImportResult> {
    const held = this.#scan;
    if (held === undefined || held.id !== scanId || held.scan.expiresAt <= this.#now()) {
      this.discard();
      throw new PsycheError("not_found", "the list of sign-ins expired; read them again");
    }
    const wanted = [...new Set(domains.map((d) => d.toLowerCase()))];
    if (wanted.length === 0) throw new PsycheError("invalid_params", "no sites were picked");
    for (const d of wanted) {
      if (!DOMAIN.test(d) || !held.scan.groups.has(d)) {
        throw new PsycheError("invalid_params", "a picked site is not in the list");
      }
    }
    const named = new Set(sensitive.map((d) => d.toLowerCase()));
    for (const d of wanted) {
      const list = held.scan.groups.get(d) ?? [];
      if (siteSensitivity(hostsOf(list)) !== null && !named.has(d)) {
        throw new PsycheError("forbidden", "a sensitive site has to be picked on its own");
      }
    }
    const { browser, groups } = held.scan;
    // The record is written before the first cookie is: a crash can't lose it.
    const auditId = this.#queue.enqueue({
      action: "imported",
      browser,
      sites: wanted.sort().map((domain) => ({ domain, cookies: groups.get(domain)?.length ?? 0 })),
    });
    this.discard();
    const ses = this.#d.profile();
    const nowSeconds = Math.floor(this.#now() / 1000);
    const at = new Date(this.#now()).toISOString();
    const result: CookieImportResult = { sites: [], failed: 0 };
    const stored = this.#read();
    try {
      for (const domain of wanted) {
        const written: StoredCookie[] = [];
        for (const c of groups.get(domain) ?? []) {
          try {
            await ses.cookies.set(setDetails(c, nowSeconds));
            written.push({ host: c.host, path: c.path, name: c.name });
          } catch {
            result.failed += 1;
          }
        }
        if (written.length === 0) continue;
        result.sites.push({ domain, cookies: written.length });
        const prev = stored.find((s) => s.domain === domain);
        const merged = new Map<string, StoredCookie>();
        for (const c of [...(prev?.cookies ?? []), ...written]) merged.set(cookieKey(c), c);
        const site: StoredSite = { domain, browser, importedAt: at, cookies: [...merged.values()] };
        if (prev) stored.splice(stored.indexOf(prev), 1, site);
        else stored.push(site);
      }
      ses.flushStorageData();
      this.#write(stored);
    } finally {
      this.#queue.settle(auditId, { action: "imported", browser, sites: result.sites });
    }
    await this.#sendAudit();
    return result;
  }

  imported(): ImportedSite[] {
    return this.#read()
      .map((s) => ({
        domain: s.domain,
        browser: s.browser,
        cookies: s.cookies.length,
        importedAt: s.importedAt,
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }

  /**
   * "Remove imported sign-ins": deletes the cookies the import wrote for a site, matched by
   * name, domain and path exactly, and counts only what was really there. It is not a sign-out:
   * cookies the site issued since, under other names, stay (Signed-in sites → Forget does that).
   */
  remove(domain: string): Promise<number> {
    return this.#exclusive(() => this.#remove(domain));
  }

  async #remove(domain: string): Promise<number> {
    const d = domain.toLowerCase();
    const stored = this.#read();
    const site = stored.find((s) => s.domain === d);
    if (site === undefined) return 0;
    const auditId = this.#queue.enqueue({
      action: "removed",
      browser: site.browser,
      sites: [{ domain: d, cookies: site.cookies.length }],
    });
    const ses = this.#d.profile();
    let removed = 0;
    try {
      for (const c of site.cookies) {
        try {
          removed += await removeExact(ses, c);
        } catch {
          // Already gone.
        }
      }
      ses.flushStorageData();
      this.#write(stored.filter((s) => s !== site));
    } finally {
      this.#queue.settle(auditId, {
        action: "removed",
        browser: site.browser,
        sites: [{ domain: d, cookies: removed }],
      });
    }
    await this.#sendAudit();
    return removed;
  }

  dispose(): void {
    this.discard();
  }

  async #sendAudit(): Promise<void> {
    // The entry is already on disk; a Gateway that is down must not undo or fail the import.
    await this.flushAudit().catch(() => undefined);
  }

  #read(): StoredSite[] {
    try {
      const doc = JSON.parse(readFileSync(importedFile(this.#d.psycheHome), "utf8")) as {
        sites?: StoredSite[];
      };
      return Array.isArray(doc.sites)
        ? doc.sites.filter((s) => typeof s?.domain === "string" && Array.isArray(s.cookies))
        : [];
    } catch {
      return [];
    }
  }

  #write(sites: StoredSite[]): void {
    const file = importedFile(this.#d.psycheHome);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, sites }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
}

function cookieKey(c: StoredCookie): string {
  return `${c.host}\n${c.path}\n${c.name}`;
}

/** Keeps httpOnly, secure, sameSite and the expiry; host-only cookies stay host-only. */
export function setDetails(c: ImportCookie, nowSeconds: number): CookieSetDetails {
  return {
    url: `https://${c.host.replace(/^\./, "")}${c.path}`,
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expires ?? nowSeconds + SESSION_COOKIE_DAYS * 86_400,
    ...(c.host.startsWith(".") ? { domain: c.host } : {}),
  };
}

/**
 * Deletes one imported cookie and nothing else. `cookies.remove(url, name)` deletes every cookie
 * that would be sent to the url under that name (a parent domain's, a shorter path's), so the
 * cookies it would also take are put back. Returns 1 when the exact cookie was there.
 */
async function removeExact(ses: CookieSession, c: StoredCookie): Promise<number> {
  const url = `https://${c.host.replace(/^\./, "")}${c.path}`;
  const live = await ses.cookies.get({ url, name: c.name });
  const exact = live.some((x) => sameCookie(x, c));
  if (!exact) return 0;
  const others = live.filter((x) => !sameCookie(x, c));
  await ses.cookies.remove(url, c.name);
  for (const o of others) {
    const host = (o.domain ?? "").replace(/^\./, "");
    const path = o.path ?? "/";
    await ses.cookies
      .set({
        url: `https://${host}${path}`,
        name: o.name,
        value: o.value,
        path,
        ...(o.secure !== undefined ? { secure: o.secure } : {}),
        ...(o.httpOnly !== undefined ? { httpOnly: o.httpOnly } : {}),
        ...(o.sameSite !== undefined ? { sameSite: o.sameSite } : {}),
        ...(o.expirationDate !== undefined ? { expirationDate: o.expirationDate } : {}),
        ...((o.domain ?? "").startsWith(".") ? { domain: o.domain as string } : {}),
      })
      .catch(() => undefined);
  }
  return 1;
}

function sameCookie(x: CookieRecord, c: StoredCookie): boolean {
  return x.name === c.name && (x.domain ?? "") === c.host && (x.path ?? "/") === c.path;
}
