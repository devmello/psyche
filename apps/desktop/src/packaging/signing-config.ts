import type { ForgePackagerOptions } from "@electron-forge/shared-types";

/**
 * Code signing and notarization for `electron-forge package|make` (architecture §5; security §11,
 * §12; docs/design/updates-and-install-2026.md §2.3). Everything comes from the environment and is
 * off unless set, so CI and local builds are ad-hoc signed by default. Never commit real values.
 * See docs/signing.md.
 *
 *   PSYCHE_SIGN_IDENTITY  what to sign with, hardened runtime on. One of:
 *     the SHA-1 hash (or name "Psyche Release") of Psyche's own self-signed release certificate
 *                         (deploy/macos/make-signing-cert.sh). This is the release path.
 *     "Developer ID Application: Name (TEAMID)"   a paid Apple Developer ID (optional, "later")
 *   PSYCHE_SIGN_KEYCHAIN  optional keychain file that holds the identity (CI uses a temporary one),
 *                         so nothing has to be added to the keychain search list
 *   PSYCHE_SIGN_TIMESTAMP "1" asks Apple's timestamp server for a secure timestamp on a self-signed
 *                         identity (it works without a Developer ID; it needs the network). Default:
 *                         none. Developer ID signatures are always timestamped.
 *   Notarization, Developer ID only (a self-signed build skips it and says so). App Store Connect
 *   API key, preferred:
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

export type SigningKind =
  | "none"
  | "adhoc"
  | "developer-id"
  | "apple-development"
  | "self-signed"
  | "other";

/**
 * What an identity string is. Psyche's own self-signed certificate is named only by its SHA-1
 * (40 hex digits) or the exact name "Psyche Release": it has no team ID, so its designated
 * requirement is the certificate hash (`certificate leaf = H"<sha1>"`), and Gatekeeper does not
 * know it. Any other name is "other": signed as given with the hardened runtime, but never given
 * the self-signed relaxations (no library-validation exemption, no skipped identity validation).
 */
export function signingKind(identity: string | undefined): SigningKind {
  if (!identity) return "none";
  if (identity === "-") return "adhoc";
  if (identity.startsWith("Developer ID Application:")) return "developer-id";
  if (identity.startsWith("Apple Development:")) return "apple-development";
  if (/^[0-9a-fA-F]{40}$/.test(identity) || identity === "Psyche Release") return "self-signed";
  return "other";
}

/** The keychain file holding the signing identity, when it is not in the search list. */
export function signingKeychain(env: BuildEnv): string | undefined {
  return value(env, "PSYCHE_SIGN_KEYCHAIN");
}

function selfSignedTimestamp(env: BuildEnv): boolean {
  return value(env, "PSYCHE_SIGN_TIMESTAMP") === "1";
}

/** One line for the build log: how this build is signed and whether it will be notarized. */
export function describeSigning(env: BuildEnv, opts: { adHoc?: boolean } = {}): string {
  const kind = signingKind(value(env, "PSYCHE_SIGN_IDENTITY"));
  if (kind === "none") {
    return opts.adHoc
      ? "signing: ad-hoc (no PSYCHE_SIGN_IDENTITY); not notarized"
      : "signing: none";
  }
  if (kind === "developer-id") {
    return notarizeCredentials(env)
      ? "signing: Developer ID, hardened runtime; notarizing (Apple credentials found)"
      : "signing: Developer ID, hardened runtime; skipping notarization (no Apple API key or Apple ID credentials set)";
  }
  if (kind === "self-signed") {
    return `signing: self-signed identity, hardened runtime, ${
      selfSignedTimestamp(env) ? "secure timestamp" : "no timestamp"
    }; skipping notarization (no Apple API key is used with a self-signed build; users approve it once under Privacy & Security, Open Anyway)`;
  }
  return `signing: ${kind}, hardened runtime; skipping notarization (not a Developer ID)`;
}

/**
 * `osxSign` / `osxNotarize` for the packager config. With PSYCHE_SIGN_IDENTITY: the hardened
 * runtime, inside out (every nested helper, framework, psyched's Node runtime and each `.node`
 * addon). A Developer ID also gets a secure timestamp and notarization when credentials are
 * complete. A self-signed identity is not validated against keychain trust (it is never trusted,
 * and a build never changes trust settings), gets a timestamp only when asked, and is never
 * notarized. Without an identity and with `adHoc` (a macOS build host): an ad-hoc signature over
 * the whole bundle, inside out, so the nested psyched binaries, the helper and the app agree (no
 * hardened runtime, so library validation does not block psyched's native addons; no timestamp
 * server). Otherwise `{}`. `ignore` skips files osx-sign must not sign itself (bundle-resources.ts
 * `skipOuterSigning`).
 *
 * Library validation (self-signed only). With no team ID the hardened runtime refuses to load any
 * non-Apple library into a process, even one signed by the very same certificate ("mapping process
 * and mapped file (non-platform) have different Team IDs"): Electron cannot load its own framework
 * and psyched's Node cannot load better-sqlite3. `selfSigned` therefore names two entitlements
 * files that add `com.apple.security.cs.disable-library-validation`, and nothing else does: the
 * app and Electron's helpers get `selfSigned.entitlements`, and only the files under psyched/
 * (`selfSigned.isGatewayFile`; the entitlement matters on its Node runtime) get
 * `selfSigned.gatewayEntitlements` (allow-jit and that one). PsycheHelper.app links only system
 * libraries, signs itself and does not need it. A Developer ID build keeps `entitlements` for all
 * files: same team ID, validation stays on.
 */
export function macSigningOptions(
  env: BuildEnv,
  opts: {
    entitlements: string;
    selfSigned?: {
      entitlements: string;
      gatewayEntitlements: string;
      isGatewayFile: (file: string) => boolean;
    };
    /**
     * The pinned designated requirement of the outer app (`desktop` in
     * deploy/macos/designated-requirements.txt; undefined while it is still the placeholder). A
     * self-signed build passes it to codesign for `Psyche.app` itself, so the requirement is
     * written down in the repo rather than left to codesign's default.
     */
    pinnedDesktopRequirement?: string | undefined;
    adHoc?: boolean;
    ignore?: (file: string) => boolean;
  },
): MacSigningOptions {
  const identity = value(env, "PSYCHE_SIGN_IDENTITY");
  const kind = signingKind(identity);
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
  const keychain = signingKeychain(env);
  const selfSigned = kind === "self-signed";
  const sc = selfSigned ? opts.selfSigned : undefined;
  const pick = (file: string): string =>
    sc ? (sc.isGatewayFile(file) ? sc.gatewayEntitlements : sc.entitlements) : opts.entitlements;
  const signing: MacSigningOptions = {
    osxSign: {
      identity,
      // A configured identity that fails to sign must fail the build, not ship unsigned.
      continueOnError: false,
      // osx-sign's own check wants a trusted identity (`find-identity -v`). A self-signed one is by
      // design trusted nowhere, so codesign itself (and the verify after it) is the check.
      ...(selfSigned ? { identityValidation: false } : {}),
      ...(keychain ? { keychain } : {}),
      optionsForFile: (file: string) => ({
        hardenedRuntime: true,
        entitlements: pick(file),
        ...(selfSigned && !selfSignedTimestamp(env) ? { timestamp: "none" } : {}),
        ...(selfSigned && opts.pinnedDesktopRequirement && file.endsWith("/Psyche.app")
          ? { requirements: `=designated => ${opts.pinnedDesktopRequirement}` }
          : {}),
      }),
      ...ignore,
    },
  };
  // Notarization needs a Developer ID; a self-signed build skips it (describeSigning says so).
  const credentials = notarizeCredentials(env);
  if (credentials && kind === "developer-id") signing.osxNotarize = credentials;
  return signing;
}

/** The identity the build signs with (Developer ID, self-signed or other), or undefined. */
export function signingIdentity(env: BuildEnv): string | undefined {
  return value(env, "PSYCHE_SIGN_IDENTITY");
}
