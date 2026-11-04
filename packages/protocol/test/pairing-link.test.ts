import { describe, expect, it } from "vitest";
import {
  encodePairingLink,
  PAIRING_LINK_PREFIX,
  PairingLinkError,
  type PairingLinkPayload,
  parsePairingLink,
} from "../src/index.ts";

const GOOD: PairingLinkPayload = {
  gatewayUrl: "https://studio-mac.tail1234.ts.net",
  gatewayFingerprint: `sha256:${"ab".repeat(32)}`,
  setupToken: `pst_${Buffer.alloc(32, 7).toString("base64url")}`,
  hostName: "Studio Mac",
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const link = (value: unknown) => `${PAIRING_LINK_PREFIX}${b64(value)}`;
const problem = (text: string): string | undefined => {
  try {
    parsePairingLink(text);
  } catch (err) {
    return err instanceof PairingLinkError
      ? `${err.problem}${err.field ? `:${err.field}` : ""}`
      : "other";
  }
  return undefined;
};

describe("psyche-pair:v1 links", () => {
  it("round-trips the four fields and nothing else", () => {
    const text = encodePairingLink(GOOD);
    expect(text.startsWith("psyche-pair:v1:")).toBe(true);
    expect(parsePairingLink(text)).toEqual(GOOD);
    // base64url: no padding, no characters that need escaping in a URL or a QR code.
    expect(text.slice(PAIRING_LINK_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      JSON.parse(Buffer.from(text.slice(PAIRING_LINK_PREFIX.length), "base64url").toString()),
    ).toEqual(GOOD);
  });

  it("keeps non-ASCII host names intact and ignores surrounding whitespace", () => {
    const named = { ...GOOD, hostName: "Studio Mac de María" };
    expect(parsePairingLink(`  ${encodePairingLink(named)}\n`)).toEqual(named);
  });

  it("matches the scheme without regard to case, nothing else", () => {
    const text = encodePairingLink(GOOD).replace("psyche-pair:", "Psyche-Pair:");
    expect(parsePairingLink(text)).toEqual(GOOD);
    expect(problem(text.replace(":v1:", ":V1:"))).toBe("unsupported_version");
  });

  it("rejects text that is not a pairing link, and other versions", () => {
    expect(problem("https://studio-mac.tail1234.ts.net")).toBe("not_a_pairing_link");
    expect(problem("psyche://chat")).toBe("not_a_pairing_link");
    expect(problem("")).toBe("not_a_pairing_link");
    expect(problem("psyche-pair:")).toBe("malformed");
    expect(problem("psyche-pair:v1")).toBe("malformed");
    expect(problem(`psyche-pair:v2:${b64(GOOD)}`)).toBe("unsupported_version");
    expect(problem(`psyche-pair::${b64(GOOD)}`)).toBe("unsupported_version");
  });

  it("rejects bodies that are not base64url JSON objects", () => {
    expect(problem(`${PAIRING_LINK_PREFIX}`)).toBe("malformed");
    expect(problem(`${PAIRING_LINK_PREFIX}not base64!`)).toBe("malformed");
    expect(problem(`${PAIRING_LINK_PREFIX}${b64(GOOD)}=`)).toBe("malformed");
    expect(problem(`${PAIRING_LINK_PREFIX}${Buffer.from("{nope").toString("base64url")}`)).toBe(
      "malformed",
    );
    for (const body of [null, 7, "text", [GOOD], [], true]) {
      expect(problem(link(body))).toBe("malformed");
    }
    // Invalid UTF-8 is not silently repaired.
    expect(
      problem(`${PAIRING_LINK_PREFIX}${Buffer.from([0x7b, 0xff, 0x7d]).toString("base64url")}`),
    ).toBe("malformed");
    expect(problem(`${PAIRING_LINK_PREFIX}${"A".repeat(3000)}`)).toBe("malformed");
  });

  it("rejects any extra field, including ones that look harmless", () => {
    expect(problem(link({ ...GOOD, spkiPins: [] }))).toBe("extra_fields:spkiPins");
    expect(problem(link({ ...GOOD, scopes: ["operator.admin"] }))).toBe("extra_fields:scopes");
    expect(problem(link({ ...GOOD, gatewayIdentityKey: "x" }))).toBe(
      "extra_fields:gatewayIdentityKey",
    );
    expect(
      problem(
        `${PAIRING_LINK_PREFIX}${Buffer.from(`{"__proto__":{},"gatewayUrl":"x"}`).toString("base64url")}`,
      ),
    ).toBe("extra_fields:__proto__");
  });

  it("rejects a missing field or one of the wrong type", () => {
    for (const field of Object.keys(GOOD)) {
      const { [field as keyof PairingLinkPayload]: _gone, ...rest } = GOOD;
      expect(problem(link(rest))).toBe(`bad_field:${field}`);
      expect(problem(link({ ...GOOD, [field]: 7 }))).toBe(`bad_field:${field}`);
      expect(problem(link({ ...GOOD, [field]: null }))).toBe(`bad_field:${field}`);
    }
  });

  it("rejects values outside their shape", () => {
    expect(problem(link({ ...GOOD, gatewayFingerprint: "sha256:abc" }))).toBe(
      "bad_field:gatewayFingerprint",
    );
    expect(problem(link({ ...GOOD, gatewayFingerprint: `sha256:${"AB".repeat(32)}` }))).toBe(
      "bad_field:gatewayFingerprint",
    );
    expect(problem(link({ ...GOOD, gatewayFingerprint: `md5:${"ab".repeat(32)}` }))).toBe(
      "bad_field:gatewayFingerprint",
    );
    expect(problem(link({ ...GOOD, setupToken: "pst_short" }))).toBe("bad_field:setupToken");
    expect(problem(link({ ...GOOD, setupToken: GOOD.setupToken.replace("pst_", "tok_") }))).toBe(
      "bad_field:setupToken",
    );
    expect(problem(link({ ...GOOD, setupToken: `${GOOD.setupToken}A` }))).toBe(
      "bad_field:setupToken",
    );
    expect(problem(link({ ...GOOD, gatewayUrl: "" }))).toBe("bad_field:gatewayUrl");
    expect(problem(link({ ...GOOD, gatewayUrl: `https://${"a".repeat(400)}.ts.net` }))).toBe(
      "bad_field:gatewayUrl",
    );
    expect(problem(link({ ...GOOD, gatewayUrl: "https://studio mac.ts.net" }))).toBe(
      "bad_field:gatewayUrl",
    );
    expect(problem(link({ ...GOOD, hostName: "   " }))).toBe("bad_field:hostName");
    expect(problem(link({ ...GOOD, hostName: "a".repeat(65) }))).toBe("bad_field:hostName");
    // Control and bidirectional-override characters cannot reshape a dialog.
    expect(problem(link({ ...GOOD, hostName: "Studio\nMac" }))).toBe("bad_field:hostName");
    expect(problem(link({ ...GOOD, hostName: "Studio‮Mac" }))).toBe("bad_field:hostName");
  });

  it("will not encode a payload it would not parse", () => {
    expect(() => encodePairingLink({ ...GOOD, setupToken: "pst_x" })).toThrow(PairingLinkError);
    expect(() => encodePairingLink({ ...GOOD, hostName: "" })).toThrow(PairingLinkError);
    // Extra properties on the object passed in are not written.
    const wide = { ...GOOD, secret: "x" } as PairingLinkPayload;
    expect(parsePairingLink(encodePairingLink(wide))).toEqual(GOOD);
  });

  it("is short enough for a QR code a phone can scan", () => {
    expect(encodePairingLink(GOOD).length).toBeLessThan(450);
  });
});
