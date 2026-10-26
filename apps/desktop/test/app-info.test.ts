import { describe, expect, it } from "vitest";
import { appInfo, fetchGatewayVersion } from "../src/lib/app-info.ts";

describe("About from main (#610)", () => {
  it("reports versions, platform, the data folder and the Gateway's /version from its origin", async () => {
    const urls: string[] = [];
    const info = await appInfo({
      appVersion: "0.3.0-alpha.0",
      platform: "darwin",
      arch: "arm64",
      osVersion: "27.0.1",
      versions: { electron: "39.2.0", chrome: "142.0.7444.59" },
      psycheHome: "/Users/owner/.psyche",
      gatewayOrigin: "http://127.0.0.1:18789",
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return Response.json({ name: "psyched", version: "0.3.0-alpha.0", protocolVersion: 1 });
      }) as typeof fetch,
    });
    expect(urls).toEqual(["http://127.0.0.1:18789/version"]);
    expect(info).toEqual({
      appVersion: "0.3.0-alpha.0",
      platform: "darwin",
      arch: "arm64",
      osVersion: "27.0.1",
      electronVersion: "39.2.0",
      chromeVersion: "142.0.7444.59",
      psycheHome: "/Users/owner/.psyche",
      gatewayOrigin: "http://127.0.0.1:18789",
      gateway: { name: "psyched", version: "0.3.0-alpha.0", protocolVersion: 1 },
    });
  });

  it("a Gateway that is down or failing answers null", async () => {
    const origin = "http://127.0.0.1:18789";
    expect(
      await fetchGatewayVersion(origin, (async () => new Response("", { status: 503 })) as never),
    ).toBeNull();
    expect(
      await fetchGatewayVersion(origin, (async () => {
        throw new Error("ECONNREFUSED");
      }) as never),
    ).toBeNull();
  });
});
