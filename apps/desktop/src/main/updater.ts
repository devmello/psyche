import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, autoUpdater } from "electron";
import { claimedRequirement } from "./bundle-integrity.ts";
import { TRUSTED_RELEASE_KEYS } from "./release-keys.ts";
import {
  checkForVerifiedUpdate,
  serveVerifiedUpdate,
  switchToFullPackage,
  type UpdateCheck,
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
 * Auto-update (feature A6; security §11). Before Squirrel sees anything, the updater fetches
 * `update-manifest.json` from the pinned release host, verifies its Ed25519 signature with a key
 * embedded in the app (release-keys.ts), refuses downgrades and artifacts outside the pinned
 * host, downloads the update and checks its SHA-256 and size (update-flow.ts). Only verified files
 * are offered to Squirrel:
 *
 * - macOS (Squirrel.Mac): the zip through a loopback feed; Squirrel then checks the code signature.
 * - Windows (Squirrel.Windows): a local feed folder with RELEASES and the nupkg; Electron's
 *   autoUpdater runs `Update.exe --update <folder>`, which installs the new version beside the
 *   running one (`%LOCALAPPDATA%\Psychepp-<version>`). The Psyche.exe stub and the shortcuts
 *   start the newest version, so like on a Mac the update takes effect when Psyche next starts.
 *
 * Off for unpackaged builds and while no release key is embedded. On macOS, off unless the running
 * app's own signature satisfies the designated requirement pinned in
 * deploy/macos/designated-requirements.txt (update-gate.ts: Psyche's self-signed release
 * certificate, or a Developer ID later); ad-hoc and development builds never update themselves. On
 * Windows, off unless Psyche.exe has a valid Authenticode signature and was installed by Squirrel
 * (not the portable zip).
 */

export type UpdaterState =
  | "disabled" // unpackaged, unsigned (or not the pinned release certificate), not installed by Squirrel, or another OS
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

/** Squirrel.Windows installs Update.exe one level above `app-<version>\Psyche.exe`. */
export function squirrelUpdateExe(exe: string): string {
  return join(exe, "..", "..", "Update.exe");
}

/** True for a Psyche.exe with a valid Authenticode signature (a chain Windows trusts). */
async function isAuthenticodeSigned(exe: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-AuthenticodeSignature -LiteralPath $env:PSYCHE_SIGNED_FILE).Status",
      ],
      { env: { ...process.env, PSYCHE_SIGNED_FILE: exe }, windowsHide: true, timeout: 20_000 },
    );
    return stdout.trim() === "Valid";
  } catch {
    return false;
  }
}

/** Windows: a packaged, Squirrel-installed Psyche.exe with a valid Authenticode signature. */
async function windowsUpdatesAllowed(): Promise<boolean> {
  if (!app.isPackaged) return false;
  const exe = app.getPath("exe");
  return existsSync(squirrelUpdateExe(exe)) && (await isAuthenticodeSigned(exe));
}

/** undefined when the updater may run; otherwise the state to report. */
async function updaterGate(log: (m: string) => void): Promise<RunResult | undefined> {
  if (process.platform === "win32") {
    return (await windowsUpdatesAllowed()) ? undefined : { state: "disabled" };
  }
  const gate = await evaluateUpdaterGate({
    platform: process.platform,
    isPackaged: app.isPackaged,
    keyCount: TRUSTED_RELEASE_KEYS.length,
    bundlePath: bundleOfExecutable(app.getPath("exe")),
    readPinned: () => readBundledPinned(process.resourcesPath),
    // The claimed requirement plus a shallow `codesign --verify --strict`, not the integrity verdict:
    // a stray file in the bundle (a .DS_Store from Show Package Contents) must never block updates
    // forever. Squirrel still checks the new bundle against the requirement itself.
    satisfies: async (bundle, requirement) =>
      (await claimedRequirement(bundle)) === requirement &&
      (await satisfiesRequirement(bundle, requirement)),
  });
  if (gate.run) return undefined;
  if (gate.state === "no_keys") log(`${gate.why}: updates stay off`);
  return { state: gate.state };
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
  const blocked = await updaterGate(log);
  if (blocked) return blocked;
  const platform = process.platform === "win32" ? "win32" : "darwin";
  const feed = opts.feedUrl ?? process.env.PSYCHE_UPDATE_FEED;
  const result = await checkForVerifiedUpdate({
    fetch,
    currentVersion: app.getVersion(),
    arch: process.arch,
    platform,
    keys: TRUSTED_RELEASE_KEYS,
    ...(feed ? { feed } : {}),
    dir: join(app.getPath("temp"), "psyche-update"),
    log,
    ...(platform === "darwin"
      ? { inspectDownload: (file: string) => inspectQuarantine(file) }
      : {}),
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
    case "ready":
      if (stopped) return { state: "disabled" };
      if (platform === "win32") return applyWindows(result, log);
      return applyMac(result, log);
  }
}

type Ready = Extract<UpdateCheck, { state: "ready" }>;

function readyMessage(r: Ready): string {
  return `Psyche ${r.release} is ready; it installs when you quit${r.mandatory ? " (required)" : ""}`;
}

async function applyMac(result: Ready, log: (m: string) => void): Promise<RunResult> {
  const served = await serveVerifiedUpdate(result.file, result.release);
  servers.push(served);
  autoUpdater.on("error", (error) => {
    log(error.message);
    void served.close();
  });
  autoUpdater.on("update-downloaded", () => {
    log(readyMessage(result));
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

/**
 * Squirrel.Windows reads the local feed folder: nothing on the network after verification. A delta
 * that fails to apply is retried once with the full package, verified the same way.
 */
function applyWindows(result: Ready, log: (m: string) => void): RunResult {
  const feedDir = result.feedDir;
  if (!feedDir) return { state: "refused", code: "no_artifact", reason: "no Windows feed" };
  let retried = false;
  autoUpdater.on("error", (error) => {
    log(error.message);
    if (retried || !result.full) return;
    retried = true;
    void switchToFullPackage({ fetch, log }, { feedDir, full: result.full })
      .then((dir) => {
        autoUpdater.setFeedURL({ url: dir });
        autoUpdater.checkForUpdates();
      })
      .catch((err: unknown) => log(err instanceof Error ? err.message : String(err)));
  });
  autoUpdater.on("update-downloaded", () => log(readyMessage(result)));
  autoUpdater.setFeedURL({ url: feedDir });
  autoUpdater.checkForUpdates();
  return { state: "started", release: result.release };
}
