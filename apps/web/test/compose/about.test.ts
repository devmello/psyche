import { describe, expect, it } from "vitest";
import { aboutInfoFrom, fetchVersion } from "../../src/compose/about.ts";

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
