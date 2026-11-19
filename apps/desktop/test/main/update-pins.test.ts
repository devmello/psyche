import { describe, expect, it } from "vitest";
import { checkForVerifiedUpdate } from "../../src/main/update-flow.ts";
import { isUnderPin } from "../../src/main/update-manifest.ts";

/** The feed and baseUrl host pins compare the parsed URL, not the raw string (security §11). */

const REPO = "https://github.com/devmello/psyche/releases/";
const DOWNLOAD = `${REPO}download/`;
const KEY = {
  keyId: "37312dba0e2eddad",
  publicKey: "hbM9GyfYsfhRfSZX6E6QimBS7GqkV2CMlDpVdxolxNk=",
};

const refused = [
  "https://github.com/devmello/psyche/releases/%2e%2e/%2e%2e/%2e%2e/evil/repo/releases/latest/download/",
  "https://github.com/devmello/psyche/releases/../../../evil/repo/releases/latest/download/",
  "https://github.com/devmello/psyche/releases/%2E%2E/evil/",
  "https://github.com/devmello/psyche/releases/.%2e/evil/",
  "https://github.com/devmello/psyche/releases/download/..%2f..%2fevil/",
  "https://github.com/devmello/psyche/releases/download/..%5c..%5cevil/",
  "https://github.com/devmello/psyche/releases\\..\\..\\evil\\",
  "https://github.com/devmello/psyche/releases/latest/download/?x=1",
  "https://github.com@evil.example/devmello/psyche/releases/latest/download/",
  "https://user:pw@github.com/devmello/psyche/releases/latest/download/",
  "https://github.com:444/devmello/psyche/releases/latest/download/",
  "http://github.com/devmello/psyche/releases/latest/download/",
  "https://github.com/devmello/psyche/releases-evil/",
  "https://github.com/devmello/psyche2/releases/",
  "not a url",
];

describe("isUnderPin", () => {
  for (const url of refused) {
    it(`refuses ${url}`, () => {
      expect(isUnderPin(url, REPO)).toBe(false);
    });
  }
  it("accepts the real locations and harmless dot segments", () => {
    expect(isUnderPin(`${REPO}latest/download/`, REPO)).toBe(true);
    expect(isUnderPin(`${DOWNLOAD}v1.2.3/`, DOWNLOAD)).toBe(true);
    expect(isUnderPin(`${REPO}./latest/download/`, REPO)).toBe(true);
    expect(isUnderPin(`${DOWNLOAD}v1/../v2/`, DOWNLOAD)).toBe(true);
  });
});

describe("checkForVerifiedUpdate feed pin", () => {
  for (const feed of refused.filter((u) => u.endsWith("/"))) {
    it(`refuses the feed ${feed} without fetching`, async () => {
      let fetched = 0;
      const out = await checkForVerifiedUpdate({
        arch: "arm64",
        currentVersion: "1.0.0",
        log: () => {},
        keys: [KEY],
        dir: "/nonexistent",
        feed,
        fetch: (async () => {
          fetched++;
          return new Response("x", { status: 404 });
        }) as typeof fetch,
      });
      expect(out).toMatchObject({ state: "refused", code: "untrusted_host" });
      expect(fetched).toBe(0);
    });
  }
});
