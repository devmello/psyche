import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addGateway,
  clearGatewayPin,
  EMPTY_GATEWAYS,
  isLanHost,
  isLanOrigin,
  loadGatewaysStrict,
  pinGatewayCert,
  saveGateways,
} from "../src/lib/gateways.ts";
import { LanDiscovery, toDiscovered } from "../src/lib/lan-discovery.ts";

const dir = mkdtempSync(join(tmpdir(), "psyche-lan-gateways-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PIN = Buffer.alloc(32, 4).toString("base64url");
const FP = `sha256:${"cd".repeat(32)}`;

describe("which saved Gateways are on the local network", () => {
  it("knows .local names and private addresses, not tailnet or public names", () => {
    for (const h of [
      "studio-mac.local",
      "STUDIO.LOCAL",
      "192.168.1.20",
      "10.0.0.5",
      "172.16.4.4",
    ]) {
      expect(isLanHost(h)).toBe(true);
    }
    for (const h of [
      "studio.tail1234.ts.net",
      "example.com",
      "8.8.8.8",
      "172.32.0.1",
      "127.0.0.1",
      "localhost",
    ]) {
      expect(isLanHost(h)).toBe(false);
    }
    expect(isLanOrigin("https://studio-mac.local:7979")).toBe(true);
    expect(isLanOrigin("http://studio-mac.local:7979")).toBe(false);
  });

  it("accepts a .local address with a port and keeps the port", () => {
    const { entry } = addGateway(EMPTY_GATEWAYS, { address: "https://Studio-Mac.local:7979/" });
    expect(entry.origin).toBe("https://studio-mac.local:7979");
    expect(entry.name).toBe("studio-mac");
  });
});

describe("pins of a LAN Gateway", () => {
  it("keeps a certificate pin from a pairing link only for a LAN address, and stores it", () => {
    const lan = addGateway(EMPTY_GATEWAYS, {
      address: "studio-mac.local:7979",
      hints: { lan: true, certPin: PIN, advertisedFingerprint: FP },
    });
    expect(lan.entry.certPin).toBe(PIN);
    expect(lan.entry.lan).toBe(true);
    expect(lan.entry.advertisedFingerprint).toBe(FP);
    // A certificate pin means nothing for a name a public CA can certify: it is not kept.
    const ts = addGateway(EMPTY_GATEWAYS, {
      address: "studio.tail1234.ts.net",
      hints: { lan: true, certPin: PIN },
    });
    expect(ts.entry.certPin).toBeUndefined();
    expect(ts.entry.lan).toBeUndefined();
    // A `.local` address that is not marked LAN (a proxy with its own CA) stays an ordinary Gateway.
    const plain = addGateway(EMPTY_GATEWAYS, {
      address: "nas.local",
      hints: { certPin: PIN },
    });
    expect(plain.entry.lan).toBeUndefined();
    expect(plain.entry.certPin).toBeUndefined();
    // Malformed hints are dropped.
    const bad = addGateway(EMPTY_GATEWAYS, {
      address: "studio-mac.local",
      hints: { lan: true, certPin: "nope", advertisedFingerprint: "sha256:zz" },
    });
    expect(bad.entry.certPin).toBeUndefined();
    expect(bad.entry.advertisedFingerprint).toBeUndefined();
  });

  it("round-trips through the file, refuses a malformed pin, and clears every pin on re-pair", () => {
    const file = join(dir, "gateways.json");
    const added = addGateway(EMPTY_GATEWAYS, { address: "studio-mac.local:7979" });
    saveGateways(file, pinGatewayCert(added.gateways, added.entry.id, PIN));
    const loaded = loadGatewaysStrict(file);
    expect(loaded.gateways[0]?.certPin).toBe(PIN);
    // A pin that is not a pin stops the app from rewriting the file over it.
    const raw = JSON.parse(readFileSync(file, "utf8")) as { gateways: { certPin: string }[] };
    (raw.gateways[0] as { certPin: string }).certPin = "short";
    writeFileSync(file, JSON.stringify(raw));
    expect(() => loadGatewaysStrict(file)).toThrow(/cannot read/);
    const cleared = clearGatewayPin(
      pinGatewayCert(added.gateways, added.entry.id, PIN),
      added.entry.id,
    );
    expect(cleared.gateways[0]?.certPin).toBeUndefined();
  });
});

describe("what the network announces is untrusted text", () => {
  const good = {
    name: "studio-mac",
    host: "studio-mac.local",
    port: 7979,
    txt: { v: "1", name: "studio-mac", fp: "cd".repeat(32) },
  };

  it("builds the origin itself from the host label and the port", () => {
    expect(toDiscovered(good)).toMatchObject({
      name: "studio-mac",
      origin: "https://studio-mac.local:7979",
      fingerprint: FP,
    });
  });

  it("drops anything that is not a plain .local host and a real port", () => {
    for (const host of [
      "evil.example.com",
      "a/b.local",
      "user@host.local",
      "host.local:80",
      "..local",
      ".local",
      "ho st.local",
      "192.168.1.5",
    ]) {
      expect(toDiscovered({ ...good, host })).toBeNull();
    }
    for (const port of [0, 70000, 1.5, "7979", undefined]) {
      expect(toDiscovered({ ...good, port })).toBeNull();
    }
    expect(toDiscovered({ ...good, txt: { v: "2" } })).toBeNull();
  });

  it("shows no fingerprint for a malformed one and cleans the announced name", () => {
    const d = toDiscovered({ ...good, txt: { v: "1", name: "A‮B\n", fp: "xyz" } });
    expect(d?.fingerprint).toBeNull();
    expect(d?.name).toBe("A B");
  });

  it("lets the window add only a listing this process found", async () => {
    const found = new LanDiscovery(async (onFound) => {
      onFound(good);
      onFound({ ...good, host: "evil.example.com" });
      onFound(good);
    });
    const list = await found.discover(1);
    expect(list).toHaveLength(1);
    const first = list[0];
    expect(found.get(first?.id ?? "")?.origin).toBe("https://studio-mac.local:7979");
    expect(found.get("https://evil.example")).toBeUndefined();
  });

  it("flags one origin announced with different keys, and will not let it be added blindly", async () => {
    const found = new LanDiscovery(async (onFound) => {
      onFound(good);
      onFound({ ...good, txt: { v: "1", name: "studio-mac", fp: "ef".repeat(32) } });
      onFound({ ...good, host: "other.local" });
      onFound({ ...good, host: "nokey.local", txt: { v: "1", fp: "cd".repeat(32) } });
      onFound({ ...good, host: "nokey.local", txt: { v: "1" } });
    });
    const list = await found.discover(1);
    const by = (o: string) => list.find((d) => d.origin === o);
    expect(by("https://studio-mac.local:7979")?.conflict).toBe(true);
    expect(by("https://other.local:7979")?.conflict).toBe(false);
    expect(by("https://nokey.local:7979")?.conflict).toBe(true);
  });

  it("caps the number of listings", async () => {
    const found = new LanDiscovery(async (onFound) => {
      for (let i = 0; i < 100; i++) onFound({ ...good, host: `h${i}.local` });
    });
    expect((await found.discover(1)).length).toBe(32);
  });
});

describe("adding a local-looking address asks what it is", () => {
  async function addWith(answer: boolean | "plain", address: string) {
    const { GatewayManager } = await import("../src/main/gateway-manager.ts");
    const userData = mkdtempSync(join(dir, "ud-"));
    const asked: string[] = [];
    const m = new GatewayManager({
      userData,
      target: {
        id: "this-mac",
        name: "This Mac",
        origin: "http://127.0.0.1:7979",
        remote: false,
        dataDir: null,
      },
      confirm: async (c) => {
        asked.push(c.kind);
        return answer;
      },
      relaunch: () => {},
    });
    const view = await m.add(address);
    return { view, asked };
  }

  it("marks it LAN only when the owner says it is a Psyche on the network", async () => {
    const lan = await addWith(true, "studio-mac.local:7979");
    expect(lan.asked).toEqual(["addLan"]);
    expect(lan.view.lan).toBe(true);
    const plain = await addWith("plain", "nas.local");
    expect(plain.view.lan).toBe(false);
    const normal = await addWith(true, "studio.tail1234.ts.net");
    expect(normal.asked).toEqual(["add"]);
    expect(normal.view.lan).toBe(false);
  });

  it("adds nothing when the owner cancels", async () => {
    await expect(addWith(false, "studio-mac.local")).rejects.toThrow(/cancelled/);
  });
});
