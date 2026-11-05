import { describe, expect, it } from "vitest";
import {
  encodePairingLink,
  encodePairingLinkV2,
  PAIRING_LINK_PREFIX,
  PAIRING_LINK_PREFIX_V2,
  PairingLinkError,
  type PairingLinkPayload,
  type PairingLinkPayloadV2,
  parsePairingLink,
  parsePairingLinkAny,
} from "../src/index.ts";

const TOKEN = `pst_${Buffer.alloc(32, 7).toString("base64url")}`;

const GOOD_V1: PairingLinkPayload = {
  gatewayUrl: "https://studio-mac.tail1234.ts.net",
  gatewayFingerprint: `sha256:${"ab".repeat(32)}`,
  setupToken: TOKEN,
  hostName: "Studio Mac",
};

const GOOD: PairingLinkPayloadV2 = {
  gatewayUrl: "https://studio-mac.local:7979",
  gatewayKey: Buffer.alloc(32, 3).toString("base64url"),
  certPin: Buffer.alloc(32, 9).toString("base64url"),
  setupToken: TOKEN,
  hostName: "Studio Mac",
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const v2 = (value: unknown) => `${PAIRING_LINK_PREFIX_V2}${b64(value)}`;
const v1 = (value: unknown) => `${PAIRING_LINK_PREFIX}${b64(value)}`;
const problem = (text: string): string | undefined => {
  try {
    parsePairingLinkAny(text);
  } catch (err) {
    return err instanceof PairingLinkError
      ? `${err.problem}${err.field ? `:${err.field}` : ""}`
      : "other";
  }
  return undefined;
};

describe("psyche-pair:v2 links (a Gateway on the local network)", () => {
  it("round-trips the five fields and nothing else", () => {
    const text = encodePairingLinkV2(GOOD);
    expect(text.startsWith("psyche-pair:v2:")).toBe(true);
    expect(parsePairingLinkAny(text)).toEqual({ version: 2, payload: GOOD });
    expect(
      JSON.parse(Buffer.from(text.slice(PAIRING_LINK_PREFIX_V2.length), "base64url").toString()),
    ).toEqual(GOOD);
    // Still a QR code a phone can scan.
    expect(text.length).toBeLessThan(550);
  });

  it("is read by parsePairingLinkAny along with v1, and v1's own parser still refuses it", () => {
    expect(parsePairingLinkAny(encodePairingLink(GOOD_V1))).toEqual({
      version: 1,
      payload: GOOD_V1,
    });
    // Code written before v2 (parsePairingLink) fails closed on a v2 link.
    expect(() => parsePairingLink(encodePairingLinkV2(GOOD))).toThrow(PairingLinkError);
    expect(problem("psyche-pair:v3:abc")).toBe("unsupported_version");
    expect(problem("https://x")).toBe("not_a_pairing_link");
  });

  it("names IPv4, .local and IPv6 unique-local endpoints, with brackets for IPv6", () => {
    for (const gatewayUrl of [
      "https://studio-mac.local",
      "https://studio-mac.local:7979/",
      "https://192.168.1.20:7979",
      "https://10.0.0.8:7979",
      "https://172.20.1.2:8443",
      "https://[fd12:3456:789a:1::20]:7979",
      "https://[fdaa::1]",
    ]) {
      expect(parsePairingLinkAny(v2({ ...GOOD, gatewayUrl })), gatewayUrl).toMatchObject({
        version: 2,
      });
      expect(() => encodePairingLinkV2({ ...GOOD, gatewayUrl }), gatewayUrl).not.toThrow();
    }
  });

  it("refuses an endpoint that is not on a local network, with a plain bad_field", () => {
    for (const gatewayUrl of [
      "https://studio-mac.tail1234.ts.net",
      "https://example.com",
      "https://8.8.8.8:7979",
      "https://100.64.1.2:7979",
      "https://169.254.1.1:7979",
      "https://[2001:db8::1]:7979",
      "https://[2600:1700::1]:7979",
      "https://[fe80::1]:7979",
      "https://[fe80::1%25en0]:7979",
      "https://[fe80::1%en0]:7979",
      "https://[::1]:7979",
      "https://127.0.0.1:7979",
      "https://localhost:7979",
      "https://[::ffff:10.0.0.1]:7979",
      "http://studio-mac.local:7979",
      "https://studio-mac.local:7979/path",
      "https://studio-mac.local:7979?x=1",
      "https://user:pw@studio-mac.local",
      "studio-mac.local:7979",
      // Spelled differently from how URL writes it: not the canonical origin.
      "https://STUDIO-MAC.local:7979",
      "https://010.0.0.1:7979",
      "https://0xa.0.0.1:7979",
      "https://10.1:7979",
      "https://[FD12::1]:7979",
      "https://[fd12:0:0:0:0:0:0:1]:7979",
    ]) {
      expect(problem(v2({ ...GOOD, gatewayUrl })), gatewayUrl).toBe("bad_field:gatewayUrl");
    }
  });

  it("requires the identity key and the certificate pin, each exactly 32 bytes of base64url", () => {
    for (const field of ["gatewayKey", "certPin"] as const) {
      const { [field]: _gone, ...rest } = GOOD;
      expect(problem(v2(rest)), `${field} missing`).toBe(`bad_field:${field}`);
      for (const bad of [
        "",
        "short",
        `${GOOD[field]}A`,
        GOOD[field].slice(1),
        `${GOOD[field].slice(0, 42)}!`,
        `sha256:${"ab".repeat(32)}`,
        // 43 characters whose last character leaves non-zero trailing bits (not canonical).
        `${"A".repeat(42)}B`,
        7,
        null,
      ]) {
        expect(problem(v2({ ...GOOD, [field]: bad })), `${field} ${String(bad)}`).toBe(
          `bad_field:${field}`,
        );
      }
    }
  });

  it("rejects extra fields, v1 fields under v2 (and the reverse), a bad token or name", () => {
    expect(problem(v2({ ...GOOD, scopes: [] }))).toBe("extra_fields:scopes");
    expect(problem(v2(GOOD_V1))).toBe("extra_fields:gatewayFingerprint");
    expect(problem(v1(GOOD))).toBe("extra_fields:gatewayKey");
    expect(problem(v2({ ...GOOD, setupToken: "pst_x" }))).toBe("bad_field:setupToken");
    expect(problem(v2({ ...GOOD, hostName: "  " }))).toBe("bad_field:hostName");
    expect(problem(v2({ ...GOOD, hostName: "Studio\nMac" }))).toBe("bad_field:hostName");
    for (const body of [null, 7, "text", [GOOD]]) {
      expect(problem(v2(body))).toBe("malformed");
    }
    expect(problem(`${PAIRING_LINK_PREFIX_V2}not base64!`)).toBe("malformed");
  });

  it("will not encode a payload it would not parse", () => {
    expect(() => encodePairingLinkV2({ ...GOOD, certPin: "x" })).toThrow(PairingLinkError);
    expect(() => encodePairingLinkV2({ ...GOOD, gatewayUrl: "https://example.com" })).toThrow(
      PairingLinkError,
    );
    const wide = { ...GOOD, secret: "x" } as PairingLinkPayloadV2;
    expect(parsePairingLinkAny(encodePairingLinkV2(wide))).toEqual({ version: 2, payload: GOOD });
  });
});
