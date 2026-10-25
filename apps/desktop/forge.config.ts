import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import {
  allowPartial,
  bundleSources,
  copyBundleResources,
  HELPER_APP_NAME,
  skipOuterSigning,
  verifyNestedHelper,
} from "./src/packaging/bundle-resources.ts";
import { pruneLocales } from "./src/packaging/locales.ts";
import { macSigningOptions, signingIdentity } from "./src/packaging/signing-config.ts";

/**
 * Electron Forge 8 config (architecture §5; security §11, §12).
 *
 * Ad-hoc signed on macOS hosts by default (CI included), unsigned elsewhere. Developer ID signing (hardened runtime +
 * entitlements.plist) and notarization switch on only when their environment variables are
 * set: PSYCHE_SIGN_IDENTITY, then APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER or
 * APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID (src/packaging/signing-config.ts,
 * docs/signing.md). Never commit real values.
 *
 * On macOS the bundle carries the Gateway (`Resources/psyched/`), its LaunchAgent template and the
 * Swift helper (src/packaging/bundle-resources.ts); packaging fails when one is missing unless
 * PSYCHE_PACKAGE_ALLOW_PARTIAL=1.
 */

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, "..", "..");
const isMacHost = process.platform === "darwin";
const resolveFromHere = createRequire(import.meta.url);

/**
 * The Vite plugin packages only `.vite/`, so native modules the main bundle keeps external
 * (node-pty) are copied in after pruning: its JS, its package.json and the prebuilt binary for
 * the target. `asar.unpack` keeps the `.node` file and `spawn-helper` on disk so they load,
 * execute and get signed.
 */
function copyNodePty(buildPath: string, platform: string, arch: string): void {
  const src = dirname(resolveFromHere.resolve("node-pty/package.json"));
  const dest = join(buildPath, "node_modules", "node-pty");
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, "package.json"), join(dest, "package.json"));
  cpSync(join(src, "lib"), join(dest, "lib"), { recursive: true });
  const prebuild = join("prebuilds", `${platform}-${arch}`);
  if (existsSync(join(src, prebuild))) {
    cpSync(join(src, prebuild), join(dest, prebuild), { recursive: true });
  }
  // Linux has no prebuild: the install step compiles into build/Release.
  const compiled = join("build", "Release");
  if (existsSync(join(src, compiled))) {
    cpSync(join(src, compiled), join(dest, compiled), { recursive: true });
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    name: "Psyche",
    executableName: "Psyche",
    // apps/desktop/assets/icon.icns (and .png for the dev dock), from deploy/macos/make-icon.mjs.
    icon: join(root, "assets", "icon"),
    appBundleId: "com.psyche.desktop",
    appCategoryType: "public.app-category.productivity",
    asar: { unpack: "{*.node,spawn-helper}" },
    // psyche:// deep links (CFBundleURLTypes).
    protocols: [{ name: "Psyche", schemes: ["psyche"] }],
    // macOS attributes the bundled helper's privacy requests to this outer bundle (the helper lives
    // in Contents/Resources), so every usage string the helper needs must be here too, or tccd
    // refuses the request without a prompt (#570). Keep the texts in step with
    // apps/mac-helper/Support/Info.plist; the legacy keys cover older macOS.
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Psyche uses the microphone for dictation when you hold the dictation key or press the mic button.",
      NSSpeechRecognitionUsageDescription:
        "Psyche uses macOS speech recognition on this Mac to turn your dictation into text.",
      NSRemindersFullAccessUsageDescription:
        "Psyche reads and adds reminders when you turn on the Reminders connector.",
      NSRemindersUsageDescription:
        "Psyche reads and adds reminders when you turn on the Reminders connector.",
      NSCalendarsFullAccessUsageDescription:
        "Psyche reads and adds calendar events when you turn on the Calendar connector. macOS has no read-only option.",
      NSCalendarsUsageDescription:
        "Psyche reads and adds calendar events when you turn on the Calendar connector. macOS has no read-only option.",
      NSContactsUsageDescription:
        "Psyche looks up the people you mention when you turn on the Contacts connector.",
      NSAppleEventsUsageDescription:
        "Psyche sends Apple Events to an app only when you ask it to act there, such as reading Notes, drafting Mail or running a Shortcut. macOS asks once for each app.",
      NSScreenCaptureUsageDescription:
        "Psyche looks at the screen only when an app's controls cannot be read. Its own windows, terminals and apps you set to Off are never captured.",
      LSUIElement: false,
    },
    ...macSigningOptions(process.env, {
      entitlements: join(root, "entitlements.plist"),
      adHoc: isMacHost,
      ignore: skipOuterSigning,
    }),
  },
  rebuildConfig: {},
  // TODO(S22/C2): signed DMG and the release pipeline (manifest signed with the release key,
  // security §11). ZIP only until then.
  makers: [new MakerZIP({}, ["darwin", "linux"])],
  hooks: {
    packageAfterPrune: async (_config, buildPath, _electronVersion, platform, arch) => {
      copyNodePty(buildPath, platform, arch);
      if (platform !== "darwin") return;
      // buildPath is Contents/Resources/app; osx-sign runs after this hook and seals the bundle.
      const resourcesDir = dirname(buildPath);
      pruneLocales(dirname(resourcesDir));
      copyBundleResources(bundleSources(process.env, repoRoot, arch), resourcesDir, arch, {
        allowPartial: allowPartial(process.env),
        warn: (m) => console.warn(m),
      });
      if (isMacHost)
        verifyNestedHelper(join(resourcesDir, HELPER_APP_NAME), signingIdentity(process.env));
    },
  },
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
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      // The renderer loads from the custom app:// scheme, so file:// needs no extra privileges.
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
