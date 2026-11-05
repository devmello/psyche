import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { InstallKind } from "../main/update-manifest.ts";
import { LINUX_PACKAGE_ROOT, liveAppImageProbe, trustedAppImage } from "../platform/install-kind.ts";

/**
 * How this copy of Psyche is installed on Linux, and where its update files live
 * (docs/design/linux-desktop-2026.md §3.2, §3.3, §3.4). Pure: every probe is injected.
 *
 * deb and rpm both unpack into `/usr/lib/psyche` (the layout electron-installer-debian and
 * electron-installer-redhat fix; the design's `/opt/Psyche` is not configurable in them), and the
 * package manager owns those files. An AppImage sets `$APPIMAGE` to its own path.
 */

/** Where the deb and rpm makers put the app. */
export const PACKAGE_INSTALL_DIR = LINUX_PACKAGE_ROOT;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `file args` without a shell; resolves with the exit code, rejects only when it cannot start. */
export type RunCommand = (file: string, args: string[]) => Promise<CommandResult>;

export interface InstallProbe {
  env: NodeJS.ProcessEnv;
  /** `process.execPath` / `app.getPath("exe")`. */
  execPath: string;
  run: RunCommand;
  /** `/proc/self/mountinfo` (the AppImage's FUSE mount is how a real AppImage proves itself). */
  mountInfo?: () => string;
}

export interface InstallInfo {
  kind: InstallKind;
  /** AppImage only: the file that gets replaced on update. */
  appImagePath?: string;
}

async function owns(run: RunCommand, file: string, args: string[]): Promise<boolean> {
  try {
    return (await run(file, args)).code === 0;
  } catch {
    return false; // the tool is not installed: not that kind of system
  }
}

/**
 * An AppImage that proves itself (a FUSE mount of `$APPIMAGE` under `/tmp/.mount_*` that holds this
 * executable) is `appimage`. Otherwise the app must sit under `/usr/lib/psyche` and be owned by a
 * package, whatever `$APPIMAGE` says: `dpkg -S` (deb) or `rpm -qf` (rpm). A tarball, a
 * development build or a copy somebody moved has no install kind, and so no updates.
 */
export async function detectInstallKind(p: InstallProbe): Promise<InstallInfo | undefined> {
  // An AppImage proves itself (platform/install-kind.ts `trustedAppImage`): $APPIMAGE alone is
  // inherited environment and could name another app's file.
  const image = trustedAppImage(p.env, {
    execPath: p.execPath,
    mountInfo: p.mountInfo ?? liveAppImageProbe.mountInfo,
  });
  if (image !== undefined) return { kind: "appimage", appImagePath: image };
  if (!p.execPath.startsWith(`${PACKAGE_INSTALL_DIR}/`)) return undefined;
  if (await owns(p.run, "/usr/bin/dpkg", ["-S", p.execPath])) return { kind: "deb" };
  if (await owns(p.run, "/usr/bin/rpm", ["-qf", p.execPath])) return { kind: "rpm" };
  return undefined;
}

export type LinuxGateDecision =
  | { run: true; kind: InstallKind }
  | { run: false; state: "disabled" | "no_keys"; why: string };

export interface LinuxGateDeps {
  platform: string;
  isPackaged: boolean;
  /** Embedded release keys (release-keys.ts). */
  keyCount: number;
  install: InstallInfo | undefined;
}

/** The Linux counterpart of `evaluateUpdaterGate`: no signature to check, only how it was installed. */
export function evaluateLinuxGate(d: LinuxGateDeps): LinuxGateDecision {
  if (d.platform !== "linux") return { run: false, state: "disabled", why: "not Linux" };
  if (!d.isPackaged) return { run: false, state: "disabled", why: "not a packaged app" };
  if (!d.install) {
    return {
      run: false,
      state: "disabled",
      why: "not installed from an AppImage, deb or rpm (a tarball or development build)",
    };
  }
  if (d.keyCount === 0) {
    return { run: false, state: "no_keys", why: "no release key embedded (security §11)" };
  }
  return { run: true, kind: d.install.kind };
}

export interface LinuxUpdatePaths {
  /** Verified downloads wait here (0700). */
  updatesDir: string;
  /** deb and rpm: the last package this app installed (it becomes `previous` at the next update). */
  packageDir: string;
  previousPackageDir: string;
  /** AppImage: a copy of the image that was running before the swap. */
  previousImageDir: string;
}

/** XDG-aware: `$XDG_CACHE_HOME`/`$XDG_DATA_HOME` when absolute, else `~/.cache` and `~/.local/share`. */
export function linuxUpdatePaths(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): LinuxUpdatePaths {
  const abs = (v: string | undefined, fallback: string) => (v && isAbsolute(v) ? v : fallback);
  const cache = join(abs(env.XDG_CACHE_HOME, join(home, ".cache")), "psyche");
  const data = join(abs(env.XDG_DATA_HOME, join(home, ".local", "share")), "psyche");
  return {
    updatesDir: join(cache, "updates"),
    packageDir: join(cache, "installed"),
    previousPackageDir: join(cache, "previous"),
    previousImageDir: join(data, "previous"),
  };
}
