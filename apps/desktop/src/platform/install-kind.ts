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

export function linuxInstallKind(env: NodeJS.ProcessEnv): LinuxInstallKind {
  const image = env.APPIMAGE;
  return image !== undefined && image !== "" ? "appimage" : "package";
}

/** What the unit's `ExecStart` runs, and who owns the unit file (`SystemdUserSupervisor`). */
export function linuxGatewayLaunch(env: NodeJS.ProcessEnv): {
  program: string;
  args: string[];
  install: "user" | "packaged";
} {
  const image = env.APPIMAGE;
  return linuxInstallKind(env) === "appimage" && image !== undefined
    ? { program: image, args: ["--psyched"], install: "user" }
    : { program: LINUX_PACKAGED_PSYCHED, args: [], install: "packaged" };
}

/** The command the autostart entry runs (`--background`: no window, like the other login items). */
export function linuxAutostartExec(env: NodeJS.ProcessEnv): string[] {
  const image = env.APPIMAGE;
  return [linuxInstallKind(env) === "appimage" && image !== undefined ? image : LINUX_PACKAGE_BIN];
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
