import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectSigningPayload } from "../src/lib/signing.ts";

// Shared fixture with apps/mac-helper/Tests (SigningPayloadTests) and the wire spec.
const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const FIXTURE_SHA256 = "724005f48718da546d4612ce25b78ff21172c0c3ae225f56774bd427e200c965";

describe("connectSigningPayload", () => {
  it("joins the fields with \\n after the psyche-connect-v1 tag", () => {
    const bytes = connectSigningPayload({
      nonce: NONCE,
      platform: "macos",
      deviceFamily: "mac-helper",
      protocolVersion: 1,
      serverOrigin: "http://127.0.0.1:7979",
    });
    expect(new TextDecoder().decode(bytes)).toBe(
      `psyche-connect-v1\n${NONCE}\nmacos\nmac-helper\n1\nhttp://127.0.0.1:7979`,
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FIXTURE_SHA256);
  });

  it("has no trailing newline", () => {
    const bytes = connectSigningPayload({
      nonce: "n",
      platform: "linux",
      deviceFamily: "desktop",
      protocolVersion: 2,
      serverOrigin: "o",
    });
    expect(new TextDecoder().decode(bytes)).toBe("psyche-connect-v1\nn\nlinux\ndesktop\n2\no");
  });
});
