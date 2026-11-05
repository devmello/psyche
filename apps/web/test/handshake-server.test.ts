import { describe, expect, it } from "vitest";
import { Handshake } from "../src/client/handshake.ts";

/** The challenge's `server` reaches the verifier (updates design §2.10); junk is dropped. */

const nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

function handshake(seen: unknown[]) {
  return new Handshake(
    {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "dev_1",
      publicKey: "A".repeat(43),
      role: "client",
      platform: "web",
      deviceFamily: "web",
      name: "Psyche Web",
    },
    async () => "s".repeat(86),
    (challenge) => {
      seen.push(challenge.server);
      return { ok: true };
    },
  );
}

async function challengeWith(server: unknown): Promise<unknown[]> {
  const seen: unknown[] = [];
  const hs = handshake(seen);
  hs.start();
  await hs.onFrame({
    type: "res",
    id: "connect",
    ok: true,
    payload: {
      phase: "challenge",
      nonce,
      serverOrigin: "http://127.0.0.1:7979",
      protocolVersion: 1,
      expiresAt: "",
      ...(server === undefined ? {} : { server }),
    },
  });
  return seen;
}

describe("challenge server", () => {
  it("hands the verifier the version and build", async () => {
    expect(await challengeWith({ version: "0.5.0", build: "abc", commit: "c0ffee" })).toEqual([
      { version: "0.5.0", build: "abc" },
    ]);
  });

  it("passes none for a Gateway that sends none, or a malformed one", async () => {
    expect(await challengeWith(undefined)).toEqual([undefined]);
    expect(await challengeWith({ version: 5, build: "abc" })).toEqual([undefined]);
    expect(await challengeWith("abc")).toEqual([undefined]);
  });
});
