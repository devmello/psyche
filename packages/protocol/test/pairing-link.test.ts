import { describe, expect, it } from "vitest";
import {
  encodePairingLink,
  Methods,
  PAIRING_LINK_PREFIX,
  type PairingLinkPayload,
  pairingLinkOrigin,
  parsePairingLink,
  SETUP_TOKEN_TTL_MS,
} from "../src/index.ts";

const payload: PairingLinkPayload = {
  gatewayUrl: "https://studio-mac.tail1234.ts.net",
  gatewayIdentityKey: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  setupToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  hostName: "Studio Mac — Pranav’s",
};

function linkOf(value: unknown): string {
  return PAIRING_LINK_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("psyche-pair:v1 link", () => {
  it("round-trips, including a non-ASCII host name", () => {
    const link = encodePairingLink(payload);
    expect(link.startsWith("psyche-pair:v1:")).toBe(true);
    expect(link).toMatch(/^psyche-pair:v1:[A-Za-z0-9_-]+$/);
    expect(parsePairingLink(link)).toEqual(payload);
    expect(parsePairingLink(`  ${link}\n`)).toEqual(payload);
  });

  it("is a base64url JSON of exactly the four fields", () => {
    const body = encodePairingLink(payload).slice(PAIRING_LINK_PREFIX.length);
    expect(Object.keys(JSON.parse(Buffer.from(body, "base64url").toString("utf8"))).sort()).toEqual(
      ["gatewayIdentityKey", "gatewayUrl", "hostName", "setupToken"],
    );
  });

  it("is a fixed fixture the phone can decode independently", () => {
    const fixture = {
      ...payload,
      hostName: "studio-mac",
    };
    expect(encodePairingLink(fixture)).toBe(
      "psyche-pair:v1:eyJnYXRld2F5VXJsIjoiaHR0cHM6Ly9zdHVkaW8tbWFjLnRhaWwxMjM0LnRzLm5ldCIsImdhdGV3YXlJZGVudGl0eUtleSI6IklDRWlJeVFsSmljb0tTb3JMQzB1THpBeE1qTTBOVFkzT0RrNk96dzlQajgiLCJzZXR1cFRva2VuIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVhHQmthR3h3ZEhoOCIsImhvc3ROYW1lIjoic3R1ZGlvLW1hYyJ9",
    );
  });

  it("refuses anything that is not a well-formed v1 link", () => {
    const bad = [
      "",
      "psyche-pair:v1:abc",
      `psyche-pair:v2:${linkOf(payload).slice(PAIRING_LINK_PREFIX.length)}`,
      "https://studio-mac.tail1234.ts.net",
      `https://x.example/?l=${encodePairingLink(payload)}`,
      linkOf("string"),
      linkOf([payload]),
      linkOf({ ...payload, setupToken: undefined }),
      linkOf({ ...payload, setupToken: "short" }),
      linkOf({ ...payload, gatewayIdentityKey: "short" }),
      linkOf({ ...payload, hostName: "" }),
      linkOf({ ...payload, hostName: "a\nb" }),
      linkOf({ ...payload, hostName: "studio\u202Emac" }),
      linkOf({ ...payload, hostName: "x".repeat(129) }),
      linkOf({ ...payload, gatewayUrl: "http://studio-mac.tail1234.ts.net" }),
      linkOf({ ...payload, gatewayUrl: "https://studio-mac.tail1234.ts.net/chat" }),
      linkOf({ ...payload, gatewayUrl: "https://studio-mac.tail1234.ts.net/?gatewayUrl=x" }),
      linkOf({ ...payload, gatewayUrl: "https://o:pw@studio-mac.tail1234.ts.net" }),
      linkOf({ ...payload, gatewayUrl: "ftp://studio-mac.tail1234.ts.net" }),
      `${PAIRING_LINK_PREFIX}${"A".repeat(4000)}`,
      `${PAIRING_LINK_PREFIX}!!!`,
    ];
    for (const input of bad) expect(() => parsePairingLink(input), input.slice(0, 40)).toThrow();
  });

  it("ignores unknown fields so a later revision still parses", () => {
    expect(parsePairingLink(linkOf({ ...payload, spkiPins: ["x"] }))).toEqual(payload);
  });

  it("allows http only to loopback", () => {
    expect(pairingLinkOrigin("http://127.0.0.1:7979")).toBe("http://127.0.0.1:7979");
    expect(pairingLinkOrigin("https://Studio-Mac.local:7979/")).toBe(
      "https://studio-mac.local:7979",
    );
    expect(() => pairingLinkOrigin("http://192.168.1.20:7979")).toThrow();
  });

  it("registers createLink as admin-only and side-effecting; the token lives 10 minutes", () => {
    const spec = Methods["devices.pairing.createLink"];
    expect(spec.scope).toBe("operator.admin");
    expect(spec.sideEffecting).toBe(true);
    expect(SETUP_TOKEN_TTL_MS).toBe(600_000);
  });
});
