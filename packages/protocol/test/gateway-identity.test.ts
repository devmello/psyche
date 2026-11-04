import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GATEWAY_SIGNING_PREFIX, gatewaySigningPayload, Methods } from "../src/index.ts";

describe("gatewaySigningPayload (remote-gateway design §3.3)", () => {
  const input = {
    nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    serverOrigin: "https://studio-mac.tail1234.ts.net",
    devicePublicKey: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  };

  it("is the prefix, nonce, origin and device key, newline-delimited", () => {
    const text = new TextDecoder().decode(gatewaySigningPayload(input));
    expect(text).toBe(
      [GATEWAY_SIGNING_PREFIX, input.nonce, input.serverOrigin, input.devicePublicKey].join("\n"),
    );
    expect(GATEWAY_SIGNING_PREFIX).toBe("psyche-gateway-v1");
  });

  // The phone builds these bytes independently, so the bytes are pinned.
  it("matches the shared fixture", () => {
    expect(createHash("sha256").update(gatewaySigningPayload(input)).digest("hex")).toBe(
      "a7614e437ff769b36ea9d4c3ee5d134314525e23ae03bdcdfe243ef437bf0d3d",
    );
  });

  it("refuses a field that would make the payload ambiguous", () => {
    for (const key of ["nonce", "serverOrigin", "devicePublicKey"] as const) {
      expect(() => gatewaySigningPayload({ ...input, [key]: "a\nb" })).toThrow();
      expect(() => gatewaySigningPayload({ ...input, [key]: "" })).toThrow();
    }
  });

  it("registers gateway.info for any paired reader", () => {
    expect(Methods["gateway.info"].scope).toBe("operator.read");
  });
});
