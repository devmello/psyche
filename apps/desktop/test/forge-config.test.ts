import { FuseV1Options } from "@electron/fuses";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { macSigningOptions, notarizeCredentials } from "../src/packaging/signing-config.ts";

const SIGNING_VARS = [
  "PSYCHE_SIGN_IDENTITY",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

const identity = "Developer ID Application: Test Person (TEAM123456)";
const entitlements = "/abs/entitlements.plist";

type LoadedConfig = Required<Pick<ForgeConfig, "packagerConfig" | "plugins">>;

async function loadConfig(env: Record<string, string>): Promise<LoadedConfig> {
  for (const key of SIGNING_VARS) vi.stubEnv(key, env[key] ?? "");
  vi.resetModules();
  const { packagerConfig, plugins } = (await import("../forge.config.ts")).default;
  if (!packagerConfig || !plugins) throw new Error("forge config is missing sections");
  return { packagerConfig, plugins };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("forge.config.ts", () => {
  it("is unsigned when no signing variables are set", async () => {
    const config = await loadConfig({});
    expect(config.packagerConfig.osxSign).toBeUndefined();
    expect(config.packagerConfig.osxNotarize).toBeUndefined();
  });

  it("signs with the hardened runtime and entitlements.plist when PSYCHE_SIGN_IDENTITY is set", async () => {
    const config = await loadConfig({ PSYCHE_SIGN_IDENTITY: identity });
    const sign = config.packagerConfig.osxSign;
    if (typeof sign !== "object") throw new Error("osxSign missing");
    expect(sign.identity).toBe(identity);
    const perFile = sign.optionsForFile?.("/x/Psyche.app", { platform: "darwin" });
    expect(perFile?.hardenedRuntime).toBe(true);
    expect(String(perFile?.entitlements)).toMatch(/apps\/desktop\/entitlements\.plist$/);
    expect(config.packagerConfig.osxNotarize).toBeUndefined();
  });

  it("registers psyche:// and the microphone usage string", async () => {
    const { packagerConfig } = await loadConfig({});
    expect(packagerConfig.protocols).toEqual([{ name: "Psyche", schemes: ["psyche"] }]);
    expect(packagerConfig.extendInfo).toMatchObject({
      NSMicrophoneUsageDescription: expect.stringContaining("dictation"),
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
