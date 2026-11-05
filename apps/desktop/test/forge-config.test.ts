import { FuseV1Options } from "@electron/fuses";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  macSigningOptions,
  notarizeCredentials,
  windowsSigning,
} from "../src/packaging/signing-config.ts";

const SIGNING_VARS = [
  "PSYCHE_SIGN_IDENTITY",
  "WINDOWS_CERTIFICATE_FILE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT",
  "AZURE_TRUSTED_SIGNING_PROFILE",
  "AZURE_TRUSTED_SIGNING_DLIB",
  "PSYCHE_SIGN_KEYCHAIN",
  "PSYCHE_SIGN_TIMESTAMP",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

const identity = "Developer ID Application: Test Person (TEAM123456)";
const entitlements = "/abs/entitlements.plist";

type LoadedConfig = Required<Pick<ForgeConfig, "packagerConfig" | "plugins" | "makers">>;

async function loadConfig(env: Record<string, string>): Promise<LoadedConfig> {
  for (const key of SIGNING_VARS) vi.stubEnv(key, env[key] ?? "");
  vi.resetModules();
  const { packagerConfig, plugins, makers } = (await import("../forge.config.ts")).default;
  if (!packagerConfig || !plugins || !makers) throw new Error("forge config is missing sections");
  return { packagerConfig, plugins, makers };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("forge.config.ts", () => {
  it("signs ad-hoc on macOS hosts (unsigned elsewhere) when no signing variables are set", async () => {
    const config = await loadConfig({});
    const sign = config.packagerConfig.osxSign;
    if (process.platform === "darwin") {
      if (typeof sign !== "object") throw new Error("osxSign missing");
      expect(sign.identity).toBe("-");
      const perFile = sign.optionsForFile?.("/x/Psyche.app", { platform: "darwin" });
      expect(perFile).toMatchObject({ hardenedRuntime: false, timestamp: "none" });
    } else {
      expect(sign).toBeUndefined();
    }
    expect(config.packagerConfig.osxNotarize).toBeUndefined();
  });

  it("signs with the hardened runtime and entitlements.plist when PSYCHE_SIGN_IDENTITY is set", async () => {
    const config = await loadConfig({ PSYCHE_SIGN_IDENTITY: identity });
    const sign = config.packagerConfig.osxSign;
    if (typeof sign !== "object") throw new Error("osxSign missing");
    expect(sign.identity).toBe(identity);
    const perFile = sign.optionsForFile?.("/x/Psyche.app", { platform: "darwin" });
    expect(perFile?.hardenedRuntime).toBe(true);
    expect(String(perFile?.entitlements)).toMatch(/apps[\\/]desktop[\\/]entitlements\.plist$/);
    expect(config.packagerConfig.osxNotarize).toBeUndefined();
  });

  it("registers psyche:// and the microphone usage string", async () => {
    const { packagerConfig } = await loadConfig({});
    expect(packagerConfig.protocols).toEqual([
      { name: "Psyche", schemes: ["psyche"] },
      { name: "Psyche pairing link", schemes: ["psyche-pair"] },
    ]);
    expect(packagerConfig.extendInfo).toMatchObject({
      NSMicrophoneUsageDescription: expect.stringContaining("dictation"),
      // tccd attributes the nested helper's requests to this bundle (#570): every string the
      // helper's Info.plist declares must be here too, or macOS refuses without a prompt.
      NSRemindersFullAccessUsageDescription: expect.stringContaining("reminders"),
      NSRemindersUsageDescription: expect.stringContaining("reminders"),
      NSCalendarsFullAccessUsageDescription: expect.stringContaining("calendar"),
      NSCalendarsUsageDescription: expect.stringContaining("calendar"),
      NSContactsUsageDescription: expect.stringContaining("people"),
      NSAppleEventsUsageDescription: expect.stringContaining("Apple Events"),
      NSSpeechRecognitionUsageDescription: expect.stringContaining("speech"),
      NSScreenCaptureUsageDescription: expect.stringContaining("screen"),
      LSUIElement: false,
    });
  });

  it("flips the security fuses", async () => {
    const config = await loadConfig({});
    const fuses = config.plugins.find((p) => p instanceof FusesPlugin);
    if (!(fuses instanceof FusesPlugin)) throw new Error("FusesPlugin missing");
    expect(fuses.fusesConfig).toMatchObject({
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    });
  });
});

describe("macSigningOptions", () => {
  it("signs ad-hoc without an identity only when asked, never notarizing", () => {
    const opts = macSigningOptions(
      { APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "p", APPLE_TEAM_ID: "T" },
      { entitlements, adHoc: true, ignore: () => false },
    );
    expect(opts.osxNotarize).toBeUndefined();
    if (typeof opts.osxSign !== "object") throw new Error("osxSign missing");
    expect(opts.osxSign).toMatchObject({ identity: "-", identityValidation: false });
    expect(typeof opts.osxSign.ignore).toBe("function");
  });

  it("returns nothing without an identity, even with notarization credentials", () => {
    expect(
      macSigningOptions(
        { APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "p", APPLE_TEAM_ID: "T" },
        { entitlements },
      ),
    ).toEqual({});
    expect(macSigningOptions({ PSYCHE_SIGN_IDENTITY: "  " }, { entitlements })).toEqual({});
  });

  it("prefers App Store Connect API key credentials", () => {
    const opts = macSigningOptions(
      {
        PSYCHE_SIGN_IDENTITY: identity,
        APPLE_API_KEY: "/keys/AuthKey.p8",
        APPLE_API_KEY_ID: "KEYID",
        APPLE_API_ISSUER: "issuer-uuid",
        APPLE_ID: "a@b.c",
        APPLE_APP_SPECIFIC_PASSWORD: "p",
        APPLE_TEAM_ID: "T",
      },
      { entitlements },
    );
    expect(opts.osxNotarize).toEqual({
      appleApiKey: "/keys/AuthKey.p8",
      appleApiKeyId: "KEYID",
      appleApiIssuer: "issuer-uuid",
    });
    expect(typeof opts.osxSign === "object" && opts.osxSign.continueOnError).toBe(false);
  });

  it("falls back to Apple ID credentials and ignores partial sets", () => {
    expect(
      notarizeCredentials({
        APPLE_ID: "a@b.c",
        APPLE_APP_SPECIFIC_PASSWORD: "p",
        APPLE_TEAM_ID: "T",
      }),
    ).toEqual({ appleId: "a@b.c", appleIdPassword: "p", teamId: "T" });
    expect(notarizeCredentials({ APPLE_API_KEY: "/k.p8", APPLE_API_KEY_ID: "K" })).toBeUndefined();
    expect(notarizeCredentials({ APPLE_ID: "a@b.c", APPLE_TEAM_ID: "T" })).toBeUndefined();
  });
});

describe("Windows packaging", () => {
  it("makes a Squirrel installer and a zip for win32, unsigned without credentials", async () => {
    const config = await loadConfig({});
    const byName = (n: string) =>
      config.makers.find((m) => typeof m === "object" && "name" in m && m.name === n) as
        | { configOrConfigFetcher: Record<string, unknown>; platformsToMakeOn?: string[] }
        | undefined;
    const squirrel = byName("squirrel");
    expect(squirrel?.platformsToMakeOn).toEqual(["win32"]);
    expect(squirrel?.configOrConfigFetcher).toMatchObject({
      name: "Psyche",
      exe: "Psyche.exe",
      noMsi: true,
      setupExe: expect.stringMatching(/^Psyche-\d+\.\d+\.\d+.*-Setup\.exe$/),
      setupIcon: expect.stringMatching(/icon\.ico$/),
    });
    expect(squirrel?.configOrConfigFetcher.windowsSign).toBeUndefined();
    expect(byName("zip")?.platformsToMakeOn).toContain("win32");
    expect(config.packagerConfig.windowsSign).toBeUndefined();
    expect(config.packagerConfig.win32metadata).toMatchObject({ OriginalFilename: "Psyche.exe" });
    // winpty and conpty's helpers load from disk, not from inside app.asar.
    expect(config.packagerConfig.asar).toEqual({ unpack: "{*.node,spawn-helper,*.dll,*.exe}" });
  });

  it("signs the package and the installer with a PFX when both variables are set", async () => {
    const config = await loadConfig({
      WINDOWS_CERTIFICATE_FILE: "C:/certs/psyche.pfx",
      WINDOWS_CERTIFICATE_PASSWORD: "pw",
    });
    expect(config.packagerConfig.windowsSign).toMatchObject({
      certificateFile: "C:/certs/psyche.pfx",
      certificatePassword: "pw",
      hashes: ["sha256"],
    });
  });
});

describe("windowsSigning", () => {
  it("is off without credentials and with half a PFX pair", () => {
    expect(windowsSigning({}, "m.json")).toBeUndefined();
    expect(windowsSigning({ WINDOWS_CERTIFICATE_FILE: "a.pfx" }, "m.json")).toBeUndefined();
    expect(
      windowsSigning({ AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net" }, "m"),
    ).toBeUndefined();
  });

  it("uses Azure Trusted Signing through signtool's dlib and its metadata file", () => {
    const plan = windowsSigning(
      {
        AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
        AZURE_TRUSTED_SIGNING_ACCOUNT: "psyche",
        AZURE_TRUSTED_SIGNING_PROFILE: "public",
        AZURE_TRUSTED_SIGNING_DLIB: "C:/dlib/Azure.CodeSigning.Dlib.dll",
        WINDOWS_SIGNTOOL_PATH: "C:/sdk/signtool.exe",
      },
      "C:/tmp/meta.json",
    );
    expect(plan?.kind).toBe("azure-trusted-signing");
    expect(plan?.options).toMatchObject({
      signToolPath: "C:/sdk/signtool.exe",
      signWithParams: '/v /dlib "C:/dlib/Azure.CodeSigning.Dlib.dll" /dmdf "C:/tmp/meta.json"',
      timestampServer: "http://timestamp.acs.microsoft.com",
    });
    expect(plan?.azureMetadata).toEqual({
      file: "C:/tmp/meta.json",
      json: {
        Endpoint: "https://eus.codesigning.azure.net",
        CodeSigningAccountName: "psyche",
        CertificateProfileName: "public",
      },
    });
  });
});
