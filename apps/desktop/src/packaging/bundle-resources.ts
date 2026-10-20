import { spawnSync } from "node:child_process";
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
 *   PsycheHelper.app                 S14's Swift helper (com.psyche.helper), launched with `open`
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

/** The marker, or the first other required path, that does not exist. */
function firstMissing(p: BundlePiece): string {
  return [p.marker, ...(p.alsoRequires ?? [])].find((f) => !existsSync(f)) ?? p.marker;
}

export function allowPartial(env: BuildEnv): boolean {
  return value(env, "PSYCHE_PACKAGE_ALLOW_PARTIAL") === "1";
}

export function missingPiecesMessage(missing: BundlePiece[]): string {
  const lines = missing.map(
    (p) => `  - ${p.name}: not found at ${firstMissing(p)} (build it: ${p.build})`,
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
  const missing = pieces.filter((p) =>
    [p.marker, ...(p.alsoRequires ?? [])].some((f) => !existsSync(f)),
  );
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
 * the helper arrives signed by its own build with its own entitlements (verifyNestedHelper).
 */
export function skipOuterSigning(file: string): boolean {
  if (file.includes(`${sep}${HELPER_APP_NAME}`)) return true;
  if (file.includes(`${sep}Resources${sep}${BUNDLED_PSYCHED_DIR}${sep}`)) return !isMachO(file);
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
