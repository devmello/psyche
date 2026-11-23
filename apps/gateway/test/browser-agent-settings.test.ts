import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetting } from "@psyche/db";
import { normalizeBrowserOrigin, normalizeDevPreviewPort } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveSignedInSites,
  normalizeBrowserAgentSetting,
  resolveBrowserAgentSettings,
} from "../src/compose/browser-agent-settings.ts";
import {
  type ComposedBrowser,
  type ComposedGateway,
  type ComposeServices,
  composeBrowser,
  composeGateway,
} from "../src/compose/index.ts";
import { needsPresence } from "../src/handlers/settings.ts";
import { isNarrowing } from "../src/handlers/settings-narrowing.ts";
import { silentLogger } from "../src/log.ts";
import { isSecuritySettingKey } from "../src/security/seal-spec.ts";
import { adminClient } from "./helpers.ts";

/**
 * Settings → Browser: the agent browser's sign-in mode, signed-in sites and dev-preview ports.
 * Validation refuses what the owner should not be able to widen the agent with; a widening change
 * needs presence, a narrowing one applies at once; an env var overrides the stored value.
 */

const PARTITION = "browser.partition";
const ORIGINS = "browser.signedInOrigins";
const PORTS = "browser.devPreviewPorts";

describe("origin validation", () => {
  it.each([
    ["https://Example.com", "https://example.com"],
    ["https://example.com/", "https://example.com"],
    ["https://example.com:8443", "https://example.com:8443"],
    ["https://example.com:443", "https://example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://[::1]:5173", "http://[::1]:5173"],
  ])("accepts %s as %s", (raw, origin) => {
    expect(normalizeBrowserOrigin(raw)).toEqual({ ok: true, origin });
  });

  it.each([
    ["http://example.com", "scheme"],
    ["ftp://example.com", "scheme"],
    ["*.example.com", "wildcard"],
    ["https://*", "wildcard"],
    ["https://example.com/login", "path"],
    ["https://example.com?next=1", "path"],
    ["https://example.com#top", "path"],
    ["https://user@example.com", "credentials"],
    ["https://user:@example.com", "credentials"],
    ["https://example.com:0", "port"],
    ["https://example.com:65536", "port"],
    ["", "empty"],
    [42, "not_text"],
    ["not a url", "not_url"],
    // Empty labels: the browser's origin parser throws on these, so they are never stored.
    ["https://a..b", "host"],
    ["https://x.com..", "host"],
    ["https://.x.com", "host"],
    ["https://x.com.", "host"],
    [`https://${"a".repeat(195)}.com`, "too_long"],
  ])("refuses %s (%s)", (raw, reason) => {
    expect(normalizeBrowserOrigin(raw)).toEqual({ ok: false, reason });
  });

  it.each([
    [1, true],
    [5173, true],
    [65535, true],
    [0, false],
    [65536, false],
    [1.5, false],
    ["5173", false],
    [Number.NaN, false],
  ])("dev preview port %s ok=%s", (port, ok) => {
    expect(normalizeDevPreviewPort(port).ok).toBe(ok);
  });
});

describe("setting values written with settings.set", () => {
  it("stores normalised origins and sorted, unique ports", () => {
    expect(
      normalizeBrowserAgentSetting(ORIGINS, ["https://B.example", "https://b.example/"], {}),
    ).toEqual(["https://b.example"]);
    expect(normalizeBrowserAgentSetting(PORTS, [5173, 3000, 5173], {})).toEqual([3000, 5173]);
  });

  it("refuses a bad origin, an unknown mode and a bad port", () => {
    expect(() => normalizeBrowserAgentSetting(ORIGINS, ["http://example.com"], {})).toThrow();
    expect(() => normalizeBrowserAgentSetting(PARTITION, "everything", {})).toThrow();
    expect(() => normalizeBrowserAgentSetting(PORTS, [0], {})).toThrow();
  });

  it("caps writes at 200 sites and 64 ports, to match the result schema", () => {
    const sites = Array.from({ length: 200 }, (_v, i) => `https://s${i}.example`);
    expect(normalizeBrowserAgentSetting(ORIGINS, sites, {})).toHaveLength(200);
    expect(() =>
      normalizeBrowserAgentSetting(ORIGINS, [...sites, "https://more.example"], {}),
    ).toThrow(/At most 200/);
    const ports = Array.from({ length: 64 }, (_v, i) => i + 1);
    expect(normalizeBrowserAgentSetting(PORTS, ports, {})).toHaveLength(64);
    expect(() => normalizeBrowserAgentSetting(PORTS, [...ports, 65], {})).toThrow(/At most 64/);
  });

  it.each(["https://a..b", "https://x.com.."])("refuses the origin %s on write", (bad) => {
    expect(() => normalizeBrowserAgentSetting(ORIGINS, [bad], {})).toThrow();
  });

  it("refuses a key an environment variable sets", () => {
    expect(() =>
      normalizeBrowserAgentSetting(PARTITION, "clean", { PSYCHE_BROWSER_PARTITION: "auto" }),
    ).toThrow(/PSYCHE_BROWSER_PARTITION/);
  });
});

describe("widening is gated, narrowing is not", () => {
  it.each([
    ["mode toward profile", PARTITION, "auto", "profile"],
    ["mode from default to profile", PARTITION, undefined, "profile"],
    ["mode clean to auto", PARTITION, "clean", "auto"],
    [
      "add a signed-in site",
      ORIGINS,
      ["https://a.example"],
      ["https://a.example", "https://b.example"],
    ],
    ["first signed-in site", ORIGINS, undefined, ["https://a.example"]],
    ["add a dev port", PORTS, [3000], [3000, 5173]],
  ])("%s asks for presence", (_name, key, stored, next) => {
    expect(needsPresence(key)).toBe(true);
    expect(isNarrowing(key, stored, next)).toBe(false);
  });

  it.each([
    ["mode toward clean", PARTITION, "profile", "clean"],
    ["mode toward clean from the default", PARTITION, undefined, "clean"],
    [
      "remove a signed-in site",
      ORIGINS,
      ["https://a.example", "https://b.example"],
      ["https://a.example"],
    ],
    ["clear the signed-in sites", ORIGINS, ["https://a.example"], []],
    ["remove a dev port", PORTS, [3000, 5173], [5173]],
  ])("%s applies at once", (_name, key, stored, next) => {
    expect(isNarrowing(key, stored, next)).toBe(true);
  });

  it("puts every browser key in the sealed security settings", () => {
    for (const key of [PARTITION, ORIGINS, PORTS]) expect(isSecuritySettingKey(key)).toBe(true);
    expect(needsPresence("browser.realChrome")).toBe(false);
  });
});

describe("stored values, environment precedence and live use", () => {
  let home = "";
  let composed: ComposedGateway | null = null;
  afterEach(async () => {
    await composed?.stop("test");
    composed = null;
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  async function compose(): Promise<{ services: ComposeServices; browser: ComposedBrowser }> {
    home = mkdtempSync(join(tmpdir(), "psyche-browser-agent-"));
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 9), { mode: 0o600 });
    let services: ComposeServices | undefined;
    let browser: ComposedBrowser | undefined;
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
      parts: [
        (s) => {
          services = s;
          browser = composeBrowser(s, {
            socketPath: false,
            // The same getters compose/parts.ts passes: read on every use.
            signedInOrigins: () => resolveBrowserAgentSettings(s.db, {}).signedInOrigins.value,
            ownerDevPorts: () => resolveBrowserAgentSettings(s.db, {}).devPreviewPorts.value,
          });
          return browser;
        },
      ],
    } as Parameters<typeof composeGateway>[0]);
    if (services === undefined || browser === undefined) throw new Error("not composed");
    return { services, browser };
  }

  it("uses the stored value, then the default, when no env var is set", async () => {
    const { services } = await compose();
    expect(resolveBrowserAgentSettings(services.db, {}).partition).toEqual({
      value: "auto",
      source: "default",
    });
    setSetting(services.db, PARTITION, "clean");
    setSetting(services.db, ORIGINS, ["https://a.example"]);
    expect(resolveBrowserAgentSettings(services.db, {})).toMatchObject({
      partition: { value: "clean", source: "setting" },
      signedInOrigins: { value: ["https://a.example"], source: "setting" },
    });
  });

  it("browser.settings.get returns the effective list with each entry's source", async () => {
    const { services } = await compose();
    const c = composed as ComposedGateway;
    mkdirSync(join(home, "browser"), { recursive: true });
    writeFileSync(
      join(home, "browser", "signed-in.json"),
      JSON.stringify({ sites: [{ origin: "https://canvas.ucsc.edu", hosts: [], addedAt: "x" }] }),
    );
    writeFileSync(
      join(home, "browser", "detected-sessions.json"),
      JSON.stringify({ domains: ["ucsc.edu", "github.com"] }),
    );
    setSetting(services.db, ORIGINS, ["https://a.example"]);
    const owner = await adminClient(c.gateway);
    try {
      const got = await owner.call<{
        signedInSites: { origin: string; source: string }[];
        useSignedInSessions: boolean;
      }>("browser.settings.get", {});
      expect(got.useSignedInSessions).toBe(true);
      expect(got.signedInSites).toEqual([
        { origin: "https://a.example", source: "setting" },
        { origin: "https://canvas.ucsc.edu", source: "stay_signed_in" },
        { origin: "https://github.com", source: "detected" },
      ]);
      setSetting(services.db, "browser.useSignedInSessions", false);
      const off = await owner.call<{ signedInSites: { source: string }[] }>(
        "browser.settings.get",
        {},
      );
      expect(off.signedInSites.map((s) => s.source)).toEqual(["setting", "stay_signed_in"]);
    } finally {
      owner.close();
    }
  });

  it("an environment variable wins over the stored value and is reported as env", async () => {
    const { services } = await compose();
    setSetting(services.db, PARTITION, "clean");
    setSetting(services.db, PORTS, [3000]);
    const env = {
      PSYCHE_BROWSER_PARTITION: "profile",
      PSYCHE_DEV_PREVIEW_PORTS: "5173, 8080",
    };
    expect(resolveBrowserAgentSettings(services.db, env)).toMatchObject({
      partition: { value: "profile", source: "env" },
      devPreviewPorts: { value: [5173, 8080], source: "env" },
    });
    expect(() => normalizeBrowserAgentSetting(PARTITION, "clean", env)).toThrow();
  });

  it("a dev-preview port added in Settings is allowed by the next check, without a restart", async () => {
    const { services, browser } = await compose();
    const owned = async () =>
      (await browser.devServers.list()).filter((s) => s.source === "owner").map((s) => s.port);
    expect(await owned()).toEqual([]);
    setSetting(services.db, PORTS, [5173]);
    expect(await owned()).toEqual([5173]);
    setSetting(services.db, PORTS, []);
    expect(await owned()).toEqual([]);
  });
});

describe("the one list of signed-in sites", () => {
  it("merges the setting, Stay signed in and detected sites, each origin once with its source", () => {
    expect(
      effectiveSignedInSites({
        settingOrigins: ["https://a.example", "https://both.example"],
        stayOrigins: ["https://both.example", "https://canvas.ucsc.edu"],
        detectedDomains: ["ucsc.edu", "github.com"],
        useDetected: true,
      }),
    ).toEqual([
      { origin: "https://a.example", source: "setting" },
      { origin: "https://both.example", source: "setting" },
      { origin: "https://canvas.ucsc.edu", source: "stay_signed_in" },
      // ucsc.edu is already listed through its Stay-signed-in site, so it is not listed twice.
      { origin: "https://github.com", source: "detected" },
    ]);
  });

  it("leaves detected sites out while 'Let Psyche use my signed-in sessions' is off", () => {
    const input = {
      settingOrigins: [],
      stayOrigins: ["https://canvas.ucsc.edu"],
      detectedDomains: ["github.com"],
    };
    expect(effectiveSignedInSites({ ...input, useDetected: false })).toEqual([
      { origin: "https://canvas.ucsc.edu", source: "stay_signed_in" },
    ]);
    expect(effectiveSignedInSites({ ...input, useDetected: true })).toHaveLength(2);
  });
});
