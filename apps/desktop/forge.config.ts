import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

/**
 * Electron Forge 8 config (architecture §5). Unsigned by default; CI builds unsigned.
 * Developer ID signing and notarization (S11) read credentials from the environment only:
 *   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD (never commit real values).
 */
const config: ForgeConfig = {
  packagerConfig: {
    name: "Psyche",
    executableName: "Psyche",
    appBundleId: "com.psyche.desktop",
    appCategoryType: "public.app-category.productivity",
    asar: true,
    // osxSign: {
    //   identity: "Developer ID Application: <name> (<APPLE_TEAM_ID>)",
    //   optionsForFile: () => ({ hardenedRuntime: true, entitlements: "entitlements.plist" }),
    // },
    // osxNotarize: {
    //   appleId: process.env.APPLE_ID ?? "",
    //   appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD ?? "",
    //   teamId: process.env.APPLE_TEAM_ID ?? "",
    // },
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ["darwin", "linux"])],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    // Fuses are flipped at package time (architecture §5, security §12).
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // GrantFileProtocolExtraPrivileges stays at its default while the renderer loads from
      // file://; S11 moves the renderer to a custom app:// scheme and then turns it off.
    }),
  ],
};

export default config;
