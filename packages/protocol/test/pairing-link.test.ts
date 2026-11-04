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

// Test values built from byte sequences, not literals: they are not secrets.
const bytes = (start: number): string =>
  Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => start + i)).toString("base64url");

const payload: PairingLinkPayload = {
  gatewayUrl: "https://studio-mac.tail1234.ts.net",
  gatewayIdentityKey: bytes(32),
  setupToken: bytes(0),
  hostName: "Studio Mac — Café",
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

  it("encodes exactly this JSON, in this key order, so the phone can build the same bytes", () => {
    const fixture = { ...payload, hostName: "studio-mac" };
    const body = encodePairingLink(fixture).slice(PAIRING_LINK_PREFIX.length);
    expect(Buffer.from(body, "base64url").toString("utf8")).toBe(
      `{"gatewayUrl":"https://studio-mac.tail1234.ts.net","gatewayIdentityKey":"${fixture.gatewayIdentityKey}","setupToken":"${fixture.setupToken}","hostName":"studio-mac"}`,
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

  it("allows http only to exactly localhost, 127.0.0.1 and [::1]", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(pairingLinkOrigin(`http://${host}:7979`)).toBe(`http://${host}:7979`);
    }
    for (const host of ["foo.localhost", "a.b.localhost", "localhost.example.com", "127.0.0.2"]) {
      expect(() => pairingLinkOrigin(`http://${host}:7979`), host).toThrow();
    }
    // https needs no exemption for any of them.
    expect(pairingLinkOrigin("https://foo.localhost")).toBe("https://foo.localhost");
  });

  it("refuses a host name that could hide or reshape the sentence it is shown in", () => {
    const hidden = [
      "a\u200Db", // zero-width joiner
      "a\u200Eb", // left-to-right mark
      "a\u2028b", // line separator
      "a\u2029b", // paragraph separator
      "a\u0085b", // C1 control
      "a\u00ADb", // soft hyphen
      "a\u115Fb", // Hangul filler
      "a\u3164b", // Hangul filler
      "a\u{E0041}b", // tag character
      "a\u2066b", // isolate
    ];
    for (const hostName of hidden) {
      expect(() => encodePairingLink({ ...payload, hostName }), JSON.stringify(hostName)).toThrow();
      expect(() => parsePairingLink(linkOf({ ...payload, hostName }))).toThrow();
    }
    expect(encodePairingLink({ ...payload, hostName: "Café 日本" })).toBeTruthy();
  });

  it("normalizes the origin", () => {
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
