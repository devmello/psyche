import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import {
  type CookieSession,
  type CookieSetDetails,
  SESSION_COOKIE_DAYS,
} from "../promote-cookies.ts";
import { groupByDomain, type ImportSite, sitesOf } from "./domains.ts";
import {
  deriveChromiumKey,
  type ImportCookie,
  type ReadResult,
  readChromiumCookies,
  readFirefoxCookies,
  type SqliteQuery,
} from "./read.ts";
import {
  cookieFileOf,
  type ImportBrowser,
  type ImportSource,
  isChromium,
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
  readKeychain: (service: string) => Promise<string>;
  /** Writes the audit entry (the Gateway's `browser.cookieImport.record`). */
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
  /** One read list at a time: a new Read replaces the old one. */
  #scan: { id: string; scan: Scan } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: CookieImportDeps) {
    this.#d = deps;
    this.#now = deps.nowMs ?? Date.now;
    this.#ttl = deps.scanTtlMs ?? 10 * 60_000;
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
      const password = await this.#d.readKeychain(keychainServiceOf(browser));
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

  /** Writes the cookies of the ticked sites into Psyche's profile. */
  async import(scanId: string, domains: readonly string[]): Promise<CookieImportResult> {
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
    const { browser, groups } = held.scan;
    this.discard();
    const ses = this.#d.profile();
    const nowSeconds = Math.floor(this.#now() / 1000);
    const at = new Date(this.#now()).toISOString();
    const result: CookieImportResult = { sites: [], failed: 0 };
    const stored = this.#read();
    for (const domain of wanted.sort()) {
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
    if (result.sites.length > 0) {
      await this.#audit({ action: "imported", browser, sites: result.sites });
    }
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

  /** "Remove imported sign-ins": deletes exactly the cookies the import wrote for a site. */
  async remove(domain: string): Promise<number> {
    const d = domain.toLowerCase();
    const stored = this.#read();
    const site = stored.find((s) => s.domain === d);
    if (site === undefined) return 0;
    const ses = this.#d.profile();
    let removed = 0;
    for (const c of site.cookies) {
      try {
        await ses.cookies.remove(`https://${c.host.replace(/^\./, "")}${c.path}`, c.name);
        removed += 1;
      } catch {
        // Already gone.
      }
    }
    ses.flushStorageData();
    this.#write(stored.filter((s) => s !== site));
    await this.#audit({
      action: "removed",
      browser: site.browser,
      sites: [{ domain: d, cookies: removed }],
    });
    return removed;
  }

  dispose(): void {
    this.discard();
  }

  async #audit(entry: CookieImportRecord): Promise<void> {
    // The import already happened; a Gateway that is down must not undo or fail it.
    await this.#d.record?.(entry).catch(() => undefined);
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
