import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  connectSigningPayload,
  GATEWAY_SIGNING_PREFIX,
  gatewaySigningPayload,
  lanCertSigningPayload,
  Methods,
} from "../src/index.ts";

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

  // The Linux helper (apps/linux-helper/crates/protocol/src/signing.rs) pins the same hashes.
  it("matches the connect and LAN certificate fixtures the Linux helper pins", () => {
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const connect = {
      nonce: input.nonce,
      platform: "linux",
      deviceFamily: "linux-helper",
      protocolVersion: 1,
      serverOrigin: input.serverOrigin,
    };
    const gatewayKey = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
    expect(hash(connectSigningPayload(connect))).toBe(
      "5fa1fcf92d0724cd6b147ab58bcc1f38e5c23bc0c51771a56160faf960935fcf",
    );
    expect(hash(connectSigningPayload({ ...connect, gatewayKey }))).toBe(
      "c0fe7146e3e456afd5fe40584e41919c49496d72b1e7cf16c2ef96a30bc16e82",
    );
    expect(
      hash(
        lanCertSigningPayload({ ...input, spki: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk" }),
      ),
    ).toBe("254bbccd086863102a64c6fe4624552ac1edd7dd92e18cdec7e41f4cd51089d6");
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
