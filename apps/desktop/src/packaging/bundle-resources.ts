import { execFileSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { BuildEnv } from "./signing-config.ts";

/**
 * The pieces that make Psyche.app self-contained (docs/status/s22.md "Packaging layout",
 * docs/status/s14.md "Packaging"). Paths are relative to `Psyche.app/Contents/Resources/`:
 *
 *   psyched/                         S22's Gateway bundle, copied verbatim (never into app.asar)
 *   launchd/com.psyche.gateway.plist the LaunchAgent template ({{PSYCHED}}, {{PSYCHE_HOME}}),
 *                                    rendered by the supervisor at install time
 *   Psyche Helper.app                S14's Swift helper (com.psyche.helper)
 *
 * The package step fails when a piece is missing unless PSYCHE_PACKAGE_ALLOW_PARTIAL=1, so a
 * release never ships an app that cannot start its Gateway.
 */

export const HELPER_APP_NAME = "Psyche Helper.app";
export const BUNDLED_PSYCHED_DIR = "psyched";
export const BUNDLED_PLIST = join("launchd", "com.psyche.gateway.plist");
const PLIST_TEMPLATE = "com.psyche.gateway.plist.template";

export interface BundleSources {
  /** apps/gateway/dist-bin/darwin-<arch>/psyched (or PSYCHE_PSYCHED_DIR). */
  psychedDir: string;
  /** apps/mac-helper/.build/Psyche Helper.app (or PSYCHE_HELPER_APP). */
  helperApp: string;
}

export interface BundlePiece {
  name: string;
  /** File or directory copied to `dest`. */
  source: string;
  /** The file whose presence proves the piece was built. */
  marker: string;
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
      join(repoRoot, "apps", "mac-helper", ".build", HELPER_APP_NAME),
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
      build: "apps/mac-helper/scripts/build-app.sh",
    },
  ];
}

export function allowPartial(env: BuildEnv): boolean {
  return value(env, "PSYCHE_PACKAGE_ALLOW_PARTIAL") === "1";
}

export function missingPiecesMessage(missing: BundlePiece[]): string {
  const lines = missing.map(
    (p) => `  - ${p.name}: not found at ${p.marker} (build it: ${p.build})`,
  );
  return [
    "Psyche.app would not be self-contained; missing:",
    ...lines,
    "Point PSYCHE_PSYCHED_DIR / PSYCHE_HELPER_APP at other builds, or set",
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
  const pieces = bundlePieces(sources, resourcesDir, arch);
  const missing = pieces.filter((p) => !existsSync(p.marker));
  if (missing.length > 0) {
    if (!opts.allowPartial) throw new Error(missingPiecesMessage(missing));
    opts.warn?.(`${missingPiecesMessage(missing)}\n(continuing: PSYCHE_PACKAGE_ALLOW_PARTIAL=1)`);
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
 * the helper is signed on its own with its own entitlements (signNestedHelper).
 */
export function skipOuterSigning(file: string): boolean {
  if (file.includes(`${sep}${HELPER_APP_NAME}`)) return true;
  if (file.includes(`${sep}Resources${sep}${BUNDLED_PSYCHED_DIR}${sep}`)) return !isMachO(file);
  return false;
}

export type Codesign = (args: string[]) => void;

export const runCodesign: Codesign = (args) => {
  execFileSync("/usr/bin/codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
};

/**
 * Signs the nested helper before osx-sign seals the outer app. Its own entitlements (Apple Events,
 * camera for screen capture, …) are kept with --preserve-metadata; the identity is the app's
 * Developer ID, else ad-hoc. Gatekeeper and TCC then see one consistent signer for the bundle.
 */
export function signNestedHelper(
  helperApp: string,
  identity: string | undefined,
  codesign: Codesign = runCodesign,
): void {
  if (!existsSync(helperApp)) return;
  const args = [
    "--force",
    "--sign",
    identity ?? "-",
    "--preserve-metadata=entitlements,identifier",
  ];
  if (identity) args.push("--options", "runtime", "--timestamp");
  else args.push("--timestamp=none");
  codesign([...args, helperApp]);
}
