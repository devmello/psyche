import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  set: CookieSetDetails[];
  removed: { url: string; name: string }[];
}

function profile(existing: CookieRecord[] = []): Profile {
  const set: CookieSetDetails[] = [];
  const removed: { url: string; name: string }[] = [];
  return {
    set,
    removed,
    cookies: {
      get: async () => [...existing],
      set: async (d) => {
        if (d.name.startsWith("__Host-") && d.domain !== undefined) throw new Error("refused");
        set.push(d);
      },
      remove: async (url, name) => {
        removed.push({ url, name });
      },
    },
    flushStorageData: () => {},
  };
}

function importer(p: Profile, extra: { records?: CookieImportRecord[]; key?: string } = {}) {
  const readKeychain = vi.fn(async (_service: string) => extra.key ?? SAFE_STORAGE_PASSWORD);
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
    expect(readKeychain).toHaveBeenCalledWith("Chrome Safe Storage");
    expect(scan.sites.map((s) => [s.domain, s.cookies, s.sensitive])).toEqual([
      ["chase.com", 1, "bank"],
      ["evil-google.com", 1, null],
      ["example.net", 1, null],
      ["github.com", 2, null],
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
    const r = await imp.import(scan.scanId, ["github.com", "google.com"]);
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
    await imp.import(a.scanId, ["github.com"]);
    await expect(imp.import(a.scanId, ["google.com"])).rejects.toMatchObject({ code: "not_found" });
    const b = await imp.scan("chrome", "Default");
    imp.discard(b.scanId);
    await expect(imp.import(b.scanId, ["github.com"])).rejects.toMatchObject({ code: "not_found" });
    const c = await imp.scan("chrome", "Default");
    const d = await imp.scan("chrome", "Profile 1");
    await expect(imp.import(c.scanId, ["github.com"])).rejects.toMatchObject({ code: "not_found" });
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
    await imp.import(scan.scanId, ["bitwarden.com", "example.com"]);
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
    await imp.import(scan.scanId, ["github.com", "google.com"]);
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
    expect((await imp.import(scan.scanId, ["github.com"])).sites).toHaveLength(1);
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
      ),
    );
    const ff = await imp.scan("firefox", "Profiles/abc.default-release");
    results.push(ff);
    results.push(
      await imp.import(
        ff.scanId,
        ff.sites.map((s) => s.domain),
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
    await imp.import(scan.scanId, ["github.com"]);
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
