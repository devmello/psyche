import { join } from "node:path";
import { app, autoUpdater } from "electron";
import { TRUSTED_RELEASE_KEYS } from "./release-keys.ts";
import {
  checkForVerifiedUpdate,
  serveVerifiedUpdate,
  type UpdaterStateFile,
  writeUpdaterState,
} from "./update-flow.ts";
import {
  bundleOfExecutable,
  evaluateUpdaterGate,
  inspectQuarantine,
  readBundledPinned,
  satisfiesRequirement,
} from "./update-gate.ts";

/**
 * Auto-update (feature A6; security §11). Before Squirrel.Mac sees anything, the updater fetches
 * `update-manifest.json` from the pinned release host, verifies its Ed25519 signature with a key
 * embedded in the app (release-keys.ts), refuses downgrades and artifacts outside the pinned
 * host, downloads the zip and checks its SHA-256 and size (update-flow.ts). Only the verified file
 * is offered to Squirrel, through a loopback feed; Squirrel then checks the code signature too.
 *
 * Off unless the running app's own signature satisfies the designated requirement pinned in
 * deploy/macos/designated-requirements.txt (update-gate.ts: Psyche's self-signed release
 * certificate, or a Developer ID later), and while no release key is embedded. Ad-hoc and
 * development builds never update themselves.
 */

export type UpdaterState =
  | "disabled" // unpackaged, not macOS, or not signed with the pinned release certificate
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

let stopped = false;
const servers: { close(): unknown }[] = [];

/**
 * Uninstall: no more checks, the loopback feed closed and the listeners dropped, so Squirrel
 * (ShipIt) cannot be handed or reinstall an update after the app is in the Trash. The staged
 * download itself is the `psyche-update` temp dir and `~/Library/Caches/com.psyche.desktop.ShipIt`,
 * which the uninstall moves to the Trash.
 */
export function stopUpdater(): void {
  stopped = true;
  for (const s of servers.splice(0)) void s.close();
  autoUpdater.removeAllListeners();
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
        ...(state.quarantine ? { quarantine: state.quarantine } : {}),
      });
    } catch {
      // The audit then reports the check as not run; the update itself is unaffected.
    }
  }
  return state.state;
}

type RunResult = { state: UpdaterState } & Partial<
  Pick<UpdaterStateFile, "code" | "reason" | "release" | "quarantine">
>;

async function runUpdater(opts: UpdaterOptions): Promise<RunResult> {
  const log = opts.log ?? stderrLog;
  if (stopped) return { state: "disabled" };
  const gate = await evaluateUpdaterGate({
    platform: process.platform,
    isPackaged: app.isPackaged,
    keyCount: TRUSTED_RELEASE_KEYS.length,
    bundlePath: bundleOfExecutable(app.getPath("exe")),
    readPinned: () => readBundledPinned(process.resourcesPath),
    satisfies: satisfiesRequirement,
  });
  if (!gate.run) {
    if (gate.state === "no_keys") log(`${gate.why}: updates stay off`);
    return { state: gate.state };
  }
  const feed = opts.feedUrl ?? process.env.PSYCHE_UPDATE_FEED;
  const result = await checkForVerifiedUpdate({
    fetch,
    currentVersion: app.getVersion(),
    arch: process.arch,
    keys: TRUSTED_RELEASE_KEYS,
    ...(feed ? { feed } : {}),
    dir: join(app.getPath("temp"), "psyche-update"),
    log,
    inspectDownload: (file) => inspectQuarantine(file),
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
      if (stopped) return { state: "disabled" };
      const served = await serveVerifiedUpdate(result.file, result.release);
      servers.push(served);
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
      return {
        state: "started",
        release: result.release,
        ...(result.quarantine ? { quarantine: result.quarantine } : {}),
      };
    }
  }
}
