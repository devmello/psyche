import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, autoUpdater } from "electron";
import { TRUSTED_RELEASE_KEYS } from "./release-keys.ts";
import {
  checkForVerifiedUpdate,
  serveVerifiedUpdate,
  type UpdaterStateFile,
  writeUpdaterState,
} from "./update-flow.ts";

/**
 * Auto-update (feature A6; security §11). Before Squirrel.Mac sees anything, the updater fetches
 * `update-manifest.json` from the pinned release host, verifies its Ed25519 signature with a key
 * embedded in the app (release-keys.ts), refuses downgrades and artifacts outside the pinned
 * host, downloads the zip and checks its SHA-256 and size (update-flow.ts). Only the verified file
 * is offered to Squirrel, through a loopback feed; Squirrel then checks the code signature too.
 *
 * Off for unpackaged or unsigned builds, and while no release key is embedded.
 */

export type UpdaterState =
  | "disabled" // unpackaged, unsigned, or not macOS
  | "no_keys" // no release key embedded yet: updates stay off
  | "none" // up to date (or no manifest published)
  | "refused" // a manifest or artifact failed verification; nothing applied
  | "started"; // a verified update is handed to Squirrel

export interface UpdaterOptions {
  /** Overrides the feed (PSYCHE_UPDATE_FEED); still must be on the pinned release host. */
  feedUrl?: string;
  /** Defaults to stderr. */
  log?: (message: string) => void;
  /** `$PSYCHE_HOME/run/updater.json`: the result, for `psyche security audit`. */
  stateFile?: string;
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

export async function startUpdater(opts: UpdaterOptions = {}): Promise<UpdaterState> {
  const state = await runUpdater(opts);
  if (opts.stateFile) {
    try {
      writeUpdaterState(opts.stateFile, {
        state: state.state,
        appVersion: app.getVersion(),
        keys: TRUSTED_RELEASE_KEYS.length,
        checkedAt: new Date().toISOString(),
        ...(state.code ? { code: state.code } : {}),
        ...(state.reason ? { reason: state.reason } : {}),
        ...(state.release ? { release: state.release } : {}),
      });
    } catch {
      // The audit then reports the check as not run; the update itself is unaffected.
    }
  }
  return state.state;
}

type RunResult = { state: UpdaterState } & Partial<
  Pick<UpdaterStateFile, "code" | "reason" | "release">
>;

async function runUpdater(opts: UpdaterOptions): Promise<RunResult> {
  const log = opts.log ?? stderrLog;
  if (!app.isPackaged || !(await isDeveloperIdSigned())) return { state: "disabled" };
  const feed = opts.feedUrl ?? process.env.PSYCHE_UPDATE_FEED;
  const result = await checkForVerifiedUpdate({
    fetch,
    currentVersion: app.getVersion(),
    arch: process.arch,
    keys: TRUSTED_RELEASE_KEYS,
    ...(feed ? { feed } : {}),
    dir: join(app.getPath("temp"), "psyche-update"),
    log,
  }).catch((err: unknown) => {
    log(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { state: "none" as const, reason: "check failed" };
  });

  switch (result.state) {
    case "no_keys":
      log("no release key embedded: updates stay off (security §11)");
      return { state: "no_keys" };
    case "none":
      return { state: "none", reason: result.reason };
    case "refused":
      log(`refused update (${result.code}): ${result.reason}`);
      return { state: "refused", code: result.code, reason: result.reason };
    case "ready": {
      const served = await serveVerifiedUpdate(result.file, result.release);
      autoUpdater.on("error", (error) => {
        log(error.message);
        void served.close();
      });
      autoUpdater.on("update-downloaded", () => {
        log(
          `Psyche ${result.release} is ready; it installs when you quit${result.mandatory ? " (required)" : ""}`,
        );
        void served.close();
      });
      autoUpdater.setFeedURL({ url: served.feedUrl, serverType: "json" });
      autoUpdater.checkForUpdates();
      return { state: "started", release: result.release };
    }
  }
}
