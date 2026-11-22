import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditQueueFile,
  CookieAuditQueue,
} from "../../src/main/browser/cookie-import/audit-queue.ts";
import {
  CookieImporter,
  type CookieImportRecord,
  importedFile,
} from "../../src/main/browser/cookie-import/importer.ts";
import {
  decryptChromiumValue,
  deriveChromiumKey,
} from "../../src/main/browser/cookie-import/read.ts";
import { cookieFileOf, listSources } from "../../src/main/browser/cookie-import/sources.ts";
import type {
  CookieRecord,
  CookieSession,
  CookieSetDetails,
} from "../../src/main/browser/promote-cookies.ts";
import {
  chromeRoot,
  encryptChromium,
  type FixtureCookie,
  firefoxRoot,
  SAFE_STORAGE_PASSWORD,
  writeChromiumDb,
  writeFirefoxDb,
  writeLocalState,
  writeProfilesIni,
} from "./cookie-import-fixtures.ts";

// No test may run `security` (a Keychain prompt) or any other process: the key is injected.
vi.mock("node:child_process", () => ({
  execFile: () => {
    throw new Error("cookie-import tests must not spawn processes (Keychain, sqlite3)");
  },
}));

const NOW = 1_800_000_000;
const DAY = 86_400;
/** Every cookie value in the fixtures: none may show up in a log, a result or the audit. */
const SECRET = (n: string) => `SECRETVALUE-${n}-9f3a`;

let home: string;
let psyche: string;
let tmpRoot: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-ci-home-"));
  psyche = mkdtempSync(join(tmpdir(), "psyche-ci-psyche-"));
  tmpRoot = mkdtempSync(join(tmpdir(), "psyche-ci-tmp-"));
});
afterEach(() => {
  for (const d of [home, psyche, tmpRoot]) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CHROME_COOKIES: FixtureCookie[] = [
  {
    host: ".github.com",
    name: "user_session",
    value: SECRET("gh"),
    expires: NOW + 30 * DAY,
    httpOnly: true,
    sameSite: 1,
  },
  { host: "github.com", name: "__Host-gh", value: SECRET("gh2"), expires: NOW + DAY, sameSite: 2 },
  { host: ".mail.google.com", name: "SID", value: SECRET("g1"), expires: NOW + DAY },
  { host: "accounts.google.com", name: "LSID", value: SECRET("g2"), sameSite: 0 },
  { host: ".evil-google.com", name: "SID", value: SECRET("evil"), expires: NOW + DAY },
  { host: ".chase.com", name: "auth", value: SECRET("bank"), expires: NOW + DAY, httpOnly: true },
  { host: "old.example.com", name: "gone", value: SECRET("old"), expires: NOW - 10 },
  {
    host: "embed.example.org",
    name: "chips",
    value: SECRET("chips"),
    expires: NOW + DAY,
    partition: "https://top.example",
  },
  { host: "plain.example.net", name: "p", value: SECRET("plain"), expires: NOW + DAY, plain: true },
];

function chromeFixture(): string {
  const root = chromeRoot(home);
  writeLocalState(root, { Default: "Personal", "Profile 1": "Work" });
  writeChromiumDb(join(root, "Default", "Network", "Cookies"), CHROME_COOKIES);
  // An older profile: `Cookies` at the top and DB version 18 (no host hash in the plaintext).
  writeChromiumDb(
    join(root, "Profile 1", "Cookies"),
    [{ host: ".work.example.com", name: "w", value: SECRET("work"), expires: NOW + DAY }],
    { version: 18, legacy: true },
  );
  return join(root, "Default", "Network", "Cookies");
}

function firefoxFixture(): void {
  const root = firefoxRoot(home);
  writeProfilesIni(root, [{ name: "default-release", path: "Profiles/abc.default-release" }]);
  writeFirefoxDb(join(root, "Profiles", "abc.default-release", "cookies.sqlite"), [
    { host: ".news.ycombinator.com", name: "user", value: SECRET("hn"), expires: NOW + DAY },
    { host: "bitwarden.com", name: "s", value: SECRET("bw"), expires: (NOW + DAY) * 1000 },
    { host: ".stale.example", name: "x", value: SECRET("stale"), expires: NOW - 1 },
    {
      host: ".container.example",
      name: "c",
      value: SECRET("container"),
      expires: NOW + DAY,
      partition: "^userContextId=2",
    },
    { host: "lax.example.com", name: "l", value: SECRET("lax"), expires: NOW + DAY, sameSite: 1 },
  ]);
}

interface Profile extends CookieSession {
  jar: CookieRecord[];
  set: CookieSetDetails[];
  removed: { url: string; name: string }[];
}

/** A jar like Electron's: `get` and `remove` by url and name match every cookie sent there. */
function profile(existing: CookieRecord[] = []): Profile {
  const set: CookieSetDetails[] = [];
  const removed: { url: string; name: string }[] = [];
  const jar: CookieRecord[] = [...existing];
  const sentTo = (c: CookieRecord, url: string, name: string | undefined) => {
    const u = new URL(url);
    const d = (c.domain ?? "").replace(/^\./, "");
    const hostOk = (c.domain ?? "").startsWith(".")
      ? u.hostname === d || u.hostname.endsWith(`.${d}`)
      : u.hostname === d;
    const path = c.path ?? "/";
    const pathOk =
      u.pathname === path || u.pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
    return hostOk && pathOk && (name === undefined || c.name === name);
  };
  return {
    set,
    removed,
    jar,
    cookies: {
      get: async (f) => jar.filter((c) => (f.url ? sentTo(c, f.url, f.name) : true)),
      set: async (d) => {
        if (d.name.startsWith("__Host-") && d.domain !== undefined) throw new Error("refused");
        set.push(d);
        const host = new URL(d.url).hostname;
        const rec: CookieRecord = { ...d, domain: d.domain ?? host, path: d.path ?? "/" };
        const i = jar.findIndex(
          (c) => c.name === rec.name && c.domain === rec.domain && c.path === rec.path,
        );
        if (i >= 0) jar.splice(i, 1);
        jar.push(rec);
      },
      remove: async (url, name) => {
        removed.push({ url, name });
        for (const c of jar.filter((x) => sentTo(x, url, name))) jar.splice(jar.indexOf(c), 1);
      },
    },
    flushStorageData: () => {},
  };
}

function importer(p: Profile, extra: { records?: CookieImportRecord[]; key?: string } = {}) {
  const readKeychain = vi.fn(
    async (_service: string, _account: string) => extra.key ?? SAFE_STORAGE_PASSWORD,
  );
  const imp = new CookieImporter({
    homeDir: home,
    psycheHome: psyche,
    tmpRoot,
    platform: "darwin",
    profile: () => p,
    readKeychain,
    record: async (e) => void extra.records?.push(e),
    nowMs: () => NOW * 1000,
  });
  return { imp, readKeychain };
}

describe("Chromium decryption", () => {
  it("decrypts v10 values, checks and drops the host hash from DB version 24", () => {
    const key = deriveChromiumKey(SAFE_STORAGE_PASSWORD);
    const v24 = encryptChromium("hello", ".a.com", 24, SAFE_STORAGE_PASSWORD);
    expect(decryptChromiumValue(v24, key, ".a.com", 24)).toBe("hello");
    // The hash binds the value to its host: moved to another host, it doesn't decrypt.
    expect(decryptChromiumValue(v24, key, ".b.com", 24)).toBeUndefined();
    const v18 = encryptChromium("old", ".a.com", 18, SAFE_STORAGE_PASSWORD);
    expect(decryptChromiumValue(v18, key, ".a.com", 18)).toBe("old");
    expect(decryptChromiumValue(v24, deriveChromiumKey("wrong"), ".a.com", 24)).toBeUndefined();
    expect(decryptChromiumValue(Buffer.from("v11abc"), key, ".a.com", 24)).toBeUndefined();
  });
});

describe("sources and profiles", () => {
  it("lists every browser, Chrome profiles with their names, and Safari as not supported", () => {
    chromeFixture();
    firefoxFixture();
    const s = listSources(home, "darwin");
    expect(s.map((x) => x.browser)).toEqual([
      "chrome",
      "brave",
      "edge",
      "arc",
      "firefox",
      "safari",
    ]);
    expect(s.find((x) => x.browser === "chrome")?.profiles).toEqual([
      { id: "Default", name: "Personal" },
      { id: "Profile 1", name: "Work" },
    ]);
    expect(s.find((x) => x.browser === "brave")).toMatchObject({ installed: false, profiles: [] });
    expect(s.find((x) => x.browser === "firefox")?.profiles).toEqual([
      { id: "Profiles/abc.default-release", name: "default-release" },
    ]);
    expect(s.find((x) => x.browser === "safari")).toMatchObject({
      supported: false,
      reason: "full_disk_access",
    });
  });

  it("is not supported off macOS", () => {
    chromeFixture();
    for (const x of listSources(home, "linux")) expect(x.supported).toBe(false);
  });

  it("only opens a profile from the listing, never a path the window made up", () => {
    chromeFixture();
    firefoxFixture();
    expect(cookieFileOf(home, "darwin", "chrome", "Default")).toBeDefined();
    for (const bad of ["../Default", "/etc", "Profile 9", "Default/../../x"]) {
      expect(cookieFileOf(home, "darwin", "chrome", bad), bad).toBeUndefined();
    }
    expect(cookieFileOf(home, "darwin", "firefox", "../../../etc")).toBeUndefined();
    expect(cookieFileOf(home, "darwin", "safari", "Default")).toBeUndefined();
  });

  it("refuses a Firefox profile path outside the Firefox folder", () => {
    const root = firefoxRoot(home);
    writeProfilesIni(root, [{ name: "escape", path: "../../outside" }]);
    writeFirefoxDb(join(home, "Library", "outside", "cookies.sqlite"), []);
    expect(listSources(home, "darwin").find((s) => s.browser === "firefox")?.profiles).toEqual([]);
  });
});

describe("cookie import", () => {
  it("reads a copy, groups by registrable domain and flags sensitive sites", async () => {
    const src = chromeFixture();
    const before = createHash("sha256").update(readFileSync(src)).digest("hex");
    const { imp, readKeychain } = importer(profile());
    const scan = await imp.scan("chrome", "Default");
    expect(readKeychain).toHaveBeenCalledWith("Chrome Safe Storage", "Chrome");
    expect(scan.sites.map((s) => [s.domain, s.cookies, s.sensitive])).toEqual([
      ["chase.com", 1, "bank"],
      ["evil-google.com", 1, null],
      ["example.net", 1, null],
      ["github.com", 2, "signin"],
      ["google.com", 2, "email"],
    ]);
    expect(scan.sites.find((s) => s.domain === "google.com")?.hosts).toEqual([
      "accounts.google.com",
      "mail.google.com",
    ]);
    // One expired, one partitioned.
    expect(scan.expired).toBe(1);
    expect(scan.skipped).toBe(1);
    // The source is untouched and the private copy is gone.
    expect(createHash("sha256").update(readFileSync(src)).digest("hex")).toBe(before);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("writes only the ticked sites, keeping httpOnly, secure, sameSite and expiry", async () => {
    chromeFixture();
    const p = profile();
    const records: CookieImportRecord[] = [];
    const { imp } = importer(p, { records });
    const scan = await imp.scan("chrome", "Default");
    const r = await imp.import(
      scan.scanId,
      ["github.com", "google.com"],
      ["github.com", "google.com"],
    );
    expect(r).toEqual({
      sites: [
        { domain: "github.com", cookies: 2 },
        { domain: "google.com", cookies: 2 },
      ],
      failed: 0,
    });
    expect(p.set.map((d) => d.name).sort()).toEqual(["LSID", "SID", "__Host-gh", "user_session"]);
    expect(p.set.find((d) => d.name === "user_session")).toEqual({
      url: "https://github.com/",
      domain: ".github.com",
      name: "user_session",
      value: SECRET("gh"),
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: NOW + 30 * DAY,
    });
    // Host-only stays host-only (no domain), so a __Host- cookie is accepted.
    const host = p.set.find((d) => d.name === "__Host-gh");
    expect(host?.domain).toBeUndefined();
    expect(host?.sameSite).toBe("strict");
    // A session cookie gets the profile's 30-day lifetime; SameSite=None stays none.
    const session = p.set.find((d) => d.name === "LSID");
    expect(session?.expirationDate).toBe(NOW + 30 * DAY);
    expect(session?.sameSite).toBe("no_restriction");
    expect(p.set.some((d) => d.value === SECRET("evil") || d.value === SECRET("bank"))).toBe(false);
    expect(records).toEqual([
      {
        action: "imported",
        browser: "chrome",
        sites: [
          { domain: "github.com", cookies: 2 },
          { domain: "google.com", cookies: 2 },
        ],
      },
    ]);
  });

  it("imports nothing by default and refuses sites that weren't read", async () => {
    chromeFixture();
    const p = profile();
    const { imp } = importer(p);
    const scan = await imp.scan("chrome", "Default");
    await expect(imp.import(scan.scanId, [])).rejects.toMatchObject({ code: "invalid_params" });
    // A lookalike of a listed domain, or a domain from another browser, is not in the list.
    for (const bad of ["github.com.evil.io", "work.example.com", "oogle.com"]) {
      await expect(imp.import(scan.scanId, [bad]), bad).rejects.toMatchObject({
        code: "invalid_params",
      });
    }
    expect(p.set).toEqual([]);
  });

  it("forgets the read list after import, on discard, on a new read and after the timeout", async () => {
    chromeFixture();
    let now = NOW * 1000;
    const p = profile();
    const imp = new CookieImporter({
      homeDir: home,
      psycheHome: psyche,
      tmpRoot,
      platform: "darwin",
      profile: () => p,
      readKeychain: async () => SAFE_STORAGE_PASSWORD,
      nowMs: () => now,
      scanTtlMs: 60_000,
    });
    const a = await imp.scan("chrome", "Default");
    await imp.import(a.scanId, ["github.com"], ["github.com"]);
    await expect(imp.import(a.scanId, ["google.com"], ["google.com"])).rejects.toMatchObject({
      code: "not_found",
    });
    const b = await imp.scan("chrome", "Default");
    imp.discard(b.scanId);
    await expect(imp.import(b.scanId, ["github.com"], ["github.com"])).rejects.toMatchObject({
      code: "not_found",
    });
    const c = await imp.scan("chrome", "Default");
    const d = await imp.scan("chrome", "Profile 1");
    await expect(imp.import(c.scanId, ["github.com"], ["github.com"])).rejects.toMatchObject({
      code: "not_found",
    });
    now += 61_000;
    await expect(imp.import(d.scanId, ["example.com"])).rejects.toMatchObject({
      code: "not_found",
    });
    imp.dispose();
  });

  it("reads an older Chromium profile and its plain values", async () => {
    chromeFixture();
    const p = profile();
    const { imp } = importer(p);
    const scan = await imp.scan("chrome", "Profile 1");
    expect(scan.sites.map((s) => s.domain)).toEqual(["example.com"]);
    await imp.import(scan.scanId, ["example.com"]);
    expect(p.set[0]?.value).toBe(SECRET("work"));
  });

  it("fails plainly with the wrong Keychain key and keeps nothing", async () => {
    chromeFixture();
    const p = profile();
    const { imp } = importer(p, { key: "not-the-key" });
    // The one plain-text cookie still reads, so the encrypted ones are counted as skipped.
    const scan = await imp.scan("chrome", "Default");
    expect(scan.sites.map((s) => s.domain)).toEqual(["example.net"]);
    expect(scan.skipped).toBe(7);
  });

  it("refuses when nothing decrypts", async () => {
    const root = chromeRoot(home);
    writeLocalState(root, { Default: "Personal" });
    writeChromiumDb(join(root, "Default", "Network", "Cookies"), [
      { host: ".a.com", name: "s", value: SECRET("a"), expires: NOW + DAY },
    ]);
    const { imp } = importer(profile(), { key: "not-the-key" });
    await expect(imp.scan("chrome", "Default")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reads Firefox in plain text: default container only, expired skipped, ms expiry", async () => {
    firefoxFixture();
    const p = profile();
    const { imp, readKeychain } = importer(p);
    const scan = await imp.scan("firefox", "Profiles/abc.default-release");
    expect(readKeychain).not.toHaveBeenCalled();
    expect(scan.sites.map((s) => [s.domain, s.sensitive])).toEqual([
      ["bitwarden.com", "passwords"],
      ["example.com", null],
      ["ycombinator.com", null],
    ]);
    expect(scan.expired).toBe(1);
    expect(scan.skipped).toBe(1);
    await imp.import(scan.scanId, ["bitwarden.com", "example.com"], ["bitwarden.com"]);
    expect(p.set.find((d) => d.name === "s")?.expirationDate).toBe(NOW + DAY);
    expect(p.set.find((d) => d.name === "l")?.sameSite).toBe("lax");
  });

  it("refuses a profile that isn't listed", async () => {
    chromeFixture();
    const { imp } = importer(profile());
    await expect(imp.scan("chrome", "../../../etc")).rejects.toMatchObject({ code: "not_found" });
    await expect(imp.scan("safari", "Default")).rejects.toMatchObject({ code: "not_found" });
  });

  it("Remove imported sign-ins deletes exactly what the import wrote", async () => {
    chromeFixture();
    const p = profile();
    const records: CookieImportRecord[] = [];
    const { imp } = importer(p, { records });
    const scan = await imp.scan("chrome", "Default");
    await imp.import(scan.scanId, ["github.com", "google.com"], ["github.com", "google.com"]);
    expect(imp.imported().map((s) => [s.domain, s.browser, s.cookies])).toEqual([
      ["github.com", "chrome", 2],
      ["google.com", "chrome", 2],
    ]);
    expect(await imp.remove("github.com")).toBe(2);
    expect(p.removed).toEqual(
      expect.arrayContaining([
        { url: "https://github.com/", name: "user_session" },
        { url: "https://github.com/", name: "__Host-gh" },
      ]),
    );
    expect(p.removed).toHaveLength(2);
    expect(imp.imported().map((s) => s.domain)).toEqual(["google.com"]);
    expect(records.at(-1)).toEqual({
      action: "removed",
      browser: "chrome",
      sites: [{ domain: "github.com", cookies: 2 }],
    });
    expect(await imp.remove("github.com")).toBe(0);
  });

  it("an audit that fails doesn't undo the import", async () => {
    chromeFixture();
    const p = profile();
    const imp = new CookieImporter({
      homeDir: home,
      psycheHome: psyche,
      tmpRoot,
      platform: "darwin",
      profile: () => p,
      readKeychain: async () => SAFE_STORAGE_PASSWORD,
      record: async () => {
        throw new Error("gateway down");
      },
      nowMs: () => NOW * 1000,
    });
    const scan = await imp.scan("chrome", "Default");
    expect((await imp.import(scan.scanId, ["github.com"], ["github.com"])).sites).toHaveLength(1);
    // The record is not lost: it waits in the queue for the Gateway.
    expect(imp.pendingAudit()).toBe(1);
  });

  it("no cookie value reaches a log, a result, the audit or the imported-sites file", async () => {
    chromeFixture();
    firefoxFixture();
    const captured: string[] = [];
    const grab = (...a: unknown[]) => void captured.push(a.map(String).join(" "));
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation(grab);
    }
    const out = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      captured.push(String(s));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      captured.push(String(s));
      return true;
    });
    const records: CookieImportRecord[] = [];
    const p = profile();
    const { imp } = importer(p, { records });
    const results: unknown[] = [imp.sources()];
    const chrome = await imp.scan("chrome", "Default");
    results.push(chrome);
    results.push(
      await imp.import(
        chrome.scanId,
        chrome.sites.map((s) => s.domain),
        chrome.sites.filter((s) => s.sensitive !== null).map((s) => s.domain),
      ),
    );
    const ff = await imp.scan("firefox", "Profiles/abc.default-release");
    results.push(ff);
    results.push(
      await imp.import(
        ff.scanId,
        ff.sites.map((s) => s.domain),
        ff.sites.filter((s) => s.sensitive !== null).map((s) => s.domain),
      ),
    );
    results.push(imp.imported());
    results.push(await imp.remove("github.com"));
    // Errors carry fixed strings.
    const wrong = importer(profile(), { key: "nope" }).imp;
    const root = chromeRoot(home);
    writeLocalState(root, { Default: "Personal", "Profile 1": "Work", "Profile 2": "Enc" });
    writeChromiumDb(join(root, "Profile 2", "Cookies"), [
      { host: ".z.com", name: "z", value: SECRET("z"), expires: NOW + DAY },
    ]);
    results.push(await wrong.scan("chrome", "Profile 2").catch((e: unknown) => String(e)));
    out.mockRestore();
    err.mockRestore();

    // The values did reach the profile: that is the one place they go.
    expect(p.set.some((d) => d.value === SECRET("gh"))).toBe(true);
    const outside = [
      ...captured,
      JSON.stringify(results),
      JSON.stringify(records),
      readFileSync(importedFile(psyche), "utf8"),
    ].join("\n");
    expect(outside).not.toMatch(/SECRETVALUE/);
    expect(outside).not.toContain(SAFE_STORAGE_PASSWORD);
    // The audit records carry only domains and counts.
    for (const r of records) {
      expect(Object.keys(r).sort()).toEqual(["action", "browser", "sites"]);
      for (const s of r.sites) expect(Object.keys(s).sort()).toEqual(["cookies", "domain"]);
    }
  });

  it("the imported-sites file is private and holds no values", async () => {
    chromeFixture();
    const { imp } = importer(profile());
    const scan = await imp.scan("chrome", "Default");
    await imp.import(scan.scanId, ["github.com"], ["github.com"]);
    const file = importedFile(psyche);
    const { statSync } = await import("node:fs");
    expect(statSync(file).mode & 0o077).toBe(0);
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      sites: { cookies: Record<string, unknown>[] }[];
    };
    for (const c of doc.sites[0]?.cookies ?? []) {
      expect(Object.keys(c).sort()).toEqual(["host", "name", "path"]);
    }
  });

  it("ignores a corrupt imported-sites file", async () => {
    mkdirSync(join(psyche, "browser"), { recursive: true });
    writeFileSync(importedFile(psyche), "{not json");
    const { imp } = importer(profile());
    expect(imp.imported()).toEqual([]);
  });
});

// ── Review r1 on #1508 ──────────────────────────────────────────────────────────────────

describe("local audit queue", () => {
  const queueFile = () => auditQueueFile(psyche);

  it("writes the record before the first cookie, and keeps it when the Gateway is down", async () => {
    chromeFixture();
    const p = profile();
    let queuedAtFirstWrite: string | undefined;
    const set = p.cookies.set;
    p.cookies.set = async (d) => {
      queuedAtFirstWrite ??= existsSync(queueFile()) ? readFileSync(queueFile(), "utf8") : "";
      return set(d);
    };
    const imp = new CookieImporter({
      homeDir: home,
      psycheHome: psyche,
      tmpRoot,
      platform: "darwin",
      profile: () => p,
      readKeychain: async () => SAFE_STORAGE_PASSWORD,
      record: async () => {
        throw new Error("gateway down");
      },
      nowMs: () => NOW * 1000,
    });
    const scan = await imp.scan("chrome", "Default");
    const r = await imp.import(scan.scanId, ["github.com"], ["github.com"]);
    expect(r.sites).toEqual([{ domain: "github.com", cookies: 2 }]);
    expect(queuedAtFirstWrite).toContain('"github.com"');
    expect(imp.pendingAudit()).toBe(1);
    // The file is private, and holds no value, cookie name or path.
    expect(statSync(queueFile()).mode & 0o077).toBe(0);
    const text = readFileSync(queueFile(), "utf8");
    expect(text).not.toMatch(/SECRETVALUE|user_session|__Host-gh/);
    expect(text).not.toContain(SAFE_STORAGE_PASSWORD);
    expect(readdirSync(join(psyche, "browser")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("flushes once the Gateway answers, in order, and deletes an entry only after ok", async () => {
    chromeFixture();
    const p = profile();
    const sent: CookieImportRecord[] = [];
    let up = false;
    const make = () =>
      new CookieImporter({
        homeDir: home,
        psycheHome: psyche,
        tmpRoot,
        platform: "darwin",
        profile: () => p,
        readKeychain: async () => SAFE_STORAGE_PASSWORD,
        record: async (e) => {
          if (!up) throw new Error("gateway down");
          sent.push(e);
        },
        nowMs: () => NOW * 1000,
      });
    const imp = make();
    const a = await imp.scan("chrome", "Default");
    await imp.import(a.scanId, ["github.com"], ["github.com"]);
    await imp.remove("github.com");
    expect(imp.pendingAudit()).toBe(2);
    expect(sent).toEqual([]);

    // A restart: a new importer finds the queue on disk, and the connect flushes it.
    up = true;
    const again = make();
    expect(again.pendingAudit()).toBe(2);
    expect(await again.flushAudit()).toBe(2);
    expect(sent.map((e) => e.action)).toEqual(["imported", "removed"]);
    expect(again.pendingAudit()).toBe(0);
    // Sent once only.
    expect(await again.flushAudit()).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("stops at the first failure and keeps that entry and the rest", async () => {
    const q = new CookieAuditQueue(psyche);
    for (const domain of ["a.example", "b.example", "c.example"]) {
      q.settle(q.enqueue({ action: "imported", browser: "chrome", sites: [] }), {
        action: "imported",
        browser: "chrome",
        sites: [{ domain, cookies: 1 }],
      });
    }
    const seen: string[] = [];
    const n = await q.flush(async (e) => {
      seen.push(e.sites[0]?.domain ?? "");
      if (e.sites[0]?.domain === "b.example") throw new Error("down");
    });
    expect(n).toBe(1);
    expect(seen).toEqual(["a.example", "b.example"]);
    expect(q.pending()).toBe(2);
    const rest: string[] = [];
    await q.flush(async (e) => void rest.push(e.sites[0]?.domain ?? ""));
    expect(rest).toEqual(["b.example", "c.example"]);
  });

  it("sends nothing without a record sender (a remote Gateway), and the import still goes ahead", async () => {
    chromeFixture();
    const p = profile();
    const imp = new CookieImporter({
      homeDir: home,
      psycheHome: psyche,
      tmpRoot,
      platform: "darwin",
      profile: () => p,
      readKeychain: async () => SAFE_STORAGE_PASSWORD,
      nowMs: () => NOW * 1000,
    });
    const scan = await imp.scan("chrome", "Default");
    expect((await imp.import(scan.scanId, ["github.com"], ["github.com"])).sites).toHaveLength(1);
    expect(await imp.flushAudit()).toBe(0);
    expect(imp.pendingAudit()).toBe(1);
  });

  it("is bounded: a full queue refuses the record before any cookie is written", () => {
    const q = new CookieAuditQueue(psyche, { max: 2 });
    q.enqueue({ action: "imported", browser: "chrome", sites: [] });
    q.enqueue({ action: "imported", browser: "chrome", sites: [] });
    expect(() => q.enqueue({ action: "imported", browser: "chrome", sites: [] })).toThrow(
      /waiting for the Gateway/,
    );
  });

  it("keeps only domains and counts, and drops an entry that recorded nothing", () => {
    const q = new CookieAuditQueue(psyche);
    q.settle(
      q.enqueue({
        action: "imported",
        browser: "chrome",
        sites: [
          { domain: "ok.example", cookies: 2 },
          { domain: "bad domain/with spaces", cookies: 1 },
        ],
      }),
      undefined,
    );
    expect(q.pending()).toBe(0);
    q.enqueue({
      action: "imported",
      browser: "chrome",
      sites: [
        { domain: "ok.example", cookies: 2 },
        { domain: "bad domain/with spaces", cookies: 1 },
      ],
    });
    expect(readFileSync(auditQueueFile(psyche), "utf8")).not.toContain("with spaces");
  });

  it("keeps an unreadable queue file aside instead of throwing the record away", () => {
    mkdirSync(join(psyche, "browser"), { recursive: true });
    writeFileSync(auditQueueFile(psyche), "{not json");
    const q = new CookieAuditQueue(psyche);
    expect(q.pending()).toBe(0);
    expect(readdirSync(join(psyche, "browser")).some((n) => n.includes(".corrupt-"))).toBe(true);
  });

  it("refuses an entry that would pass the byte cap, and leaves the file as it was", () => {
    const q = new CookieAuditQueue(psyche);
    const big = (n: number) => ({
      action: "imported" as const,
      browser: "chrome" as const,
      sites: Array.from({ length: 5000 }, (_, i) => ({
        domain: `${"a".repeat(200)}${n}-${i}.example`,
        cookies: 1,
      })),
    });
    let before = "";
    let threw = false;
    for (let n = 0; n < 40 && !threw; n++) {
      try {
        q.enqueue(big(n));
        before = readFileSync(auditQueueFile(psyche), "utf8");
      } catch {
        threw = true;
      }
    }
    expect(threw).toBe(true);
    expect(readFileSync(auditQueueFile(psyche), "utf8")).toBe(before);
    expect(readdirSync(join(psyche, "browser")).some((n) => n.includes(".corrupt-"))).toBe(false);
    expect(q.pending()).toBeGreaterThan(0);
  });

  it("an unreadable file is not renamed aside, and loses no entry", () => {
    const q = new CookieAuditQueue(psyche);
    q.settle(
      q.enqueue({
        action: "imported",
        browser: "chrome",
        sites: [{ domain: "a.example", cookies: 1 }],
      }),
      {
        action: "imported",
        browser: "chrome",
        sites: [{ domain: "a.example", cookies: 1 }],
      },
    );
    // A directory where the file is: readFileSync fails with EISDIR, a stand-in for EIO.
    const file = auditQueueFile(psyche);
    const kept = readFileSync(file, "utf8");
    renameSync(file, `${file}.hold`);
    mkdirSync(file);
    expect(q.pending()).toBe(0);
    expect(() => q.enqueue({ action: "imported", browser: "chrome", sites: [] })).toThrow();
    expect(readdirSync(join(psyche, "browser")).some((n) => n.includes(".corrupt-"))).toBe(false);
    rmdirSync(file);
    renameSync(`${file}.hold`, file);
    expect(readFileSync(file, "utf8")).toBe(kept);
    expect(q.pending()).toBe(1);
  });

  it("flushes the valid entries of a .corrupt-* file", async () => {
    const q = new CookieAuditQueue(psyche);
    q.settle(
      q.enqueue({
        action: "imported",
        browser: "chrome",
        sites: [{ domain: "a.example", cookies: 1 }],
      }),
      {
        action: "imported",
        browser: "chrome",
        sites: [{ domain: "a.example", cookies: 1 }],
      },
    );
    const file = auditQueueFile(psyche);
    renameSync(file, `${file}.corrupt-1`);
    const got: string[] = [];
    expect(await q.flush(async (r) => void got.push(r.sites[0]?.domain ?? ""))).toBe(1);
    expect(got).toEqual(["a.example"]);
    expect(readdirSync(join(psyche, "browser")).some((n) => n.includes(".corrupt-"))).toBe(false);
  });
});

describe("sensitive sites are gated in main", () => {
  it("refuses a sensitive site that the call doesn't name, and writes nothing, not even a record", async () => {
    chromeFixture();
    const p = profile();
    const { imp } = importer(p);
    const scan = await imp.scan("chrome", "Default");
    await expect(imp.import(scan.scanId, ["chase.com"])).rejects.toMatchObject({
      code: "forbidden",
    });
    // Naming a different site doesn't cover it; select-all style picks are refused too.
    await expect(
      imp.import(scan.scanId, ["chase.com", "example.net"], ["example.net"]),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      imp.import(
        scan.scanId,
        scan.sites.map((s) => s.domain),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(p.set).toEqual([]);
    expect(imp.pendingAudit()).toBe(0);
    // The read list is still there for the owner to tick it one by one.
    expect((await imp.import(scan.scanId, ["chase.com"], ["chase.com"])).sites).toEqual([
      { domain: "chase.com", cookies: 1 },
    ]);
  });

  it("an ordinary site needs no naming", async () => {
    chromeFixture();
    const { imp } = importer(profile());
    const scan = await imp.scan("chrome", "Default");
    expect((await imp.import(scan.scanId, ["example.net"])).sites).toHaveLength(1);
  });
});

describe("Remove imported sign-ins", () => {
  const seedList = (cookies: { host: string; path: string; name: string }[]) => {
    mkdirSync(join(psyche, "browser"), { recursive: true });
    writeFileSync(
      importedFile(psyche),
      JSON.stringify({
        version: 1,
        sites: [
          { domain: "example.com", browser: "chrome", importedAt: "2026-11-01T00:00:00Z", cookies },
        ],
      }),
    );
  };

  it("removes only the exact cookie and puts back the parent's cookie it would also take", async () => {
    const p = profile([
      { name: "sid", value: "mine", domain: "a.example.com", path: "/x" },
      { name: "sid", value: "parent", domain: ".example.com", path: "/", secure: true },
    ]);
    seedList([{ host: "a.example.com", path: "/x", name: "sid" }]);
    const { imp } = importer(p);
    expect(await imp.remove("example.com")).toBe(1);
    expect(p.jar.map((c) => [c.domain, c.path, c.value])).toEqual([
      [".example.com", "/", "parent"],
    ]);
    expect(imp.imported()).toEqual([]);
  });

  it("counts only what was there, not every cookie it tried", async () => {
    // One of the imported cookies was already gone; a parent's cookie of another name is not
    // the imported one and is neither counted nor removed.
    const p = profile([
      { name: "kept", value: "v", domain: "a.example.com", path: "/" },
      { name: "sid", value: "parent", domain: ".example.com", path: "/" },
    ]);
    seedList([
      { host: "a.example.com", path: "/", name: "kept" },
      { host: "a.example.com", path: "/", name: "gone" },
      { host: "b.example.com", path: "/", name: "sid" },
    ]);
    const { imp } = importer(p);
    expect(await imp.remove("example.com")).toBe(1);
    expect(p.jar.map((c) => c.name)).toEqual(["sid"]);
  });

  it("runs after an import that is still writing, so the list never loses an update", async () => {
    chromeFixture();
    const p = profile();
    const set = p.cookies.set;
    p.cookies.set = async (d) => {
      await new Promise((r) => setTimeout(r, 5));
      return set(d);
    };
    const { imp } = importer(p);
    const scan = await imp.scan("chrome", "Default");
    const importing = imp.import(scan.scanId, ["github.com"], ["github.com"]);
    // Remove starts while the import is still writing: it waits and then removes those cookies.
    const removing = imp.remove("github.com");
    await importing;
    expect(await removing).toBe(2);
    expect(imp.imported()).toEqual([]);
    expect(p.jar).toEqual([]);
  });
});

describe("temp copies", () => {
  it("makes every copy private, sidecars too, and sweeps what a crash left behind", async () => {
    const root = firefoxRoot(home);
    writeProfilesIni(root, [{ name: "default-release", path: "Profiles/abc.default-release" }]);
    const file = join(root, "Profiles", "abc.default-release", "cookies.sqlite");
    writeFirefoxDb(file, [{ host: "x.example.net", name: "a", value: "v", expires: NOW + DAY }]);
    writeFileSync(`${file}-wal`, "wal");
    chmodSync(`${file}-wal`, 0o644);
    const { copyDatabase } = await import("../../src/main/browser/cookie-import/read.ts");
    const { dir, copy } = copyDatabase(file, tmpRoot);
    for (const f of [copy, `${copy}-wal`]) expect(statSync(f).mode & 0o077, f).toBe(0);
    rmSync(dir, { recursive: true, force: true });

    // A copy left by a crashed run is swept when the importer is made; other folders stay.
    mkdirSync(join(tmpRoot, "psyche-cookie-import-crashed"));
    writeFileSync(join(tmpRoot, "psyche-cookie-import-crashed", "cookies.db"), "plaintext");
    mkdirSync(join(tmpRoot, "unrelated"));
    importer(profile());
    expect(readdirSync(tmpRoot)).toEqual(["unrelated"]);
  });
});
