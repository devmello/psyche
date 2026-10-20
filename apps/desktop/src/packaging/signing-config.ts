import type { ForgePackagerOptions } from "@electron-forge/shared-types";

/**
 * Developer ID signing and notarization for `electron-forge package|make` (architecture §5;
 * security §11, §12). Everything comes from the environment and is off unless set, so CI and
 * local builds are unsigned by default. Never commit real values. See docs/signing.md.
 *
 *   PSYCHE_SIGN_IDENTITY  "Developer ID Application: Name (TEAMID)" → codesign, hardened runtime
 *   Notarization (needs signing), App Store Connect API key, preferred:
 *     APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER
 *   or Apple ID:
 *     APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 */

export type BuildEnv = Readonly<Record<string, string | undefined>>;

export type MacSigningOptions = Pick<ForgePackagerOptions, "osxSign" | "osxNotarize">;

type NotarizeCredentials = NonNullable<ForgePackagerOptions["osxNotarize"]>;

function value(env: BuildEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

/** API key credentials when all three are set, else Apple ID ones when all three are set. */
export function notarizeCredentials(env: BuildEnv): NotarizeCredentials | undefined {
  const appleApiKey = value(env, "APPLE_API_KEY");
  const appleApiKeyId = value(env, "APPLE_API_KEY_ID");
  const appleApiIssuer = value(env, "APPLE_API_ISSUER");
  if (appleApiKey && appleApiKeyId && appleApiIssuer) {
    return { appleApiKey, appleApiKeyId, appleApiIssuer };
  }
  const appleId = value(env, "APPLE_ID");
  const appleIdPassword = value(env, "APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = value(env, "APPLE_TEAM_ID");
  if (appleId && appleIdPassword && teamId) return { appleId, appleIdPassword, teamId };
  return undefined;
}

/**
 * `osxSign` / `osxNotarize` for the packager config. With PSYCHE_SIGN_IDENTITY: Developer ID, the
 * hardened runtime and notarization when credentials are complete. Without it and with
 * `adHoc` (a macOS build host): an ad-hoc signature over the whole bundle, inside out, so the
 * nested psyched binaries, the helper and the app agree (no hardened runtime, so library validation
 * does not block psyched's native addons; no timestamp server). Otherwise `{}`.
 * `ignore` skips files osx-sign must not sign itself (bundle-resources.ts `skipOuterSigning`).
 */
export function macSigningOptions(
  env: BuildEnv,
  opts: { entitlements: string; adHoc?: boolean; ignore?: (file: string) => boolean },
): MacSigningOptions {
  const identity = value(env, "PSYCHE_SIGN_IDENTITY");
  const ignore = opts.ignore ? { ignore: opts.ignore } : {};
  if (!identity) {
    if (!opts.adHoc) return {};
    return {
      osxSign: {
        identity: "-",
        identityValidation: false,
        continueOnError: false,
        preAutoEntitlements: false,
        optionsForFile: () => ({
          hardenedRuntime: false,
          entitlements: opts.entitlements,
          timestamp: "none",
        }),
        ...ignore,
      },
    };
  }
  const signing: MacSigningOptions = {
    osxSign: {
      identity,
      // A configured identity that fails to sign must fail the build, not ship unsigned.
      continueOnError: false,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: opts.entitlements }),
      ...ignore,
    },
  };
  const credentials = notarizeCredentials(env);
  if (credentials) signing.osxNotarize = credentials;
  return signing;
}

/** The Developer ID the build signs with, or undefined for ad-hoc / unsigned builds. */
export function signingIdentity(env: BuildEnv): string | undefined {
  return value(env, "PSYCHE_SIGN_IDENTITY");
}
