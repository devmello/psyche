import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { desktopConnectParams, isLocalGatewayOrigin } from "../src/gateway-client.ts";
import type { DeviceKey } from "../src/lib/device-key.ts";

const home = mkdtempSync(join(tmpdir(), "psyche-gwclient-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, "run"), { recursive: true });
writeFileSync(join(home, "run", "handshake.secret"), "per-launch-secret\n");

const key = { deviceId: "dev_x", publicKey: "pk" } as unknown as DeviceKey;

describe("isLocalGatewayOrigin", () => {
  it("is true for the Gateway on this Mac, on any port or scheme", () => {
    for (const o of [
      "http://127.0.0.1:7979",
      "http://localhost:7979",
      "http://[::1]:7979",
      "https://localhost:8443",
    ]) {
      expect(isLocalGatewayOrigin(o), o).toBe(true);
    }
  });

  it("is false for a Gateway on another machine, whatever its name looks like", () => {
    for (const o of [
      "https://psyche.tail1234.ts.net",
      "http://192.168.1.20:7979",
      "http://127.0.0.1.evil.example:7979",
      "http://localhost.evil.example",
      "https://user@evil.example/@127.0.0.1",
      "http://10.0.0.5",
      "not a url",
      "",
      "file:///127.0.0.1",
    ]) {
      expect(isLocalGatewayOrigin(o), o).toBe(false);
    }
  });
});

describe("desktopConnectParams", () => {
  it("sends the per-launch handshake secret to the Gateway on this Mac", async () => {
    const p = await desktopConnectParams({ key, home, origin: "http://127.0.0.1:7979" });
    expect(p.handshakeSecret).toBe("per-launch-secret");
    expect(p).toMatchObject({ role: "client", deviceFamily: "desktop", deviceId: "dev_x" });
  });

  it("never sends it to a Gateway on another machine", async () => {
    for (const origin of ["https://psyche.tail1234.ts.net", "http://192.168.1.20:7979"]) {
      const p = await desktopConnectParams({ key, home, origin });
      expect(p.handshakeSecret, origin).toBeUndefined();
      expect(JSON.stringify(p)).not.toContain("per-launch-secret");
    }
  });
});
