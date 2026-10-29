import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useSignedInFromSetting } from "../src/compose/browser.ts";
import { readDetectedDomains } from "../src/compose/parts.ts";

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe("readDetectedDomains", () => {
  it("reads the domains the desktop found and ignores junk", () => {
    home = mkdtempSync(join(tmpdir(), "psyche-detected-"));
    mkdirSync(join(home, "browser"));
    writeFileSync(
      join(home, "browser", "detected-sessions.json"),
      JSON.stringify({ domains: ["ucsc.edu", 3, "bad domain/"] }),
    );
    expect(readDetectedDomains(home)).toEqual(["ucsc.edu"]);
  });
  it("is empty when missing", () => {
    expect(readDetectedDomains(join(tmpdir(), "psyche-no-such-home"))).toEqual([]);
  });
});

describe("browser.useSignedInSessions", () => {
  it("defaults on; only an explicit false turns it off", () => {
    expect(useSignedInFromSetting(undefined)).toBe(true);
    expect(useSignedInFromSetting(true)).toBe(true);
    expect(useSignedInFromSetting(false)).toBe(false);
  });
});
