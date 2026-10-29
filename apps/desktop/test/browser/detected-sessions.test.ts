import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectedFile,
  detectSessions,
  forgetDetected,
  refreshDetected,
} from "../../src/main/browser/detected-sessions.ts";
import type { CookieRecord, CookieSession } from "../../src/main/browser/promote-cookies.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-detected-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function jar(initial: CookieRecord[]): CookieSession & { all: CookieRecord[] } {
  const state = { all: [...initial] };
  return {
    get all() {
      return state.all;
    },
    cookies: {
      get: async () => [...state.all],
      set: async () => {},
      remove: async (url, name) => {
        const host = new URL(url).hostname;
        state.all = state.all.filter(
          (c) => !(c.name === name && (c.domain === host || c.domain === `.${host}`)),
        );
      },
    },
    flushStorageData: () => {},
  };
}

const NOW = 1_800_000_000;
const c = (domain: string, expirationDate?: number, name = "sid"): CookieRecord => ({
  name,
  value: "secret-value",
  domain,
  path: "/",
  ...(expirationDate === undefined ? {} : { expirationDate }),
});

describe("detected sessions", () => {
  it("groups non-expired cookies by registrable domain", async () => {
    const profile = jar([
      c("canvas.ucsc.edu", NOW + 100),
      c(".login.ucsc.edu", NOW + 100, "sso"),
      c("github.com"),
      c("old.example.com", NOW - 5),
    ]);
    const found = await detectSessions(profile, NOW);
    expect(found.map((f) => f.domain)).toEqual(["github.com", "ucsc.edu"]);
    expect(found.find((f) => f.domain === "ucsc.edu")?.hosts).toEqual([
      "canvas.ucsc.edu",
      "login.ucsc.edu",
    ]);
  });

  it("writes domain names only, and nothing when the profile is empty", async () => {
    await refreshDetected(home, jar([c("canvas.ucsc.edu", NOW + 100)]), NOW);
    const raw = readFileSync(detectedFile(home), "utf8");
    expect(JSON.parse(raw)).toEqual({ domains: ["ucsc.edu"] });
    expect(raw).not.toContain("secret-value");
    await refreshDetected(home, jar([]), NOW);
    expect(JSON.parse(readFileSync(detectedFile(home), "utf8"))).toEqual({ domains: [] });
  });

  it("returns sites for Settings flagged as detected", async () => {
    const sites = await refreshDetected(home, jar([c("canvas.ucsc.edu", NOW + 1)]), NOW);
    expect(sites).toMatchObject([{ origin: "https://ucsc.edu", detected: true }]);
  });

  it("forget removes every cookie under the registrable domain and leaves the rest", async () => {
    const profile = jar([c("canvas.ucsc.edu"), c(".login.ucsc.edu"), c("github.com")]);
    expect(await forgetDetected(profile, "https://ucsc.edu")).toBe(2);
    expect(profile.all.map((x) => x.domain)).toEqual(["github.com"]);
  });
});
