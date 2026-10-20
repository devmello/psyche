import { join } from "node:path";

/**
 * Settings → Browser → "Open the Psyche Chrome profile" (feature I13): the owner opens the
 * profile real-Chrome mode uses, once, to sign in and install 1Password there. It runs as a
 * normal Chrome window: no DevTools port, nothing attached. Never the owner's own Chrome
 * profile: the directory is Psyche's (`$PSYCHE_HOME/browser/real-chrome/<profile>`, the same
 * path `@psyche/browser`'s `realChromeDir` launches).
 */

/** Profile names as `@psyche/browser` accepts them. */
const PROFILE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function realChromeProfileDir(psycheHome: string, profile = "default"): string {
  if (!PROFILE.test(profile)) throw new Error(`invalid profile name ${JSON.stringify(profile)}`);
  return join(psycheHome, "browser", "real-chrome", profile);
}

/** How to start Google Chrome on this platform with that profile, or null when unsupported. */
export function realChromeOpenCommand(
  platform: NodeJS.Platform,
  userDataDir: string,
): { command: string; args: string[] } | null {
  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (platform === "darwin") {
    // `-n`: a new instance for this data dir, separate from the owner's running Chrome.
    return { command: "open", args: ["-n", "-a", "Google Chrome", "--args", ...chromeArgs] };
  }
  if (platform === "linux") return { command: "google-chrome", args: chromeArgs };
  return null;
}
