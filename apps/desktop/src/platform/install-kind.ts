/**
 * How this copy of Psyche is installed on Linux (design §2.3): an AppImage (the unit's
 * `ExecStart` is the image itself, run with `--psyched`) or a deb/rpm package (the unit is the
 * packaged one and `psyched` sits under `/opt/Psyche`).
 */
export type LinuxInstallKind = "appimage" | "package";

export function linuxInstallKind(env: NodeJS.ProcessEnv): LinuxInstallKind {
  const image = env.APPIMAGE;
  return image !== undefined && image !== "" ? "appimage" : "package";
}
