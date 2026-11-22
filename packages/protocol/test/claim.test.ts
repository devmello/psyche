import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimProof,
  deriveClaimKey,
  isClaimedHome,
  makeSetupCode,
  markClaimed,
  proofsEqual,
  randomSetupCode,
  readSetupCode,
  removeSetupCode,
  setupCodePath,
} from "../src/claim-node.ts";
import {
  CLAIM_SCOPES,
  CLAIM_TRANSCRIPT_PREFIX,
  claimTranscript,
  formatSetupCode,
  normalizeSetupCode,
  SETUP_CODE_ALPHABET,
  validateParams,
  validateResult,
} from "../src/index.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "psyche-claim-proto-"));
  homes.push(h);
  return h;
};

const T = {
  clientNonce: "c".repeat(43),
  serverNonce: "s".repeat(43),
  salt: "a".repeat(22),
  gatewayKey: "K".repeat(43),
  certSpki: "P".repeat(43),
  deviceId: "dev_1",
  devicePublicKey: "D".repeat(43),
};

describe("setup codes", () => {
  it("normalizes what people type and refuses anything else", () => {
    const good: [string, string][] = [
      ["7K3QM-XR2TD", "7K3QMXR2TD"],
      ["7k3qm xr2td", "7K3QMXR2TD"],
      [" 7K3QM - XR2TD ", "7K3QMXR2TD"],
      // Crockford's look-alikes: O is 0, I and L are 1.
      ["O0IIL-00000", "0011100000"],
    ];
    for (const [typed, want] of good) expect(normalizeSetupCode(typed), typed).toBe(want);
    const bad = [
      "",
      "7K3QM",
      "7K3QM-XR2TD0",
      "7K3QM-XR2TU",
      "7K3QM_XR2TD",
      "7K3QM-XR2T!",
      "x".repeat(65),
    ];
    for (const typed of bad) expect(normalizeSetupCode(typed), typed).toBeNull();
    expect(formatSetupCode("7k3qmxr2td")).toBe("7K3QM-XR2TD");
    expect(() => formatSetupCode("nope")).toThrow();
  });

  it("makes codes of ten characters from the alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = randomSetupCode();
      expect(c).toHaveLength(10);
      for (const ch of c) expect(SETUP_CODE_ALPHABET).toContain(ch);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
  });

  it("stores only the salt and the derived key, at 0600, for a day", async () => {
    const h = home();
    const now = new Date("2026-11-21T10:00:00.000Z");
    const { code, expiresAt } = await makeSetupCode(h, now);
    expect(expiresAt).toBe("2026-11-22T10:00:00.000Z");
    const file = setupCodePath(h);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = readSetupCode(h, now);
    if (stored === null || stored === "expired") throw new Error("no code stored");
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored.key.equals(await deriveClaimKey(code, stored.salt))).toBe(true);
    expect(readSetupCode(h, new Date("2026-11-22T10:00:00.000Z"))).toBe("expired");
    removeSetupCode(h);
    expect(readSetupCode(h, now)).toBeNull();
    // A damaged file reads as no code, never as a code.
    writeFileSync(file, "{not json");
    expect(readSetupCode(h, now)).toBeNull();
  });

  it("marks a home claimed once", () => {
    const h = home();
    expect(isClaimedHome(h)).toBe(false);
    markClaimed(h, "terminal");
    markClaimed(h, "claim");
    expect(isClaimedHome(h)).toBe(true);
  });
});

describe("the claim proofs", () => {
  it("bind every value of the transcript, in order, after the label", () => {
    const t = claimTranscript(T);
    expect(t.split("\n")).toEqual([
      CLAIM_TRANSCRIPT_PREFIX,
      T.clientNonce,
      T.serverNonce,
      T.salt,
      T.gatewayKey,
      T.certSpki,
      T.deviceId,
      T.devicePublicKey,
    ]);
    for (const k of Object.keys(T) as (keyof typeof T)[]) {
      expect(() => claimTranscript({ ...T, [k]: "" }), k).toThrow();
      expect(() => claimTranscript({ ...T, [k]: "a\nb" }), k).toThrow();
    }
  });

  it("differ by role and by any changed value, and match only for the same key", async () => {
    const salt = Buffer.alloc(16, 7);
    const key = await deriveClaimKey("7K3QMXR2TD", salt);
    const t = claimTranscript(T);
    const client = claimProof(key, "client", t);
    expect(proofsEqual(client, claimProof(key, "client", t))).toBe(true);
    // The server's proof is not the client's: neither side can echo the other's back.
    expect(proofsEqual(client, claimProof(key, "server", t))).toBe(false);
    // Another certificate (a relay) or another device key gives another proof.
    expect(
      proofsEqual(
        client,
        claimProof(key, "client", claimTranscript({ ...T, certSpki: "Q".repeat(43) })),
      ),
    ).toBe(false);
    expect(
      proofsEqual(
        client,
        claimProof(key, "client", claimTranscript({ ...T, devicePublicKey: "E".repeat(43) })),
      ),
    ).toBe(false);
    // Another code, or the same code under another salt.
    expect(
      proofsEqual(client, claimProof(await deriveClaimKey("7K3QMXR2TE", salt), "client", t)),
    ).toBe(false);
    expect(
      proofsEqual(
        client,
        claimProof(await deriveClaimKey("7K3QMXR2TD", Buffer.alloc(16, 8)), "client", t),
      ),
    ).toBe(false);
    // Typed differently, the same code.
    expect(key.equals(await deriveClaimKey("7k3qm-xr2td", salt))).toBe(true);
    expect(proofsEqual(client, "short")).toBe(false);
  });
});

describe("the claim methods on the wire", () => {
  it("validate their params and results", () => {
    const hello = {
      clientNonce: "c".repeat(43),
      deviceId: "dev_1",
      publicKey: "D".repeat(43),
      name: "Psyche Desktop (mac)",
      platform: "macos",
    };
    expect(() => validateParams("gateway.claim.hello", hello)).not.toThrow();
    expect(() => validateParams("gateway.claim.hello", { ...hello, clientNonce: 1 })).toThrow();
    expect(() => validateParams("gateway.claim.prove", { proof: "p".repeat(43) })).not.toThrow();
    expect(() => validateParams("gateway.claim.finish", { keepLan: true })).not.toThrow();
    expect(() => validateParams("gateway.claim.finish", {})).toThrow();
    expect(() =>
      validateResult("gateway.claim.prove", {
        proof: "p".repeat(43),
        deviceId: "dev_1",
        scopes: [...CLAIM_SCOPES],
      }),
    ).not.toThrow();
    expect(CLAIM_SCOPES).toEqual([
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.admin",
    ]);
  });
});
