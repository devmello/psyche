import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { BuildEnv } from "./signing-config.ts";

/**
 * The pieces that make the Linux package self-contained (docs/design/linux-desktop-2026.md §2.1).
 * deb, rpm and AppImage all start from the same packaged folder (`out/Psyche-linux-<arch>/`, with
 * the Electron binary `psyche` in it). Paths are relative to it:
 *
 *   resources/psyched/               the Gateway bundle (build-psyched.mjs --platform linux), with its own Node
 *   resources/psyche-helper          the Linux helper (apps/linux-helper, L3); optional until it exists
 *   resources/psyche-system-setup    deploy/linux/psyche-system-setup, the root-run installer
 *   resources/system/                the payload that script installs, laid out like the root it lands in:
 *     usr/lib/systemd/user/psyche-gateway.service   the unit, rendered for /usr/lib/psyche (deb/rpm)
 *     etc/apparmor.d/psyche                          Ubuntu 23.10+ user-namespace permission (deb/rpm)
 *     usr/share/polkit-1/...                         the password-approval policy (L4); optional with a warning
 *   psyche-apprun                    deploy/linux/AppRun: the AppImage's `bin`, and handy beside deb/rpm
 *
 * Only these paths are copied from `deploy/linux/root`, never "everything under it", and a link
 * anywhere in the source is refused: the folder ends up installed as root.
 */

/** Where the deb and rpm makers put the app; the rendered unit points here. */
export const LINUX_INSTALL_DIR = "/usr/lib/psyche";
export const BUNDLED_SYSTEM_DIR = "system";
export const SETUP_SCRIPT = "psyche-system-setup";
export const APPRUN_NAME = "psyche-apprun";
export const HELPER_NAME = "psyche-helper";

const UNIT_TEMPLATE = join("usr", "lib", "systemd", "user", "psyche-gateway.service.in");
const UNIT_FILE = join("usr", "lib", "systemd", "user", "psyche-gateway.service");
const APPARMOR_PROFILE = join("etc", "apparmor.d", "psyche");
const POLKIT_DIR = join("usr", "share", "polkit-1");

export interface LinuxBundleSources {
  /** apps/gateway/dist-bin/linux-<arch>/psyched (or PSYCHE_PSYCHED_DIR). */
  psychedDir: string;
  /** apps/linux-helper/target/release/psyche-helper (or PSYCHE_LINUX_HELPER). */
  helperBin: string;
  /** deploy/linux/root */
  rootDir: string;
  /** deploy/linux/AppRun */
  appRun: string;
  /** deploy/linux/psyche-system-setup */
  setupScript: string;
}

function value(env: BuildEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

export function bundleSourcesLinux(
  env: BuildEnv,
  repoRoot: string,
  arch: string,
): LinuxBundleSources {
  return {
    psychedDir:
      value(env, "PSYCHE_PSYCHED_DIR") ??
      join(repoRoot, "apps", "gateway", "dist-bin", `linux-${arch}`, "psyched"),
    helperBin:
      value(env, "PSYCHE_LINUX_HELPER") ??
      join(repoRoot, "apps", "linux-helper", "target", "release", HELPER_NAME),
    rootDir: join(repoRoot, "deploy", "linux", "root"),
    appRun: join(repoRoot, "deploy", "linux", "AppRun"),
    setupScript: join(repoRoot, "deploy", "linux", SETUP_SCRIPT),
  };
}

/** The unit template with `@PSYCHED@` and `@BUILD@` filled in. */
export function renderGatewayUnit(template: string, v: { psyched: string; build: string }): string {
  if (/[\r\n\s]/.test(v.psyched)) throw new Error("the psyched path must not hold whitespace");
  if (!/^[0-9a-f]{8,64}$/.test(v.build)) throw new Error(`not a build id: ${v.build}`);
  const out = template.replaceAll("@PSYCHED@", v.psyched).replaceAll("@BUILD@", v.build);
  if (/@[A-Z_]+@/.test(out)) throw new Error("the unit template has an unfilled placeholder");
  return out;
}

/** `build` of the bundled psyched/build-info.json. */
export function bundledBuildId(psychedDir: string): string {
  const info = JSON.parse(readFileSync(join(psychedDir, "build-info.json"), "utf8")) as {
    build?: unknown;
  };
  if (typeof info.build !== "string") throw new Error("psyched/build-info.json has no build");
  return info.build;
}

/** Every path under `dir` that is a link or special file (relative). */
export function findLinks(dir: string): string[] {
  const bad: string[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) visit(p);
      else if (!st.isFile()) bad.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) visit(dir);
  return bad;
}

export interface LinuxCopyOptions {
  allowPartial: boolean;
  warn?: (m: string) => void;
}

export interface LinuxCopyResult {
  /** Required pieces that were missing (only with allowPartial). */
  missing: string[];
  /** Optional pieces that were missing. */
  skipped: string[];
}

/**
 * Copies the pieces into the packaged folder `packagedDir` (packageAfterPrune: `<buildPath>/../..`).
 * A missing required piece throws unless partial packages are allowed; a missing optional one
 * (the helper, the polkit policy) only warns.
 */
export function copyBundleResourcesLinux(
  sources: LinuxBundleSources,
  packagedDir: string,
  opts: LinuxCopyOptions,
): LinuxCopyResult {
  const resources = join(packagedDir, "resources");
  const missing: string[] = [];
  const skipped: string[] = [];
  const warn = opts.warn ?? (() => {});
  const need = (name: string, ...files: string[]): boolean => {
    const gone = files.find((f) => !existsSync(f));
    if (!gone) return true;
    missing.push(`${name}: not found at ${gone}`);
    return false;
  };
  const optional = (name: string, file: string, why: string): boolean => {
    if (existsSync(file)) return true;
    skipped.push(name);
    warn(`${name} is not in this package (${why}); looked for ${file}`);
    return false;
  };

  const psyched = join(resources, "psyched");
  const haveGateway = need(
    "psyched (the Gateway)",
    join(sources.psychedDir, "psyched"),
    join(sources.psychedDir, "runtime", "node"),
    join(sources.psychedDir, "app", "skills", "README.md"),
    join(sources.psychedDir, "build-info.json"),
  );
  const haveUnit = need("the Gateway unit template", join(sources.rootDir, UNIT_TEMPLATE));
  const haveProfile = need("the AppArmor profile", join(sources.rootDir, APPARMOR_PROFILE));
  const haveSetup = need(SETUP_SCRIPT, sources.setupScript);
  const haveAppRun = need(APPRUN_NAME, sources.appRun);
  if (missing.length > 0 && !opts.allowPartial) {
    throw new Error(
      [
        "The Linux package would not be self-contained; missing:",
        ...missing.map((m) => `  - ${m}`),
        "Build psyched with `node deploy/scripts/build-psyched.mjs --platform linux --arch <arch>`,",
        "point PSYCHE_PSYCHED_DIR at another build, or set PSYCHE_PACKAGE_ALLOW_PARTIAL=1 for a dev package.",
      ].join("\n"),
    );
  }
  if (missing.length > 0)
    warn(`${missing.join("\n")}\n(continuing: PSYCHE_PACKAGE_ALLOW_PARTIAL=1)`);

  if (haveGateway) {
    rmSync(psyched, { recursive: true, force: true });
    mkdirSync(resources, { recursive: true });
    // Symlinks, modes and native addons stay exactly as built.
    cpSync(sources.psychedDir, psyched, { recursive: true, verbatimSymlinks: true });
  }
  if (optional(HELPER_NAME, sources.helperBin, "apps/linux-helper is not built yet")) {
    mkdirSync(resources, { recursive: true });
    cpSync(sources.helperBin, join(resources, HELPER_NAME));
    chmodSync(join(resources, HELPER_NAME), 0o755);
  }

  const system = join(resources, BUNDLED_SYSTEM_DIR);
  rmSync(system, { recursive: true, force: true });
  if (haveUnit && haveGateway) {
    const unit = renderGatewayUnit(readFileSync(join(sources.rootDir, UNIT_TEMPLATE), "utf8"), {
      psyched: `${LINUX_INSTALL_DIR}/resources/psyched/psyched`,
      build: bundledBuildId(sources.psychedDir),
    });
    mkdirSync(dirname(join(system, UNIT_FILE)), { recursive: true });
    writeFileSync(join(system, UNIT_FILE), unit, { mode: 0o644 });
  }
  if (haveProfile) {
    mkdirSync(dirname(join(system, APPARMOR_PROFILE)), { recursive: true });
    cpSync(join(sources.rootDir, APPARMOR_PROFILE), join(system, APPARMOR_PROFILE));
  }
  // L4 owns the policy file; until it lands the package builds and says so.
  const polkit = join(sources.rootDir, POLKIT_DIR);
  if (optional("the polkit password-approval policy", polkit, "L4 adds it")) {
    const links = findLinks(polkit);
    if (links.length) throw new Error(`links in ${polkit}: ${links.join(", ")}`);
    cpSync(polkit, join(system, POLKIT_DIR), { recursive: true });
  }

  if (haveSetup) {
    mkdirSync(resources, { recursive: true });
    cpSync(sources.setupScript, join(resources, SETUP_SCRIPT));
    chmodSync(join(resources, SETUP_SCRIPT), 0o755);
  }
  if (haveAppRun) {
    cpSync(sources.appRun, join(packagedDir, APPRUN_NAME));
    chmodSync(join(packagedDir, APPRUN_NAME), 0o755);
  }
  return { missing, skipped };
}

/** hicolor sizes the makers install (deploy/linux/root/usr/share/icons/hicolor/<size>/apps/psyche.png). */
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const;

/** `{ "16x16": path, ... }` for the sizes that exist under `hicolorDir`. */
export function linuxIconSet(hicolorDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of ICON_SIZES) {
    const file = join(hicolorDir, `${n}x${n}`, "apps", "psyche.png");
    if (existsSync(file)) out[`${n}x${n}`] = file;
  }
  return out;
}

const LINUX_EXT = new Map([
  [".deb", "deb"],
  [".rpm", "rpm"],
  [".appimage", "AppImage"],
]);

/** `Psyche-<version>-linux-<x64|arm64>.<deb|rpm|AppImage>`, the names update-manifest.mjs classifies. */
export function linuxArtifactName(version: string, arch: string, ext: string): string {
  return `Psyche-${version}-linux-${arch}.${ext}`;
}

/** The part of a forge MakeResult this needs. */
export interface MadeResult {
  artifacts: string[];
  arch: string;
  packageJSON?: { version?: string };
}

/**
 * postMake: renames each deb, rpm and AppImage in place (the makers name them
 * `psyche_0.3.0~alpha.0_amd64.deb`, `psyche-0.3.0_alpha.0-1.x86_64.rpm`, `Psyche-0.3.0-x64.AppImage`)
 * and updates `artifacts`. Other files (the zip) keep their names. Two files of one kind in one
 * result are an error: the manifest could not tell them apart.
 */
export function renameLinuxArtifacts(
  results: MadeResult[],
  version: string,
  log: (m: string) => void = () => {},
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (const r of results) {
    const seen = new Set<string>();
    r.artifacts = r.artifacts.map((file) => {
      const ext = LINUX_EXT.get(extname(file).toLowerCase());
      if (!ext) return file;
      if (seen.has(ext)) throw new Error(`two .${ext} files in one make result: ${file}`);
      seen.add(ext);
      const to = join(
        dirname(file),
        linuxArtifactName(r.packageJSON?.version ?? version, r.arch, ext),
      );
      if (to !== file) rename(file, to);
      log(`${basename(file)} -> ${basename(to)}`);
      return to;
    });
  }
}

const E_MACHINE: Record<string, number> = { x64: 0x3e, arm64: 0xb7 };

/** `x64` or `arm64` for an ELF file, from its header (undefined for anything else). */
export function elfArch(file: string): "x64" | "arm64" | undefined {
  const fd = openSync(file, "r");
  try {
    const h = Buffer.alloc(20);
    if (readSync(fd, h, 0, 20, 0) !== 20 || h.readUInt32BE(0) !== 0x7f454c46) return undefined;
    const machine = h.readUInt16LE(18);
    return (Object.keys(E_MACHINE) as ("x64" | "arm64")[]).find((a) => E_MACHINE[a] === machine);
  } finally {
    closeSync(fd);
  }
}

/** Every `.node` file under `dir` that is not an ELF object for `arch` (relative paths). */
export function wrongArchAddons(dir: string, arch: string): string[] {
  const bad: string[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) visit(p);
      else if (st.isFile() && name.endsWith(".node") && elfArch(p) !== arch)
        bad.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) visit(dir);
  return bad;
}

/**
 * node-pty has no Linux prebuild: `pnpm install` compiles it for the host. For another
 * architecture, compile it with the cross toolchain (`g++-aarch64-linux-gnu`) in place, copy the
 * result to `dest`, and put the host build back. Needs `node-gyp` from npm.
 */
export function crossBuildNodePty(
  srcDir: string,
  destRelease: string,
  arch: "x64" | "arm64",
  run: (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => void,
  npmRootGlobal: string,
): void {
  const prefix = arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  const build = join(srcDir, "build");
  const host = join(srcDir, "build.host");
  rmSync(host, { recursive: true, force: true });
  if (existsSync(build)) renameSync(build, host);
  try {
    run(
      process.execPath,
      [
        join(npmRootGlobal, "npm", "node_modules", "node-gyp", "bin", "node-gyp.js"),
        "rebuild",
        `--arch=${arch}`,
        `--target_arch=${arch}`,
      ],
      {
        cwd: srcDir,
        env: {
          ...process.env,
          CC: `${prefix}-gcc`,
          CXX: `${prefix}-g++`,
          CC_target: `${prefix}-gcc`,
          CXX_target: `${prefix}-g++`,
          AR: `${prefix}-ar`,
          LINK: `${prefix}-g++`,
        },
      },
    );
    rmSync(destRelease, { recursive: true, force: true });
    cpSync(join(build, "Release"), destRelease, { recursive: true });
  } finally {
    rmSync(build, { recursive: true, force: true });
    if (existsSync(host)) renameSync(host, build);
  }
}
