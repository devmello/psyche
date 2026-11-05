import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { unknownConfigKeys, validateConfig } from "../src/config-file.ts";
import type { Deps } from "../src/context.ts";
import { scriptedPrompter } from "../src/prompt.ts";
import { closedPort } from "./helpers.ts";

/** The CLI judges config.json the way the Gateway does (updates design §2.7, review M1/L4). */

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const temp = () => {
  const h = mkdtempSync(join(tmpdir(), "psy-cfgcli-"));
  homes.push(h);
  return h;
};

describe("validateConfig", () => {
  it("accepts every key the Gateway reads, so none is reported as unknown (L4)", () => {
    const config = {
      gateway: {
        host: "127.0.0.1",
        port: 7979,
        allowedOrigins: ["https://x.example"],
        publicOrigin: "https://x.example",
        trustedProxy: {
          enabled: true,
          trustedProxies: ["10.0.0.0/8"],
          tailscaleProxies: ["100.64.0.0/10"],
          allowedLogins: ["me@x.com"],
        },
        cloudflareAccess: { teamDomain: "t.cloudflareaccess.com", audience: "aud" },
        rateLimits: { inboundChatPerMinute: 30, fetchPerMinute: 60 },
      },
    };
    expect(unknownConfigKeys(config)).toEqual([]);
    expect(validateConfig(config)).toEqual([]);
    expect(validateConfig({ gateway: { rateLimits: { fetchPerMinute: 0 } } })).toEqual([
      "gateway.rateLimits.fetchPerMinute must be an integer 1-10000",
    ]);
  });

  it("refuses a typo in a security section and a typo of a known key", () => {
    expect(validateConfig({ gateway: { trustedProxy: { allowedLogin: ["a"] } } })).toEqual([
      "gateway.trustedProxy.allowedLogin is not a known key",
    ]);
    expect(validateConfig({ gateway: { cloudflareAccess: { teamDomian: "x" } } })).toEqual([
      "gateway.cloudflareAccess.teamDomian is not a known key",
    ]);
    expect(validateConfig({ gateway: { hots: "127.0.0.1" } })).toEqual([
      "gateway.hots is not a known key (a typo of a known key?)",
    ]);
  });

  it("only warns about far-off keys, and tolerates all of it from a newer configVersion", () => {
    expect(validateConfig({ gateway: { quantumFlux: 1 } })).toEqual([]);
    expect(unknownConfigKeys({ gateway: { quantumFlux: 1 } })).toEqual(["gateway.quantumFlux"]);
    expect(
      validateConfig({
        configVersion: 2,
        gateway: { hots: "x", trustedProxy: { allowedLogin: [] } },
      }),
    ).toEqual([]);
  });
});

describe("psyche migrate --retry", () => {
  it("forgets a failed update so the next start tries again", async () => {
    const home = temp();
    mkdirSync(join(home, "run"));
    const note = join(home, "run", "update-failed.json");
    writeFileSync(note, "{}");
    const out: string[] = [];
    const deps: Deps = {
      env: { HOME: home, PSYCHE_HOME: home },
      io: { out: (t) => out.push(t), err: () => {}, stdin: new PassThrough() },
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      fetch,
      prompter: scriptedPrompter([], false),
      platform: "linux",
      uid: 501,
      now: () => new Date(),
    };
    const url = `http://127.0.0.1:${await closedPort()}`;
    expect(await run(["migrate", "--retry", "--url", url, "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ retry: true, cleared: true });
    expect(existsSync(note)).toBe(false);
    out.length = 0;
    expect(await run(["migrate", "--retry", "--url", url, "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ retry: true, cleared: false });
  });
});
