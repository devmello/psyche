import { describe, expect, it } from "vitest";
import { isGatewayFile } from "../src/packaging/bundle-resources.ts";
import {
  describeSigning,
  macSigningOptions,
  signingKeychain,
  signingKind,
} from "../src/packaging/signing-config.ts";

/**
 * Signing for the free path: Psyche's own self-signed certificate (hash or name), hardened runtime,
 * no notarization, library validation relaxed only where it must be. The Developer ID path is
 * unchanged (forge-config.test.ts covers it too).
 */

const HASH = "70ae89ae6be8c7e90b31e81e38ae892402b33f04";
const DEV_ID = "Developer ID Application: Test Person (TEAM123456)";
const API = {
  APPLE_API_KEY: "/keys/AuthKey.p8",
  APPLE_API_KEY_ID: "KEYID",
  APPLE_API_ISSUER: "issuer-uuid",
};
const base = {
  entitlements: "/abs/entitlements.plist",
  selfSigned: {
    entitlements: "/abs/entitlements.self-signed.plist",
    gatewayEntitlements: "/abs/entitlements.self-signed.psyched.plist",
    isGatewayFile,
  },
};

function osxSign(env: Record<string, string>) {
  const opts = macSigningOptions(env, base);
  if (typeof opts.osxSign !== "object") throw new Error("osxSign missing");
  return { sign: opts.osxSign, opts };
}

function perFile(env: Record<string, string>, file: string) {
  const { sign } = osxSign(env);
  const fn = sign.optionsForFile;
  if (!fn) throw new Error("optionsForFile missing");
  return fn(file, {} as never) as Record<string, unknown>;
}

const APP = "/x/Psyche.app/Contents/MacOS/Psyche";
const NODE = "/x/Psyche.app/Contents/Resources/psyched/runtime/node";
const ADDON =
  "/x/Psyche.app/Contents/Resources/psyched/app/node_modules/better-sqlite3/prebuilds/darwin-arm64.node";

describe("signingKind", () => {
  it("tells Developer ID, ad-hoc, Apple Development and self-signed identities apart", () => {
    expect(signingKind(undefined)).toBe("none");
    expect(signingKind("-")).toBe("adhoc");
    expect(signingKind(DEV_ID)).toBe("developer-id");
    expect(signingKind("Apple Development: Test (ABC)")).toBe("apple-development");
    expect(signingKind(HASH)).toBe("self-signed");
    expect(signingKind("Psyche Release")).toBe("self-signed");
  });
});

describe("self-signed identity", () => {
  const env = { PSYCHE_SIGN_IDENTITY: HASH };

  it("signs with the hardened runtime, without keychain-trust validation and without notarizing", () => {
    const { sign, opts } = osxSign(env);
    expect(sign).toMatchObject({
      identity: HASH,
      identityValidation: false,
      continueOnError: false,
    });
    expect(opts.osxNotarize).toBeUndefined();
    expect(perFile(env, APP)).toMatchObject({ hardenedRuntime: true });
  });

  it("never notarizes, even when the Apple API key is set", () => {
    expect(macSigningOptions({ ...env, ...API }, base).osxNotarize).toBeUndefined();
    expect(
      macSigningOptions(
        { ...env, APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "p", APPLE_TEAM_ID: "T" },
        base,
      ).osxNotarize,
    ).toBeUndefined();
  });

  it("adds a timestamp only when PSYCHE_SIGN_TIMESTAMP=1", () => {
    expect(perFile(env, APP)).toMatchObject({ timestamp: "none" });
    expect(perFile({ ...env, PSYCHE_SIGN_TIMESTAMP: "0" }, APP)).toMatchObject({
      timestamp: "none",
    });
    // No `timestamp` key: osx-sign then passes a bare --timestamp (Apple's server).
    expect(perFile({ ...env, PSYCHE_SIGN_TIMESTAMP: "1" }, APP)).not.toHaveProperty("timestamp");
  });

  it("looks for the identity in PSYCHE_SIGN_KEYCHAIN when it is given", () => {
    expect(osxSign(env).sign.keychain).toBeUndefined();
    const withKc = osxSign({ ...env, PSYCHE_SIGN_KEYCHAIN: "/tmp/ci.keychain-db" });
    expect(withKc.sign.keychain).toBe("/tmp/ci.keychain-db");
    expect(signingKeychain({ PSYCHE_SIGN_KEYCHAIN: " " })).toBeUndefined();
  });

  it("relaxes library validation only on the app and psyched's files, never anywhere else", () => {
    // The app and Electron's helpers cannot load their own framework without it (no team ID).
    expect(perFile(env, APP)).toMatchObject({ entitlements: base.selfSigned.entitlements });
    // psyched's Node runtime and addons get the two-key plist.
    expect(perFile(env, NODE)).toMatchObject({ entitlements: base.selfSigned.gatewayEntitlements });
    expect(perFile(env, ADDON)).toMatchObject({
      entitlements: base.selfSigned.gatewayEntitlements,
    });
  });
});

describe("Developer ID path is unchanged", () => {
  const env = { PSYCHE_SIGN_IDENTITY: DEV_ID, ...API };

  it("keeps validation on (the one entitlements file), timestamps, validates the identity and notarizes", () => {
    const { sign, opts } = osxSign(env);
    expect(opts.osxNotarize).toEqual({
      appleApiKey: "/keys/AuthKey.p8",
      appleApiKeyId: "KEYID",
      appleApiIssuer: "issuer-uuid",
    });
    expect(sign.identityValidation).toBeUndefined();
    for (const f of [APP, NODE, ADDON]) {
      const o = perFile(env, f);
      expect(o).toMatchObject({ hardenedRuntime: true, entitlements: base.entitlements });
      expect(o).not.toHaveProperty("timestamp");
    }
  });

  it("without Apple credentials signs and skips notarization", () => {
    const { opts } = osxSign({ PSYCHE_SIGN_IDENTITY: DEV_ID });
    expect(opts.osxNotarize).toBeUndefined();
  });
});

describe("describeSigning (the line in the build log)", () => {
  it("says what happens to notarization in each mode", () => {
    expect(describeSigning({}, { adHoc: true })).toMatch(/ad-hoc.*not notarized/);
    expect(describeSigning({ PSYCHE_SIGN_IDENTITY: HASH })).toMatch(
      /self-signed.*no timestamp.*skipping notarization/,
    );
    expect(describeSigning({ PSYCHE_SIGN_IDENTITY: HASH, PSYCHE_SIGN_TIMESTAMP: "1" })).toMatch(
      /secure timestamp/,
    );
    expect(describeSigning({ PSYCHE_SIGN_IDENTITY: DEV_ID })).toMatch(/skipping notarization/);
    expect(describeSigning({ PSYCHE_SIGN_IDENTITY: DEV_ID, ...API })).toMatch(/notarizing/);
  });

  it("never prints a secret", () => {
    const line = describeSigning({
      PSYCHE_SIGN_IDENTITY: DEV_ID,
      APPLE_API_KEY: "/keys/AuthKey.p8",
      APPLE_API_KEY_ID: "KEYID",
      APPLE_API_ISSUER: "issuer-uuid",
    });
    for (const secret of ["AuthKey", "KEYID", "issuer-uuid"]) expect(line).not.toContain(secret);
  });
});
