import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { BuildEnv } from "./signing-config.ts";

/**
 * The pieces that make Psyche.app self-contained (docs/archive/status/s22.md "Packaging layout",
 * docs/archive/status/s14.md "Packaging"). Paths are relative to `Psyche.app/Contents/Resources/`:
 *
 *   psyched/                         S22's Gateway bundle, copied verbatim (never into app.asar)
 *   launchd/com.psyche.gateway.plist the LaunchAgent template ({{PSYCHED}}, {{PSYCHE_HOME}}),
 *                                    rendered by the supervisor at install time
 *   PsycheHelper.app                 S14's Swift helper (com.psyche.helper), launched with `open`
 *   designated-requirements.txt      the pinned code requirement (deploy/macos/designated-requirements.txt);
 *                                    the updater runs only when the app's own signature satisfies it
 *
 * The package step fails when a piece is missing unless PSYCHE_PACKAGE_ALLOW_PARTIAL=1, so a
 * release never ships an app that cannot start its Gateway.
 */

export const HELPER_APP_NAME = "PsycheHelper.app";
export const BUNDLED_PSYCHED_DIR = "psyched";
export const BUNDLED_PLIST = join("launchd", "com.psyche.gateway.plist");
const PLIST_TEMPLATE = "com.psyche.gateway.plist.template";

export interface BundleSources {
  /** apps/gateway/dist-bin/darwin-<arch>/psyched (or PSYCHE_PSYCHED_DIR). */
  psychedDir: string;
  /** apps/mac-helper/dist/PsycheHelper.app (or PSYCHE_HELPER_APP). */
  helperApp: string;
}

export interface BundlePiece {
  name: string;
  /** File or directory copied to `dest`. */
  source: string;
  /** The file whose presence proves the piece was built. */
  marker: string;
  /** Other paths a complete build has (psyched's bundled skills, #506). */
  alsoRequires?: string[];
  dest: string;
  /** How to build it, for the error message. */
  build: string;
}

function value(env: BuildEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

export function bundleSources(env: BuildEnv, repoRoot: string, arch: string): BundleSources {
  return {
    psychedDir:
      value(env, "PSYCHE_PSYCHED_DIR") ??
      join(repoRoot, "apps", "gateway", "dist-bin", `darwin-${arch}`, BUNDLED_PSYCHED_DIR),
    helperApp:
      value(env, "PSYCHE_HELPER_APP") ??
      join(repoRoot, "apps", "mac-helper", "dist", HELPER_APP_NAME),
  };
}

export function bundlePieces(
  sources: BundleSources,
  resourcesDir: string,
  arch: string,
): BundlePiece[] {
  const psyched = `node deploy/scripts/build-psyched.mjs --arch ${arch}`;
  return [
    {
      name: "psyched (the Gateway)",
      source: sources.psychedDir,
      marker: join(sources.psychedDir, "psyched"),
      // A psyched without its skills folder lists no bundled skills (#506): not shippable.
      alsoRequires: [join(sources.psychedDir, "app", "skills", "README.md")],
      dest: join(resourcesDir, BUNDLED_PSYCHED_DIR),
      build: psyched,
    },
    {
      name: "LaunchAgent plist template",
      source: join(sources.psychedDir, PLIST_TEMPLATE),
      marker: join(sources.psychedDir, PLIST_TEMPLATE),
      dest: join(resourcesDir, BUNDLED_PLIST),
      build: psyched,
    },
    {
      name: HELPER_APP_NAME,
      source: sources.helperApp,
      marker: join(sources.helperApp, "Contents", "MacOS", "psyche-helper"),
      dest: join(resourcesDir, HELPER_APP_NAME),
      build: `deploy/macos/build-helper.sh --arch ${arch}`,
    },
  ];
}

/**
 * The Windows package (deploy/windows/build-local.ps1). Paths are relative to `resources\` next to
 * Psyche.exe (`%LOCALAPPDATA%\Psyche\app-<version>\resources\` once installed):
 *
 *   psyched\                  the Gateway bundle (build-psyched.mjs on Windows): psyched.cmd,
 *                             runtime\node.exe, app\, service-host.mjs and
 *                             psyche-gateway.task.xml.template for the \Psyche\Gateway-<SID> task
 *   win-helper\psyche-helper.exe   the Rust helper (apps/win-helper, cargo build --release)
 *   win-helper\psyche-vm-svc.exe   the sandbox PC's service (same workspace); installed elevated by
 *                             "Turn on the sandbox PC", signed like the helper
 *   tray.ico                  the notification-area icon (deploy/windows/make-icon.mjs)
 *   icon.ico                  the app icon as a file: the install hook copies it to
 *                             <root>\app.ico for Programs and Features (squirrel-events.ts)
 *
 * The macOS pieces (LaunchAgent plist, PsycheHelper.app) are not part of it.
 */
export const WIN_HELPER_DIR = "win-helper";
export const WIN_HELPER_EXE = "psyche-helper.exe";
export const WIN_VM_SERVICE_EXE = "psyche-vm-svc.exe";
export const TRAY_ICON = "tray.ico";
export const APP_ICON = "icon.ico";

export interface BundleSourcesWin32 {
  /** apps/gateway/dist-bin/win32-<arch>/psyched (or PSYCHE_PSYCHED_DIR). */
  psychedDir: string;
  /** apps/win-helper/target/release/psyche-helper.exe (or PSYCHE_WIN_HELPER_EXE). */
  helperExe: string;
  /** apps/win-helper/target/release/psyche-vm-svc.exe (or PSYCHE_WIN_VM_SVC_EXE). */
  vmServiceExe: string;
  /** apps/desktop/assets/tray.ico. */
  trayIcon: string;
  /** apps/desktop/assets/icon.ico. */
  appIcon: string;
}

export function bundleSourcesWin32(
  env: BuildEnv,
  repoRoot: string,
  arch: string,
): BundleSourcesWin32 {
  return {
    psychedDir:
      value(env, "PSYCHE_PSYCHED_DIR") ??
      join(repoRoot, "apps", "gateway", "dist-bin", `win32-${arch}`, BUNDLED_PSYCHED_DIR),
    helperExe:
      value(env, "PSYCHE_WIN_HELPER_EXE") ??
      join(repoRoot, "apps", "win-helper", "target", "release", WIN_HELPER_EXE),
    vmServiceExe:
      value(env, "PSYCHE_WIN_VM_SVC_EXE") ??
      join(repoRoot, "apps", "win-helper", "target", "release", WIN_VM_SERVICE_EXE),
    trayIcon: join(repoRoot, "apps", "desktop", "assets", TRAY_ICON),
    appIcon: join(repoRoot, "apps", "desktop", "assets", APP_ICON),
  };
}

export function bundlePiecesWin32(
  sources: BundleSourcesWin32,
  resourcesDir: string,
  arch: string,
): BundlePiece[] {
  const p = sources.psychedDir;
  return [
    {
      name: "psyched (the Gateway)",
      source: p,
      marker: join(p, "psyched.cmd"),
      alsoRequires: [
        join(p, "runtime", "node.exe"),
        join(p, "app", "skills", "README.md"),
        join(p, "service-host.mjs"),
        join(p, "psyche-gateway.task.xml.template"),
      ],
      dest: join(resourcesDir, BUNDLED_PSYCHED_DIR),
      build: `node deploy/scripts/build-psyched.mjs --arch ${arch}`,
    },
    {
      name: WIN_HELPER_EXE,
      source: sources.helperExe,
      marker: sources.helperExe,
      dest: join(resourcesDir, WIN_HELPER_DIR, WIN_HELPER_EXE),
      build: "cargo build --release --manifest-path apps/win-helper/Cargo.toml",
    },
    {
      name: WIN_VM_SERVICE_EXE,
      source: sources.vmServiceExe,
      marker: sources.vmServiceExe,
      dest: join(resourcesDir, WIN_HELPER_DIR, WIN_VM_SERVICE_EXE),
      build: "cargo build --release --manifest-path apps/win-helper/Cargo.toml",
    },
    {
      name: TRAY_ICON,
      source: sources.trayIcon,
      marker: sources.trayIcon,
      dest: join(resourcesDir, TRAY_ICON),
      build: "node deploy/windows/make-icon.mjs",
    },
    {
      name: APP_ICON,
      source: sources.appIcon,
      marker: sources.appIcon,
      dest: join(resourcesDir, APP_ICON),
      build: "node deploy/windows/make-icon.mjs",
    },
  ];
}

/** The Windows counterpart of copyBundleResources (same partial-package rule). */
export function copyBundleResourcesWin32(
  sources: BundleSourcesWin32,
  resourcesDir: string,
  arch: string,
  opts: { allowPartial: boolean; warn?: (m: string) => void },
): BundlePiece[] {
  return copyPieces(bundlePiecesWin32(sources, resourcesDir, arch), opts, "win32");
}

/** deploy/macos/designated-requirements.txt, copied next to the macOS pieces (bundleSources). */
export const PINNED_REQUIREMENTS = "designated-requirements.txt";

/**
 * Puts the pinned designated requirements into `Contents/Resources/` (sealed by the outer
 * signature). Returns false, and copies nothing, when the repo has no such file.
 */
export function copyPinnedRequirements(repoRoot: string, resourcesDir: string): boolean {
  const src = join(repoRoot, "deploy", "macos", PINNED_REQUIREMENTS);
  if (!existsSync(src)) return false;
  mkdirSync(resourcesDir, { recursive: true });
  cpSync(src, join(resourcesDir, PINNED_REQUIREMENTS));
  return true;
}

/** True for files inside `Resources/psyched/` (the Gateway and its Node runtime). */
export function isGatewayFile(file: string): boolean {
  return file.includes(`${sep}Resources${sep}${BUNDLED_PSYCHED_DIR}${sep}`);
}

/** The marker, or the first other required path, that does not exist. */
function firstMissing(p: BundlePiece): string {
  return [p.marker, ...(p.alsoRequires ?? [])].find((f) => !existsSync(f)) ?? p.marker;
}

export function allowPartial(env: BuildEnv): boolean {
  return value(env, "PSYCHE_PACKAGE_ALLOW_PARTIAL") === "1";
}

export function missingPiecesMessage(
  missing: BundlePiece[],
  platform: "darwin" | "win32" = "darwin",
): string {
  const lines = missing.map(
    (p) => `  - ${p.name}: not found at ${firstMissing(p)} (build it: ${p.build})`,
  );
  return [
    `${platform === "win32" ? "The Windows package" : "Psyche.app"} would not be self-contained; missing:`,
    ...lines,
    `Point PSYCHE_PSYCHED_DIR / ${platform === "win32" ? "PSYCHE_WIN_HELPER_EXE / PSYCHE_WIN_VM_SVC_EXE" : "PSYCHE_HELPER_APP"} at other builds, or set`,
    "PSYCHE_PACKAGE_ALLOW_PARTIAL=1 for a dev package without them.",
  ].join("\n");
}

/**
 * Copies the pieces into `resourcesDir` (packageAfterPrune: `<buildPath>/..`). Returns what was
 * skipped; throws when something is missing and partial packages are not allowed.
 */
export function copyBundleResources(
  sources: BundleSources,
  resourcesDir: string,
  arch: string,
  opts: { allowPartial: boolean; warn?: (m: string) => void },
): BundlePiece[] {
  return copyPieces(bundlePieces(sources, resourcesDir, arch), opts, "darwin");
}

function copyPieces(
  pieces: BundlePiece[],
  opts: { allowPartial: boolean; warn?: (m: string) => void },
  platform: "darwin" | "win32",
): BundlePiece[] {
  const missing = pieces.filter((p) =>
    [p.marker, ...(p.alsoRequires ?? [])].some((f) => !existsSync(f)),
  );
  if (missing.length > 0) {
    if (!opts.allowPartial) throw new Error(missingPiecesMessage(missing, platform));
    opts.warn?.(
      `${missingPiecesMessage(missing, platform)}\n(continuing: PSYCHE_PACKAGE_ALLOW_PARTIAL=1)`,
    );
  }
  for (const piece of pieces) {
    if (missing.includes(piece)) continue;
    rmSync(piece.dest, { recursive: true, force: true });
    mkdirSync(dirname(piece.dest), { recursive: true });
    // psyched/ and the helper keep symlinks, modes and their native addons exactly as built.
    cpSync(piece.source, piece.dest, { recursive: true, verbatimSymlinks: true });
  }
  return missing;
}

const MACHO_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

/** True for Mach-O executables, dylibs and `.node` addons (thin or fat). */
export function isMachO(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) !== 4) return false;
    return MACHO_MAGIC.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * osx-sign `ignore`: it signs every "binary" file it walks. Inside psyched/ only Mach-O files are
 * code (the web client's fonts, images and wasm are resources, sealed by the outer signature), and
 * the helper arrives signed by its own build with its own entitlements (verifyNestedHelper).
 */
export function skipOuterSigning(file: string): boolean {
  if (file.includes(`${sep}${HELPER_APP_NAME}`)) return true;
  if (isGatewayFile(file)) return !isMachO(file);
  return false;
}

/** Runs `/usr/bin/codesign`; returns its stderr (where `-dv` prints), throws on a non-zero exit. */
export type Codesign = (args: string[]) => string;

export const runCodesign: Codesign = (args) => {
  const res = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(res.stderr || `codesign exited ${res.status}`);
  return res.stderr;
};

/**
 * The helper is signed by its own build (deploy/macos/build-helper.sh, with its own entitlements:
 * Apple Events, audio input, Virtualization, …) and osx-sign leaves it alone (skipOuterSigning).
 * Before the outer app seals it, check it is intact and signed like the app: ad-hoc for an ad-hoc
 * app, a real identity for a Developer ID one (notarization rejects an ad-hoc nested app).
 */
export function verifyNestedHelper(
  helperApp: string,
  identity: string | undefined,
  codesign: Codesign = runCodesign,
): void {
  if (!existsSync(helperApp)) return;
  const rebuild = `re-run deploy/macos/build-helper.sh${identity ? " with the same PSYCHE_SIGN_IDENTITY" : ""}`;
  try {
    codesign(["--verify", "--strict", helperApp]);
  } catch {
    throw new Error(`${HELPER_APP_NAME} has no valid signature: ${rebuild}`);
  }
  const info = codesign(["-dv", helperApp]);
  if (identity && /Signature=adhoc/.test(info)) {
    throw new Error(`${HELPER_APP_NAME} is signed ad-hoc but the app uses ${identity}: ${rebuild}`);
  }
}
