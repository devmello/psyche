import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, autoUpdater } from "electron";

/**
 * Auto-update (feature A6), a placeholder.
 *
 * Security §11 requires that before anything is staged the updater verifies a release manifest
 * (version, per-artifact SHA-256, minimum version) signed with the offline Ed25519 release key
 * embedded in the app, refuses downgrades and fetches only from the pinned release host.
 * Squirrel.Mac checks the code signature only, so until that manifest check exists (S22/C2) this
 * never calls `setFeedURL`: with a feed configured on a packaged, Developer ID-signed build it
 * logs that the feed is a placeholder and returns.
 */

/** Flip only when the signed-manifest verification from security §11 is in place. */
const MANIFEST_VERIFICATION_READY = false;

export type UpdaterState =
  | "disabled" // no feed, unpackaged, or unsigned
  | "placeholder" // feed configured but manifest verification is not implemented
  | "started";

export interface UpdaterOptions {
  /** Defaults to PSYCHE_UPDATE_FEED. */
  feedUrl?: string;
  /** Defaults to stderr. */
  log?: (message: string) => void;
}

function stderrLog(message: string): void {
  process.stderr.write(`[updater] ${message}\n`);
}

const execFileAsync = promisify(execFile);

/** True for a macOS bundle signed with a Developer ID Application certificate. */
async function isDeveloperIdSigned(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  // …/Psyche.app/Contents/MacOS/Psyche → …/Psyche.app
  const bundle = join(app.getPath("exe"), "..", "..", "..");
  try {
    const { stderr } = await execFileAsync("/usr/bin/codesign", ["-dvv", bundle]);
    return /^Authority=Developer ID Application:/m.test(stderr);
  } catch {
    return false;
  }
}

function parseFeed(feedUrl: string | undefined): URL | undefined {
  if (!feedUrl) return undefined;
  try {
    const url = new URL(feedUrl);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function startUpdater(opts: UpdaterOptions = {}): Promise<UpdaterState> {
  const log = opts.log ?? stderrLog;
  const feed = parseFeed(opts.feedUrl ?? process.env.PSYCHE_UPDATE_FEED);
  if (!feed || !app.isPackaged) return "disabled";
  if (!(await isDeveloperIdSigned())) return "disabled";

  if (!MANIFEST_VERIFICATION_READY) {
    log(
      `${feed.origin} is a placeholder feed: updates stay off until signed-manifest verification (security §11) lands.`,
    );
    return "placeholder";
  }

  autoUpdater.on("error", (error) => log(error.message));
  autoUpdater.setFeedURL({ url: feed.toString() });
  autoUpdater.checkForUpdates();
  return "started";
}
