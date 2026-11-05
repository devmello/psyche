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

/**
 * Authenticode signing for the Windows build (docs/signing.md "Windows"), gated on the environment
 * like Developer ID above: with nothing set the build is unsigned and still installs.
 *
 *   PFX certificate:
 *     WINDOWS_CERTIFICATE_FILE (path to the .pfx), WINDOWS_CERTIFICATE_PASSWORD
 *     WINDOWS_TIMESTAMP_SERVER (optional; default http://timestamp.digicert.com)
 *   or Azure Trusted Signing, through signtool's dlib:
 *     AZURE_TRUSTED_SIGNING_ENDPOINT   e.g. https://eus.codesigning.azure.net
 *     AZURE_TRUSTED_SIGNING_ACCOUNT    the code signing account name
 *     AZURE_TRUSTED_SIGNING_PROFILE    the certificate profile name
 *     AZURE_TRUSTED_SIGNING_DLIB       path to Azure.CodeSigning.Dlib.dll
 *     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (read by the dlib itself)
 *   WINDOWS_SIGNTOOL_PATH (optional): a Windows SDK signtool.exe; Trusted Signing needs one newer
 *   than the copy @electron/windows-sign vendors.
 *
 * The same options go to the packager, which signs every .exe, .dll and .node under the app folder
 * (Psyche.exe, resources\psyched\runtime\node.exe, the native addons,
 * resources\win-helper\psyche-helper.exe and psyche-vm-svc.exe, the sandbox PC service), and to the
 * Squirrel maker (Setup.exe, Update.exe). The bundle is copied in before the packager signs, so a
 * binary added to resources\ is signed without being listed anywhere; the app also refuses to
 * install an unsigned psyche-vm-svc.exe in a packaged build.
 */
export interface WindowsSigning {
  certificateFile?: string;
  certificatePassword?: string;
  signWithParams?: string;
  signToolPath?: string;
  timestampServer: string;
  description: string;
  website: string;
  /** SHA-256 only: SHA-1 Authenticode is long deprecated and Trusted Signing does not offer it. */
  hashes: string[];
}

export interface WindowsSigningPlan {
  kind: "pfx" | "azure-trusted-signing";
  options: WindowsSigning;
  /** Trusted Signing: this JSON must be at `file` (signWithParams names it) before signing. */
  azureMetadata?: { file: string; json: Record<string, string> };
}

const WIN_SIGN_COMMON = {
  description: "Psyche",
  website: "https://github.com/devmello/psyche",
  hashes: ["sha256"],
};

/** The Windows signing plan, or undefined for an unsigned build. */
export function windowsSigning(
  env: BuildEnv,
  metadataFile: string,
): WindowsSigningPlan | undefined {
  const signToolPath = value(env, "WINDOWS_SIGNTOOL_PATH");
  const tool = signToolPath ? { signToolPath } : {};
  const certificateFile = value(env, "WINDOWS_CERTIFICATE_FILE");
  const certificatePassword = value(env, "WINDOWS_CERTIFICATE_PASSWORD");
  if (certificateFile && certificatePassword) {
    return {
      kind: "pfx",
      options: {
        ...WIN_SIGN_COMMON,
        ...tool,
        certificateFile,
        certificatePassword,
        timestampServer: value(env, "WINDOWS_TIMESTAMP_SERVER") ?? "http://timestamp.digicert.com",
      },
    };
  }
  const endpoint = value(env, "AZURE_TRUSTED_SIGNING_ENDPOINT");
  const account = value(env, "AZURE_TRUSTED_SIGNING_ACCOUNT");
  const profile = value(env, "AZURE_TRUSTED_SIGNING_PROFILE");
  const dlib = value(env, "AZURE_TRUSTED_SIGNING_DLIB");
  if (endpoint && account && profile && dlib) {
    return {
      kind: "azure-trusted-signing",
      options: {
        ...WIN_SIGN_COMMON,
        ...tool,
        signWithParams: `/v /dlib "${dlib}" /dmdf "${metadataFile}"`,
        timestampServer: "http://timestamp.acs.microsoft.com",
      },
      azureMetadata: {
        file: metadataFile,
        json: {
          Endpoint: endpoint,
          CodeSigningAccountName: account,
          CertificateProfileName: profile,
        },
      },
    };
  }
  return undefined;
}
