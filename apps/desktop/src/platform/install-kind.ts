import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Runner } from "../main/supervisor-base.ts";

/**
 * How this copy of Psyche is installed on Linux (design §2.3): an AppImage (the unit's
 * `ExecStart` is the image itself, run with `--psyched`) or a deb/rpm package (the unit is the
 * packaged one and `psyched` sits under `/usr/lib/psyche`: electron-installer-debian/redhat put
 * the app there and link `/usr/bin/psyche`).
 */
export type LinuxInstallKind = "appimage" | "package";

/** Where deb and rpm install the app. */
export const LINUX_PACKAGE_ROOT = "/usr/lib/psyche";
/** The Gateway binary of a deb/rpm install. */
export const LINUX_PACKAGED_PSYCHED = `${LINUX_PACKAGE_ROOT}/resources/psyched/psyched`;
/** The launcher a deb/rpm install links into the PATH (the autostart entry runs it). */
export const LINUX_PACKAGE_BIN = "/usr/bin/psyche";

/** What a running process can prove about being an AppImage (the environment alone proves nothing). */
export interface AppImageProbe {
  /** `process.execPath`. */
  execPath: string;
  /** `/proc/self/mountinfo` */
  mountInfo: () => string;
}

export const liveAppImageProbe: AppImageProbe = {
  execPath: process.execPath,
  mountInfo: () => {
    try {
      return readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      return "";
    }
  },
};

const APPDIR_MOUNT = /^\/tmp\/\.mount_[A-Za-z0-9._-]+$/;

/**
 * The AppImage this process runs from, or undefined. `$APPIMAGE` and `$APPDIR` are inherited
 * environment, so a stray `APPIMAGE=/path/to/other-app` (a shell started from another AppImage, a
 * hostile launcher) must not make Psyche treat that file as itself: it would overwrite it on
 * update and write a unit that runs it. All of these must hold:
 *  - `$APPIMAGE` is an absolute path;
 *  - `$APPDIR` is a `/tmp/.mount_*` folder and the running executable is inside it;
 *  - that folder is a FUSE mount whose source names the same file (the runtime mounted it);
 *  - the executable is not the deb/rpm install.
 * An AppImage run with `--appimage-extract-and-run` has no mount, so it counts as no install.
 */
export function trustedAppImage(env: NodeJS.ProcessEnv, probe: AppImageProbe): string | undefined {
  const image = env.APPIMAGE?.trim();
  const dir = env.APPDIR?.trim();
  if (!image || !image.startsWith("/") || !dir || !APPDIR_MOUNT.test(dir)) return undefined;
  if (!probe.execPath.startsWith(`${dir}/`)) return undefined;
  if (probe.execPath === LINUX_PACKAGE_ROOT || probe.execPath.startsWith(`${LINUX_PACKAGE_ROOT}/`))
    return undefined;
  const name = basename(image);
  for (const line of probe.mountInfo().split("
")) {
    // 36 35 0:42 / /tmp/.mount_x rw,... - fuse.Psyche.AppImage /path/Psyche.AppImage rw,...
    const [pre, post] = line.split(" - ");
    if (pre === undefined || post === undefined) continue;
    if (pre.split(" ")[4] !== dir) continue;
    const [fstype, source] = post.split(" ");
    if (fstype?.startsWith("fuse") !== true) continue;
    if (source === image || source === name || fstype.endsWith(name)) return image;
  }
  return undefined;
}

export function linuxInstallKind(
  env: NodeJS.ProcessEnv,
  probe: AppImageProbe = liveAppImageProbe,
): LinuxInstallKind {
  return trustedAppImage(env, probe) !== undefined ? "appimage" : "package";
}

/** What the unit's `ExecStart` runs, and who owns the unit file (`SystemdUserSupervisor`). */
export function linuxGatewayLaunch(
  env: NodeJS.ProcessEnv,
  probe: AppImageProbe = liveAppImageProbe,
): {
  program: string;
  args: string[];
  install: "user" | "packaged";
} {
  const image = trustedAppImage(env, probe);
  return image !== undefined
    ? { program: image, args: ["--psyched"], install: "user" }
    : { program: LINUX_PACKAGED_PSYCHED, args: [], install: "packaged" };
}

/** The command the autostart entry runs (`--background`: no window, like the other login items). */
export function linuxAutostartExec(
  env: NodeJS.ProcessEnv,
  probe: AppImageProbe = liveAppImageProbe,
): string[] {
  return [trustedAppImage(env, probe) ?? LINUX_PACKAGE_BIN];
}

export type LinuxPackageManager = "apt" | "dnf";

/**
 * Which package manager owns the install, for the uninstall sheet's command: `dpkg -S` or
 * `rpm -qf` on the install root. Undefined when neither knows the path (a copy unpacked by hand).
 */
export async function linuxPackageManager(run: Runner): Promise<LinuxPackageManager | undefined> {
  if ((await run("dpkg", ["-S", LINUX_PACKAGE_ROOT])).code === 0) return "apt";
  if ((await run("rpm", ["-qf", LINUX_PACKAGE_ROOT])).code === 0) return "dnf";
  return undefined;
}
