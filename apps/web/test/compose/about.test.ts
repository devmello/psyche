import { describe, expect, it } from "vitest";
import {
  aboutInfoFrom,
  aboutInfoFromHost,
  archLabel,
  fetchVersion,
  platformLabel,
} from "../../src/compose/about.ts";
import type { HostAppInfo } from "../../src/shell/platform.ts";

/** What the desktop's main process answers over the bridge (`window.psyche.app.info()`). */
const host = (over: Partial<HostAppInfo> = {}): HostAppInfo => ({
  appVersion: "0.3.0-alpha.0",
  platform: "darwin",
  arch: "arm64",
  osVersion: "27.0.1",
  electronVersion: "39.2.0",
  chromeVersion: "142.0.7444.59",
  psycheHome: "/Users/owner/.psyche",
  gatewayOrigin: "http://127.0.0.1:18789",
  gateway: { name: "psyched", version: "0.3.0-alpha.0", protocolVersion: 1 },
  ...over,
});

describe("About versions", () => {
  it("reads the Gateway and protocol versions from /version and bakes in the app version", () => {
    const info = aboutInfoFrom(
      { name: "psyched", version: "0.3.0-alpha.0", protocolVersion: 1 },
      "0.3.0-alpha.0",
    );
    expect(info.appVersion).toBe("0.3.0-alpha.0");
    expect(info.gatewayVersion).toBe("0.3.0-alpha.0");
    expect(info.protocolVersion).toBe(1);
  });

  it("never shows an empty string: a missing Gateway answer reads as unknown", () => {
    const info = aboutInfoFrom(null, "1.2.3");
    expect(info.appVersion).toBe("1.2.3");
    expect(info.gatewayVersion).not.toBe("");
    expect(info.gatewayVersion).toMatch(/unknown/i);
    expect(aboutInfoFrom({ version: "" }, "").appVersion).toMatch(/unknown/i);
  });

  it("fetches /version on the page's origin and tolerates failures", async () => {
    const calls: string[] = [];
    const ok = await fetchVersion((async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ name: "psyched", version: "9.9.9", protocolVersion: 1 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch);
    expect(calls).toEqual(["/version"]);
    expect(ok?.version).toBe("9.9.9");
    expect(
      await fetchVersion((async () => new Response("", { status: 500 })) as typeof fetch),
    ).toBeNull();
    expect(
      await fetchVersion((async () => {
        throw new Error("offline");
      }) as typeof fetch),
    ).toBeNull();
  });
});

describe("About on the desktop (#610)", () => {
  it("prefers the bridge: real versions, macOS and the chip, and the data folder", () => {
    const info = aboutInfoFromHost(host(), "");
    expect(info).toEqual({
      appVersion: "0.3.0-alpha.0",
      gatewayVersion: "0.3.0-alpha.0",
      protocolVersion: 1,
      platform: "macOS 27.0.1 · Apple silicon",
      home: "/Users/owner/.psyche",
      runtime: "Electron 39.2.0 · Chrome 142.0.7444.59",
    });
    expect(info.platform).not.toMatch(/MacIntel/);
  });

  it("reads Intel Macs as Intel and keeps unknown chips as reported", () => {
    expect(platformLabel(host({ arch: "x64" }))).toBe("macOS 27.0.1 · Intel");
    expect(archLabel("arm64")).toBe("Apple silicon");
    expect(archLabel("riscv64")).toBe("riscv64");
    expect(platformLabel(host({ platform: "linux", osVersion: "6.8" }))).toBe(
      "Linux 6.8 · Apple silicon",
    );
  });

  it("falls back to the baked version, and an unreachable Gateway reads as unknown", () => {
    const info = aboutInfoFromHost(host({ appVersion: "", gateway: null }), "0.3.0");
    expect(info.appVersion).toBe("0.3.0");
    expect(info.gatewayVersion).toMatch(/unknown/i);
    expect(aboutInfoFromHost(host({ electronVersion: "" })).runtime).toBeUndefined();
  });
});
