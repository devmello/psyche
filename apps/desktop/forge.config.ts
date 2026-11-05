import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerAppImage } from "@reforged/maker-appimage";
import { parsePinnedRequirement } from "./src/main/update-gate.ts";
import {
  allowPartial,
  bundleSources,
  bundleSourcesWin32,
  copyBundleResources,
  copyBundleResourcesWin32,
  copyPinnedRequirements,
  HELPER_APP_NAME,
  isGatewayFile,
  skipOuterSigning,
  verifyNestedHelper,
} from "./src/packaging/bundle-resources.ts";
import {
  bundleSourcesLinux,
  copyBundleResourcesLinux,
  linuxIconSet,
  renameLinuxArtifacts,
} from "./src/packaging/linux-bundle.ts";
import { pruneLocales, pruneWin32Locales } from "./src/packaging/locales.ts";
import {
  describeSigning,
  macSigningOptions,
  signingIdentity,
  windowsSigning,
} from "./src/packaging/signing-config.ts";
import { pruneSwiftShader } from "./src/packaging/swiftshader.ts";
import { dropGatewayWebCopy } from "./src/packaging/web-copy.ts";

/**
 * Electron Forge 8 config (architecture §5; security §11, §12).
 *
 * Ad-hoc signed on macOS hosts by default (CI included), unsigned elsewhere. Signing with the
 * hardened runtime + entitlements.plist switches on when PSYCHE_SIGN_IDENTITY is set: Psyche's own
 * self-signed release certificate (the release path; deploy/macos/make-signing-cert.sh) or a
 * Developer ID. Notarization is Developer ID only and needs APPLE_API_KEY / APPLE_API_KEY_ID /
 * APPLE_API_ISSUER or APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID; without them it is
 * skipped and the build log says so (src/packaging/signing-config.ts, docs/signing.md). Never
 * commit real values.
 *
 * On macOS the bundle carries the Gateway (`Resources/psyched/`), its LaunchAgent template and the
 * Swift helper (src/packaging/bundle-resources.ts); packaging fails when one is missing unless
 * PSYCHE_PACKAGE_ALLOW_PARTIAL=1.
 *
 * On Windows (deploy/windows/build-local.ps1) `make` builds a Squirrel.Windows installer
 * (Psyche-<version>-Setup.exe, the full nupkg and RELEASES; per-user install in
 * %LOCALAPPDATA%\Psyche) and a portable zip. The package carries resources\psyched\ (with its own
 * node.exe), resources\win-helper\psyche-helper.exe and psyche-vm-svc.exe, and resources\tray.ico.
 * Authenticode signing
 * switches on with WINDOWS_CERTIFICATE_FILE / WINDOWS_CERTIFICATE_PASSWORD or the
 * AZURE_TRUSTED_SIGNING_* variables (signing-config.ts `windowsSigning`); unsigned otherwise.
 *
 * On Linux `make` builds a deb and an rpm (installed under /usr/lib/psyche, /usr/bin/psyche; the
 * makers fix those paths) and an AppImage, and renames them to Psyche-<version>-linux-<x64|arm64>.<ext>
 * (postMake). The package carries resources/psyched/ (with its own Node), the root-run installer
 * resources/psyche-system-setup with its payload resources/system/, and psyche-apprun, the
 * AppImage's launcher (src/packaging/linux-bundle.ts). Maintainer scripts are in
 * deploy/linux/scripts/. The Electron binary is `psyche`.
 */

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, "..", "..");
const isMacHost = process.platform === "darwin";
const isLinuxHost = process.platform === "linux";
const linuxDeploy = join(repoRoot, "deploy", "linux");
const linuxIcons = linuxIconSet(join(linuxDeploy, "root", "usr", "share", "icons", "hicolor"));
const linuxDescription = "Psyche, your personal AI agent";
const resolveFromHere = createRequire(import.meta.url);
const version = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
).version;

// Authenticode (Windows): one plan for the packager and the Squirrel maker. Trusted Signing reads
// its account and profile from a metadata file that signtool is pointed at.
const winSign = windowsSigning(process.env, join(tmpdir(), "psyche-trusted-signing.json"));
if (winSign?.azureMetadata)
  writeFileSync(winSign.azureMetadata.file, JSON.stringify(winSign.azureMetadata.json));
// @electron/windows-sign types `hashes` as a const enum; its values are these strings.
const windowsSign = winSign ? (winSign.options as never) : undefined;

/** `desktop` from deploy/macos/designated-requirements.txt; undefined while it is the placeholder. */
const pinnedDesktopRequirement = (() => {
  try {
    return parsePinnedRequirement(
      readFileSync(join(repoRoot, "deploy", "macos", "designated-requirements.txt"), "utf8"),
    );
  } catch {
    return undefined;
  }
})();

if (isMacHost) console.log(`[forge] ${describeSigning(process.env, { adHoc: true })}`);

/**
 * The Vite plugin packages only `.vite/`, so native modules the main bundle keeps external
 * (node-pty) are copied in after pruning: its JS, its package.json and the prebuilt binary for
 * the target. `asar.unpack` keeps the `.node` file and `spawn-helper` (macOS) or the `.dll` and
 * `.exe` helpers (Windows: winpty, conpty's OpenConsole.exe) on disk so they load, execute and get
 * signed. Debug symbols (`.pdb`, ≈ 30 MB on Windows) stay out.
 */
function copyNodePty(buildPath: string, platform: string, arch: string): void {
  const src = dirname(resolveFromHere.resolve("node-pty/package.json"));
  const dest = join(buildPath, "node_modules", "node-pty");
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, "package.json"), join(dest, "package.json"));
  cpSync(join(src, "lib"), join(dest, "lib"), { recursive: true });
  const prebuild = join("prebuilds", `${platform}-${arch}`);
  if (existsSync(join(src, prebuild))) {
    cpSync(join(src, prebuild), join(dest, prebuild), {
      recursive: true,
      filter: (f) => !f.endsWith(".pdb"),
    });
  }
  // Linux has no prebuild: the install step compiles into build/Release. On Windows that folder
  // holds only a copy of conpty; the prebuilds have everything.
  const compiled = join("build", "Release");
  if (platform !== "win32" && existsSync(join(src, compiled))) {
    cpSync(join(src, compiled), join(dest, compiled), { recursive: true });
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    name: "Psyche",
    // Linux packages start `psyche` (/usr/bin/psyche); macOS and Windows keep Psyche.
    executableName: isLinuxHost ? "psyche" : "Psyche",
    // apps/desktop/assets/icon.icns (and .png for the dev dock), from deploy/macos/make-icon.mjs;
    // icon.ico on Windows, from deploy/windows/make-icon.mjs.
    icon: join(root, "assets", "icon"),
    // Psyche.exe's version resource (Task Manager, the file's Properties, SmartScreen).
    win32metadata: {
      CompanyName: "Psyche",
      FileDescription: "Psyche",
      ProductName: "Psyche",
      InternalName: "Psyche",
      OriginalFilename: "Psyche.exe",
    },
    ...(windowsSign ? { windowsSign } : {}),
    appBundleId: "com.psyche.desktop",
    appCategoryType: "public.app-category.productivity",
    asar: { unpack: "{*.node,spawn-helper,*.dll,*.exe}" },
    // psyche:// deep links and psyche-pair: pairing links (CFBundleURLTypes). A pairing link only
    // opens the Add a Gateway field (src/lib/pair-link.ts).
    protocols: [
      { name: "Psyche", schemes: ["psyche"] },
      { name: "Psyche pairing link", schemes: ["psyche-pair"] },
    ],
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
      selfSigned: {
        entitlements: join(root, "entitlements.self-signed.plist"),
        gatewayEntitlements: join(root, "entitlements.self-signed.psyched.plist"),
        isGatewayFile,
      },
      pinnedDesktopRequirement,
      adHoc: isMacHost,
      ignore: skipOuterSigning,
    }),
  },
  // node-pty is N-API (node-addon-api): its prebuilds (darwin and win32, arm64 and x64) load in any
  // Electron, and on Linux its install step compiles one that does too. Rebuilding it from source
  // gains nothing and fails on Windows hosts without the Spectre-mitigated MSVC libraries, which
  // its binding.gyp asks for. copyNodePty above ships the prebuild.
  rebuildConfig: { ignoreModules: ["node-pty"] },
  // TODO(S22/C2): signed DMG and the release pipeline (manifest signed with the release key,
  // security §11). ZIP only until then.
  makers: [
    new MakerZIP({}, ["darwin", "linux", "win32"]),
    // Linux. electron-installer-debian/-redhat fix the install dir (/usr/lib/psyche) and the
    // launcher link (/usr/bin/psyche); the maintainer scripts call psyche-system-setup
    // (deploy/linux/psyche-system-setup) for the policy, unit and AppArmor profile, and tolerate failure.
    new MakerDeb(
      {
        options: {
          name: "psyche",
          productName: "Psyche",
          genericName: "AI assistant",
          description: linuxDescription,
          productDescription:
            "Psyche is a private AI assistant that runs on your computer, with its Gateway as a background service.",
          bin: "psyche",
          maintainer: "Psyche <devmello@users.noreply.github.com>",
          homepage: "https://github.com/devmello/psyche",
          section: "utils",
          categories: ["Office", "Utility"],
          mimeType: ["x-scheme-handler/psyche", "x-scheme-handler/psyche-pair"],
          icon: linuxIcons as never,
          recommends: ["pkexec | policykit-1", "libnotify-bin"],
          desktopTemplate: join(
            linuxDeploy,
            "root",
            "usr",
            "share",
            "applications",
            "psyche.desktop",
          ),
          scripts: {
            postinst: join(linuxDeploy, "scripts", "postinst"),
            prerm: join(linuxDeploy, "scripts", "prerm"),
          },
        },
      },
      ["linux"],
    ),
    new MakerRpm(
      {
        options: {
          name: "psyche",
          productName: "Psyche",
          genericName: "AI assistant",
          description: linuxDescription,
          productDescription:
            "Psyche is a private AI assistant that runs on your computer, with its Gateway as a background service.",
          bin: "psyche",
          license: "Apache-2.0",
          // rpm sorts 0.3.0.alpha.0 above 0.3.0; with a tilde the release wins (rpm >= 4.10).
          version: version.replace("-", "~"),
          homepage: "https://github.com/devmello/psyche",
          categories: ["Office", "Utility"],
          mimeType: ["x-scheme-handler/psyche", "x-scheme-handler/psyche-pair"],
          icon: linuxIcons as never,
          // Options electron-installer-redhat reads that the maker's types leave out.
          ...({
            specTemplate: join(linuxDeploy, "psyche.spec.ejs"),
            desktopTemplate: join(
              linuxDeploy,
              "root",
              "usr",
              "share",
              "applications",
              "psyche.desktop",
            ),
            scripts: {
              post: join(linuxDeploy, "scripts", "post"),
              preun: join(linuxDeploy, "scripts", "preun"),
            },
          } as object),
        },
      },
      ["linux"],
    ),
    // The AppImage maker's own AppRun is a symlink to `bin`, so `bin` is Psyche's AppRun script
    // (psyche-apprun, copied in by copyBundleResourcesLinux); it starts the `psyche` binary itself.
    new MakerAppImage(
      {
        options: {
          name: "psyche",
          productName: "Psyche",
          bin: "psyche-apprun",
          genericName: "AI assistant",
          categories: ["Office", "Utility"],
          mimeType: ["x-scheme-handler/psyche", "x-scheme-handler/psyche-pair"],
          desktopFile: join(linuxDeploy, "psyche-appimage.desktop"),
          icon: { ...linuxIcons, default: "256x256" } as never,
          // The type2 runtime reads zstd and zlib squashfs, not xz.
          compressor: "zstd",
        },
      },
      ["linux"],
    ),
    // Squirrel.Windows (cross-platform-2026.md §6 decision 5): per user, no admin, behind the signed
    // update manifest (src/main/updater.ts). Install events: src/main/squirrel-events.ts.
    new MakerSquirrel(
      {
        name: "Psyche", // the NuGet id: Psyche-<version>-full.nupkg (not the scoped package name)
        title: "Psyche",
        authors: "Psyche",
        description: "Psyche, your personal AI agent",
        exe: "Psyche.exe",
        setupExe: `Psyche-${version}-Setup.exe`,
        setupIcon: join(root, "assets", "icon.ico"),
        // Programs and Features shows <root>\app.ico. Squirrel downloads iconUrl into it after the
        // install hook only while it is missing, and the hook copies resources\icon.ico there
        // first (src/main/squirrel-events.ts), so an install fetches nothing and works offline.
        // The nuspec needs a URL all the same: this file:// one is local and never the network.
        iconUrl: pathToFileURL(join(root, "assets", "icon.ico")).href,
        noMsi: true,
        // The previous release's folder, for a delta nupkg (the release workflow sets it).
        ...(process.env.PSYCHE_SQUIRREL_REMOTE_RELEASES
          ? { remoteReleases: process.env.PSYCHE_SQUIRREL_REMOTE_RELEASES }
          : {}),
        ...(windowsSign ? { windowsSign } : {}),
      },
      ["win32"],
    ),
  ],
  hooks: {
    // Psyche-<version>-linux-<x64|arm64>.<deb|rpm|AppImage>: the names update-manifest.mjs reads.
    postMake: async (_config, results) => {
      if (process.platform === "linux") renameLinuxArtifacts(results, version, console.log);
      return results;
    },
    packageAfterPrune: async (_config, buildPath, _electronVersion, platform, arch) => {
      copyNodePty(buildPath, platform, arch);
      if (platform === "linux") {
        // buildPath is <out>/Psyche-linux-<arch>/resources/app.
        const resourcesDir = dirname(buildPath);
        copyBundleResourcesLinux(
          bundleSourcesLinux(process.env, repoRoot, arch),
          dirname(resourcesDir),
          { allowPartial: allowPartial(process.env), warn: (m) => console.warn(m) },
        );
        dropGatewayWebCopy(buildPath, resourcesDir);
        return;
      }
      if (platform === "win32") {
        // buildPath is <out>\Psyche-win32-<arch>\resources\app; the packager signs after this.
        const resourcesDir = dirname(buildPath);
        pruneWin32Locales(dirname(resourcesDir));
        copyBundleResourcesWin32(
          bundleSourcesWin32(process.env, repoRoot, arch),
          resourcesDir,
          arch,
          { allowPartial: allowPartial(process.env), warn: (m) => console.warn(m) },
        );
        dropGatewayWebCopy(buildPath, resourcesDir);
        return;
      }
      if (platform !== "darwin") return;
      // buildPath is Contents/Resources/app; osx-sign runs after this hook and seals the bundle.
      const resourcesDir = dirname(buildPath);
      pruneLocales(dirname(resourcesDir));
      pruneSwiftShader(dirname(resourcesDir));
      copyBundleResources(bundleSources(process.env, repoRoot, arch), resourcesDir, arch, {
        allowPartial: allowPartial(process.env),
        warn: (m) => console.warn(m),
      });
      // The updater runs only when the app's own signature satisfies this (update-gate.ts).
      copyPinnedRequirements(repoRoot, resourcesDir);
      // One UI copy: the Gateway serves the web client from app.asar (src/packaging/web-copy.ts).
      dropGatewayWebCopy(buildPath, resourcesDir);
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
